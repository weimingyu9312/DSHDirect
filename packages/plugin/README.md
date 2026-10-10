# dsh-mcp-direct (plugin)

> An MCP manager that **registers zero model tools**. Every MCP connection runs in a
> separate child process, so the host's resident MCP footprint is **0**.

This is the plugin half of [dsh-mcp-direct](../..). For the CLI and the full
rationale, see the [root README](../../README.md); this document covers the plugin's
own architecture, API, and operating notes.

---

## What it solves

DSH's built-in `@deepseek-ai/dsh-mcp-client` takes the Desktop host process down with
an OOM on this class of machine. This plugin keeps MCP usable while **never touching
the host tool runtime**.

### The exact causal chain

Not "it feels like it crashes" — it is one identifiable allocation:

1. The host is an Electron process with a V8 heap capped near **4 GB**, already
   climbing close to that under normal use.
2. `dsh-mcp-client` works by connecting a server and then registering **every tool
   into `ctx.tools`**.
3. That path loads `@modelcontextprotocol/client` into the **host process**: about
   **27 MB resident that GC cannot reclaim**, because it is a module graph rather
   than transient garbage.
4. So "**open the MCP manager page**" becomes the final allocation before the heap
   gives out:

```
OOM error in V8: MarkCompactCollector ... 3938.9 (4074.0) MB
```

The crash point is precise: the **`POST /list` handler** — the first place on the
whole path where the host `require()`s the MCP SDK. Everything is healthy until that
request, and then the process is dead.

### The core invariant

```
never register any MCP tool into the host tool runtime — not one.
```

This is a design precondition, not an optimization. Holding it means pushing all MCP
work out of the host:

```
GUI (client.js)
  │  fetch POST (loopback only)
  ▼
Host bridge (index.js)          → registry IO and process management only; never requires the SDK
  │  spawn
  ▼
mcp-worker.js                   → short-lived child; does the work and exits
  │  require
  ▼
@modelcontextprotocol/client    → the official SDK, process-isolated
```

So the host's MCP resident memory is **0**, and a hung or crashing MCP server can at
worst kill a child.

---

## Pain points addressed

| # | Pain point | Conventional MCP bridge | This plugin |
|---|---|---|---|
| 1 | **Host OOM** | Opening the MCP page crashes it; session and page connections are all lost | SDK loads only in a child; host resident cost is zero |
| 2 | **One hung server stalls the host** | A server that stops responding freezes the host | Child per operation with a hard timeout (20 s default), killed on expiry |
| 3 | **Tool count pollutes context** | N servers × M tools all land in the model's tool table, bloating every turn | Zero tools registered; the model uses `<name>-mcp` on demand |
| 4 | **CLI and GUI fight** | Separate configs; a CLI-added server is invisible in the UI | One `servers.json`, shared `lib/core.js` — drift is structurally impossible |
| 5 | **No UI** | Adding a server means hand-editing JSON and guessing tool names and arguments | GUI for list / probe / schema / call / add / remove |
| 6 | **Unknowable failures** | A bare `MODULE_NOT_FOUND` or a silent no-op | Failures list **every path tried**; per-server tool count, latency, raw error |
| 7 | **Hardcoded SDK path** | A stale leftover app copy gets used instead of the live install | Four-stage probe led by the running interpreter |
| 8 | **The model doesn't know the route** | It keeps reaching for the OOM-crashing client | `add` generates a skill that says plainly: don't use MCP tools, use the command |

### Point 3 is a deliberate trade

The native DSH approach exposes MCP tools as model tools. This plugin **gives that up**
in exchange for a **CLI gateway plus a skill**:

- The model sees "there is a `cocos` MCP server; drive it with `cocos-mcp`", not 22
  tool definitions.
- When it needs argument shapes it runs `cocos-mcp schema <tool>`, gets the
  `inputSchema`, and calls.
- Cost: one extra lookup. Payoff: a host that stays up, and a context that is not
  flooded with tool tables.

**Against a 4 GB heap ceiling, that trade is the only version that survives.**

---

## Host half API

Every route is `POST /api/dsh-mcp-direct/<op>` and answers
`{ok:true,value}` or `{ok:false,code,message}`.

| op | Purpose |
|---|---|
| `status` | Diagnostics: SDK path, registry state, effective paths |
| `list` | Server list with a live probe of each (tool count / latency / error) |
| `tools` | One server's tool list, including full `inputSchema` |
| `schema` | One tool's schema |
| `add` | Register a server (connect first, persist only on success) |
| `remove` | Remove a server and clean up its generated `.cmd` and skill |
| `call` | Call a tool and return the flattened content |

Error codes: `registry-unreadable`, `server-exists`, `server-missing`, `invalid-name`,
`invalid-url`, `invalid-command`, `connect-failed`, `tool-missing`, `invalid-args`,
`call-failed`, `rejected`, `handler-error`.

### Worker protocol

The host never loads the SDK. It spawns `lib/mcp-worker.js`, which:

```
stdin:  one JSON object { op, entry, tool?, args?, timeoutMs? }
stdout: exactly one JSON line { ok: true, value } | { ok: false, error }
```

Operations: `resolve-sdk`, `probe`, `probe-many`, `call`. Diagnostics go to stderr,
because stdout carries the result. Exit code is `0` for a completed request
(including a reported failure) and `1` only when the request could not be processed
at all.

`probe-many` exists so that N servers do not cost N process starts, each allocating a
fresh SDK module graph. Entries are probed sequentially, which keeps the child's peak
memory bounded regardless of server count.

---

## Security boundary

The bridge can write a file on disk and spawn processes, so request admission is the
only authorization boundary:

- source address must be loopback (`127.0.0.1` / `::1` / `::ffff:127.0.0.1`)
- the `Host` header must resolve to loopback
- `Sec-Fetch-Site` must not be `cross-site`
- when `Origin` is present it must be same-origin with `Host`
- `POST` only (a `GET` is answered `405`)
- body capped at 64 KiB

Above that, the browser-facing layer applies its own host trust (process-token
cookie), so any unauthenticated `/api/*` is `403` before it reaches this plugin.

**Server header and env values are never sent to the GUI** — only their key names.

---

## GUI

Under **Settings → Plugins → dsh-mcp-direct → row config**:

1. **Server list** — name, transport, endpoint, tool count, probe status (colour-coded), latency
2. **Test connection** — probe one server on demand without blocking the table
3. **Tool details** — tool list plus an `inputSchema` argument table with enum values and required markers
4. **Call panel** — pre-fills required arguments from the schema, runs, shows the result
5. **Add server** — both HTTP and stdio, validated identically to the host (`^[a-z0-9][a-z0-9-]*$`, `http(s)://`)
6. **Remove** — confirms, then clears the registry entry and generated artifacts
7. **Open skill directory** — each server row shows its generated `SKILL.md` directory (`<skillsDir>/<name>-mcp`) as a link that opens the platform file manager (explorer.exe on Windows). The path is derived host-side from the server name; the bridge never accepts a client-supplied path, and a missing skill directory is reported rather than opened.

Styling uses theme tokens only, and no `@deepseek-ai/dsh-client-ui-*` package is
imported — the client resolves only the frozen platform table (`react`,
`react/jsx-runtime`), so a renamed token degrades looks but never breaks rendering.

---

## Configuration

The `cordis.patch.yml` row is **deliberately config-free**.

The profile runs with `patchReload: live`. A config value that differs from the
bundle's declared default forces the entry to be updated and reconciled on every
enable/disable; combined with the `disabled: true` row the Plugin Manager writes into
the profile's own patch, that produced a **reconcile loop** — the host reloaded
repeatedly and live page connections died with `ECONNRESET`, which surfaced as a
frozen conversation. Keeping the row a pure `insert` makes that oscillation
impossible.

Every path is detected in `index.js` instead:

| Field | Default | Notes |
|---|---|---|
| `toolDir` | detected | Holds `mcp-direct.js` and `lib/core.js`. Probes `MCPD_HOME` → `~/.dsh/tools/dsh-mcp-direct` → PATH entries containing `tools/dsh-mcp-direct` |
| `registryPath` | `<toolDir>/servers.json` | Shared with the CLI |
| `binDir` | `MCPD_HOME`, else the PATH directory for a `tools/dsh-mcp-direct` layout, else `toolDir` | Receives generated `<name>-mcp.cmd` |
| `skillsDir` | `%USERPROFILE%\.dsh\skills` | Receives generated skills |
| `probeTimeoutMs` | `8000` | Per-server probe timeout |

Set any of these under `config:` **only if you relocate the CLI**.

---

## Design decisions

| Question | Decision | Evidence |
|---|---|---|
| MCP SDK source | Reuse `@modelcontextprotocol/client` 2.0.0 from inside the DSH app; **no new dependency** | That package is already a real dependency of `dsh-mcp-client` |
| How the client reaches the host | **Loopback HTTP bridge** (`ctx.webServer.register`) | A static bundle cannot create its own `ctx.remote.*` |
| Why not the `settings` service | On this host `settings` has **no `register()`** and does not serve third-party namespaces | Recorded in `dshmarket/src/settings.ts` |
| Config persistence | Still `servers.json`, not settings | Keeps CLI compatibility and avoids two writers |
| UI mount point | `plugins.row.config` | An established pattern |
| Register model tools? | **No. Not one.** | This is the invariant that avoids the OOM |
| Worker lifetime | **One process per operation**, not long-lived | Host holds zero state; ~250 ms startup is irrelevant for a management UI |
| Starting node under Electron | `process.env.NODE` → `ELECTRON_RUN_AS_NODE=1` | The host's `execPath` is `DSH Desktop.exe`; running a script with it silently produces a child with no output |

---

## Testing

```powershell
node tests/run.js          # from the repository root
```

The plugin's host half is covered by the unit suite (registry IO, artifact
generation, admission rules) plus the end-to-end CLI suite, which exercises the same
shared `lib/core.js` the plugin calls.

> **Sandbox note.** Under a confined Windows sandbox a child cannot capture its own
> child's piped stdio (`spawn EPERM`). The runner reports `SKIP` for that suite rather
> than a false failure. The host process itself is not sandboxed, so spawning the
> worker at runtime is unaffected.

---

## Limitations

- MCP `resources` and `prompts` are not read.
- Prompt templates are not implemented.
- No session state across calls: each invocation opens a fresh connection.
- Tool calls are single atomic operations; there is no streaming output.
- Generated launchers are Windows `.cmd` files.

---

## Deploying

```powershell
dsh plugin --profile desktop add <path-to-repo>\packages\plugin
```

The plugin loads the shared `lib/core.js` from the CLI package, so keep the CLI
present at the detected `toolDir`. After changing either half:

```powershell
Copy-Item <repo>\packages\cli\lib\core.js   <toolDir>\lib\core.js   -Force
Copy-Item <repo>\packages\cli\mcp-direct.js <toolDir>\mcp-direct.js -Force
```

> **Bundles load only at boot.** Restart DSH Desktop after installing or changing the
> plugin. Load logs are in `%APPDATA%\DSH Desktop\logs\host\dsh-<date>.log`.

---

## Choosing this or something else

**Use this plugin when:**

- loading MCP tools OOM-crashes the host
- the heap is tight and cannot afford a 27 MB resident module graph
- there are many or heavy MCP servers and the tool table must not pollute context
- MCP servers are unstable and a hung one must not take the session down
- the CLI and GUI must share one configuration

**Otherwise:**

- plenty of memory, few servers, native model tool calls wanted → use the official
  `dsh-mcp-client`; it is smoother
- `resources` / `prompts` / streaming / long-lived sessions needed → not covered here
- command line only, no UI wanted → use the `mcp-direct` CLI without the plugin

---

**License:** MIT
