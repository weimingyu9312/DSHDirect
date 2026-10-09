# Architecture

Why this project is shaped the way it is, and what each decision rests on.

---

## The problem being solved

DSH's built-in `@deepseek-ai/dsh-mcp-client` registers every MCP tool into
`ctx.tools`. That path loads the MCP SDK into the Electron host process, where it
costs roughly 27 MB of resident memory that GC never reclaims — it is a module graph,
not transient garbage. On a host whose V8 heap is capped near 4 GB and already climbs
close to that under normal use, the *first* MCP operation becomes the final
allocation before OOM:

```
OOM error in V8: MarkCompactCollector ... 3938.9 (4074.0) MB
```

The crash is localized: the `POST /list` handler, which is the first place on the
path that requires the SDK.

## The invariant

```
never register any MCP tool into the host tool runtime.
```

Everything below follows from holding that line.

---

## Process topology

```
GUI (client.js)
  │  fetch POST (loopback only)
  ▼
Host bridge (index.js)          → registry IO + process management; never requires the SDK
  │  spawn
  ▼
mcp-worker.js                   → short-lived child: connect, act, print one JSON line, exit
  │  require
  ▼
@modelcontextprotocol/client    → official SDK, process-isolated
```

Three properties fall out of this:

1. **Host MCP memory is zero** — the SDK never enters the host process.
2. **A hung server cannot hang the host** — the child is killed on a hard timeout.
3. **A crashing server cannot crash the host** — it takes down a child.

### Why one process per operation

A long-lived worker would reintroduce exactly the state this design exists to avoid: a
live socket, a resident module graph, and a handle to leak. Spawning per operation
costs about 250 ms — irrelevant for a management UI — and buys a host that holds no
MCP state at all.

The one concession is `probe-many`: listing N servers through N process starts would
allocate a fresh SDK module graph N times, so the list view batches them into a single
child that probes sequentially. Sequential (not parallel) probing keeps that child's
peak memory bounded no matter how many servers are registered.

---

## The shared core

`packages/cli/lib/core.js` is loaded by **both** the CLI and the plugin's host half.

This is the single most consequential structural choice: it makes CLI/GUI drift
impossible rather than merely unlikely. Registry shape, transport handling, name
validation, and artifact generation have exactly one implementation.

The plugin reaches `core.js` via the detected `toolDir`. Because the host only ever
calls *pure* helpers (registry IO, validation, artifact writing), and the SDK is
required lazily inside `connect()` — a function the host never calls — loading
`core.js` does not pull the SDK into the host. That property is load-bearing: it is
what lets the shared-core design coexist with the zero-residency invariant.

---

## Node resolution under Electron

The host's `process.execPath` is `DSH Desktop.exe`, not `node`. Spawning that binary
with a script path does **not** run the script — it produces a silent child with no
stdout, which surfaced in the GUI as "MCP worker produced no result".

Two supported ways to reach the Node runtime inside Electron, in order:

1. `process.env.NODE` — the node binary Electron was launched with.
2. `ELECTRON_RUN_AS_NODE=1` in the child's environment — makes the Electron binary
   itself behave as plain Node. This is the reliable fallback because it needs no
   external Node installation at all.

The host also forwards `MCPD_APP_ROOT`, because inside the worker `process.execPath`
is Node and the Electron-installation probing no longer applies — while the host
already knows exactly where the app is.

The **generated launchers** use the same trick, so a Desktop-only machine with no
standalone `node` on PATH can still run the CLI. The launcher prefers `node`, then
falls back to the app binary with `ELECTRON_RUN_AS_NODE=1`. The fallback branch is
emitted only when an executable was actually located, so a broken path is never
written into a launcher.

---

## SDK resolution

The original script hardcoded `D:\soft\ai\dsh\desktop\DSH Desktop\...`, which pointed
at a stale leftover copy of the app while the live install was elsewhere. Resolution
is now a four-stage probe, most trustworthy first:

1. `MCPD_SDK_DIR` — explicit override; an invalid value is an error, not a fallback.
2. Walk up from `process.execPath` — when the host loads this module, that is the
   Electron binary in the live app, so this finds the SDK *this very process* uses.
3. Known install locations derived from the environment (`LOCALAPPDATA\Programs`,
   `PROGRAMFILES`, `PROGRAMFILES(X86)`) — never hardcoded absolute paths.
4. Standard Node resolution from plausible roots.

Failure lists **every path tried**, rather than surfacing a bare `MODULE_NOT_FOUND`.

---

## Configuration persistence

`servers.json` remains the source of truth rather than the `settings` service.

- On this host `settings` has **no `register()`** and does not serve third-party
  namespaces.
- Using it would break CLI compatibility and create two writers for one fact.

`MCPD_HOME` redirects the registry and launcher directory, which lets one installation
drive several registries without a second code path. Note that paths are resolved
*lazily* — `defaultRegistryPath()` is a function, not a constant — so the env var is
honored whether it is set before startup or by an argument parser.

---

## The config-free patch row

`cordis.patch.yml` deliberately carries no `config:`.

The profile runs with `patchReload: live`. A config value that differs from the
bundle's declared default forces the entry to be updated and reconciled on every
enable/disable. Combined with the `disabled: true` row the Plugin Manager writes into
the profile's own patch, that produced a **reconcile loop**: the host reloaded
repeatedly and live page connections died with `ECONNRESET`, which the user saw as a
frozen conversation.

Keeping the row a pure `insert` makes oscillation impossible. All paths are therefore
detected in `index.js`, with the `defaultBinDir()` helper specifically encoding the
`<bin>/tools/dsh-mcp-direct` convention so a conventional install still writes
launchers into the PATH directory rather than into `<bin>/tools`.

---

## Admission control

The bridge mutates a file on disk and spawns processes, so request admission is the
only authorization boundary — there is no other place to enforce anything.

A request is admitted only when all hold: loopback source address, loopback `Host`,
`Sec-Fetch-Site` not `cross-site`, `Origin` (when present) same-origin, method `POST`,
and body ≤ 64 KiB.

Above this, the browser-facing layer applies host trust via a process-token cookie, so
unauthenticated `/api/*` is rejected before reaching the plugin.

Since the bridge is reachable from any page the GUI loads, the guard also keeps
**header and env values** out of responses — the GUI receives key names only.

---

## Artifact generation

`add` produces two artifacts:

- a global `<name>-mcp.cmd` launcher
- a `~/.dsh/skills/<name>-mcp/SKILL.md` skill

The skill is not decoration. It is the control that keeps the model off the
OOM-crashing path, which is why it is regenerated from the live tool list on every
add and why it states the rule explicitly: *do not use MCP tools for this server, use
the command.*

Both artifacts are written as **UTF-8 without a BOM**. A BOM makes `JSON.parse` fail
in most consumers, and PowerShell's `Set-Content -Encoding UTF8` emits one, which is a
documented hazard on this platform. The worker additionally tolerates a BOM on its
stdin, because a caller may produce that request with exactly such a tool.

Artifact writes are best-effort and reported: a locked `.cmd` must not lose the
registry entry, and a skill directory holding user files is never force-deleted.

---

## Failure reporting

Every user-visible failure names its cause:

| Surface | Behavior |
|---|---|
| SDK resolution | Lists every path tried |
| Server list | Per-server tool count, latency, and raw error; a worker-level failure is reported per server rather than failing the whole list |
| Add | Persist-last: an unreachable server never enters the registry |
| Call | Distinguishes a tool-level `isError` (exit code 2) from a CLI failure (exit 1) |
| Arguments | Quotes the received input and names its source, because on Windows the usual cause is the shell rewriting quotes |
| Host handler | A handler crash is caught and reported as `handler-error` rather than killing the route |
