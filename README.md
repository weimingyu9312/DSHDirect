# DSHDirect

> 把原本独立的 MCP 直连管理器 `dsh-mcp-direct` 封装成 DSH 持久化插件，并在 Web GUI 内提供 MCP 服务器管理界面。绕开 DSH 自带的 `@deepseek-ai/dsh-mcp-client` 导致的 Desktop 宿主 V8 OOM 崩溃。

**Also available in [中文 (README.zh-CN.md)](README.zh-CN.md).**

# dsh-mcp-direct

**A direct MCP client and manager for DeepSeek Harness that never registers a model tool.**

MCP connections run entirely in short-lived child processes, so the host's resident
cost for MCP support is **zero** — which is the whole point, because the built-in
`@deepseek-ai/dsh-mcp-client` registers every MCP tool into `ctx.tools` and, on a
host already near its V8 heap ceiling, that registration is what tips it into OOM.

- **CLI** — `mcp-direct add <name> <url>` registers a server in one line and generates
  a global `<name>-mcp` command plus a skill that teaches the model to use it.
- **Plugin** — a management UI inside the Web GUI: list, probe, inspect schemas,
  call tools, add and remove servers.

Both surfaces share one `lib/core.js` and one `servers.json`, so **the CLI and the
GUI cannot drift**.

---

## Why this exists

The failure is not vague. It is one specific allocation:

1. The host is an Electron process with a V8 heap capped near **4 GB**, already
   climbing close to it under normal use.
2. `dsh-mcp-client` connects a server and then registers **every tool into
   `ctx.tools`**.
3. That path loads `@modelcontextprotocol/client` into the **host process** — about
   **27 MB of resident memory that GC does not reclaim**, because it is a module
   graph rather than transient garbage.
4. So "open the MCP manager page" becomes the final allocation before the heap
   gives out:

```
OOM error in V8: MarkCompactCollector ... 3938.9 (4074.0) MB
```

The blast radius is concrete too: `POST /list` is the first place the host
`require()`s the SDK. Everything is healthy until that request, and then the
process is gone — taking the session and every live page connection with it.

### The core invariant

```
never register any MCP tool into the host tool runtime — not one.
```

That is a design precondition, not an optimization. To hold it, all MCP work is
pushed out of the host:

```
GUI (client.js)
  │  fetch POST (loopback only)
  ▼
Host bridge (index.js)          → registry IO and process management only; never requires the SDK
  │  spawn
  ▼
mcp-worker.js                   → short-lived child; does the work, prints one JSON line, exits
  │  require
  ▼
@modelcontextprotocol/client    → the official SDK, process-isolated
```

So the host's MCP-related resident memory is **0**, and a hung or crashing MCP
server can only kill a child.

---

## What it fixes

| # | Problem | With a conventional MCP bridge | With dsh-mcp-direct |
|---|---|---|---|
| 1 | **Host OOM crash** | Opening the MCP page kills the process; session and page connections are lost | The SDK loads only in a child; host resident cost is zero |
| 2 | **One hung server stalls everything** | A server that stops responding freezes the host | Child process per operation with a hard timeout (20 s default), killed on expiry |
| 3 | **Tool count pollutes context** | N servers × M tools all injected into the model's tool table, bloating every turn | Zero tools registered; the model calls the `<name>-mcp` command on demand |
| 4 | **CLI and GUI disagree** | Each keeps its own config; a server added by CLI is invisible in the UI | Single `servers.json` source of truth, shared `lib/core.js` |
| 5 | **No UI** | Adding a server means hand-editing JSON and guessing tool names and arguments | Full GUI: list, probe, schema browser, call panel, add/remove |
| 6 | **Unknowable failures** | A bare `MODULE_NOT_FOUND` or a silent no-op | Failures list **every path tried**; the list view shows per-server tool count, latency, and the raw error |
| 7 | **Hardcoded SDK path** | A stale leftover app copy gets picked up instead of the running install | Four-stage probe, with the *running* interpreter first |
| 8 | **The model doesn't know the route** | It keeps reaching for the OOM-crashing client | `add` generates a skill that states plainly: do not use MCP tools, use this command |

### On point 3: this is a trade, not a gap

The native DSH approach turns MCP tools into model tools so the model can call them
directly. This project **deliberately gives that up** in exchange for a **CLI gateway
plus a skill**:

- The model sees "there is a `cocos` MCP server; drive it with `cocos-mcp`" —
  **not** 22 tool definitions.
- When it needs an argument shape it runs `cocos-mcp schema <tool>` and gets the
  `inputSchema`, then calls.
- The cost is one extra schema lookup. The payoff is a host that does not die and a
  context that is not flooded with tool tables.

**Against a 4 GB heap ceiling, that trade is the only version that stays up.**

---

## Repository layout

```
.
├─ packages/
│  ├─ cli/                    standalone CLI (the shared core lives here)
│  │  ├─ mcp-direct.js        command entry point
│  │  ├─ package.json
│  │  └─ lib/
│  │     ├─ core.js           SDK resolution, registry, connect, artifacts — shared
│  │     └─ mcp-worker.js     one MCP operation per process
│  └─ plugin/                 DSH Desktop plugin bundle
│     ├─ package.json         manifest (bundle patch + dsh.client)
│     ├─ cordis.patch.yml     inserts the id=mcp-direct plugin row
│     ├─ index.js             host half: bridge routes + admission guard
│     ├─ client.js            client half: the management UI
│     └─ icon.svg
├─ tests/
│  ├─ run.js                  suite runner
│  ├─ unit/core.test.js       pure helpers — no network, no SDK
│  ├─ e2e/cli.test.js         the real CLI against a real stdio MCP server
│  └─ fixtures/echo-server.js a dependency-free MCP server for the tests
├─ docs/
│  ├─ architecture.md         design decisions and their evidence
│  └─ troubleshooting.md      what to check when something does not connect
├─ LICENSE
└─ README.md
```

The plugin loads `lib/core.js` from the CLI package, which is what keeps one
implementation behind both surfaces.

---

## Install

### Requirements

- Windows (the generated launchers are `.cmd`; the Node code is portable)
- Node.js 18+ **or** a DSH Desktop install (the launcher falls back to running the
  Desktop binary as plain Node via `ELECTRON_RUN_AS_NODE=1`)
- The `@modelcontextprotocol/client` SDK, which ships **inside the DSH Desktop app**
  and is resolved at runtime — it is not vendored here

### 1. CLI only

```powershell
git clone https://github.com/weimingyu9312/DSHDirect.git
cd DSHDirect\packages\cli
node mcp-direct.js list
```

To get global `<name>-mcp` commands, put the CLI directory on your `PATH`. Then:

```powershell
node mcp-direct.js add cocos http://127.0.0.1:3100/mcp
cocos-mcp tools
```

### 2. Install the plugin

The plugin needs the CLI package present, because it loads the shared `lib/core.js`
from it. The conventional layout is:

```
<bin>/                     ← on your PATH
├─ tools/dsh-mcp-direct/   ← packages/cli contents go here
│  ├─ mcp-direct.js
│  └─ lib/
└─ <name>-mcp.cmd          ← generated launchers land here
```

Then install the bundle into your DSH profile:

```powershell
dsh plugin --profile desktop add <path-to-repo>\packages\plugin
```

The plugin's patch row is intentionally **config-free**. Every path is detected:

| Path | Default |
|---|---|
| `toolDir` | `MCPD_HOME`, else `~/.dsh/tools/dsh-mcp-direct`, else first PATH entry containing `tools/dsh-mcp-direct` |
| `registryPath` | `<toolDir>/servers.json` |
| `binDir` | `MCPD_HOME`, else the PATH directory for a `tools/dsh-mcp-direct` layout, else `toolDir` |
| `skillsDir` | `%USERPROFILE%\.dsh\skills` |
| `probeTimeoutMs` | `8000` |

Override any of them under `config:` in `cordis.patch.yml` only if you relocate the
CLI. Leaving them unset keeps the row a pure `insert`, which matters because the
profile runs with `patchReload: live`: a config value that differs from the declared
default forces a reconcile on every enable/disable, and combined with the
`disabled: true` row the Plugin Manager writes, that produced a reload loop which
killed live page connections with `ECONNRESET`.

After installing, restart DSH Desktop — bundles load only at boot.

---

## CLI reference

```
mcp-direct list                          list registered servers (probes each)
mcp-direct add <name> <url> [--header K=V ...]
mcp-direct add-stdio <name> <command> [args...]
mcp-direct remove <name>
mcp-direct tools <name>                  list a server's tools
mcp-direct schema <name> <tool>          show a tool's inputSchema
mcp-direct call <name> <tool> <json>     call a tool (arg | MCPD_ARGS | stdin)
mcp-direct probe <name>                  reconnect and report tool count
```

Options: `--home <dir>`, `--bin-dir <dir>`, `--skills-dir <dir>`, `--json`,
`--help`, `--version`.

Environment:

| Variable | Purpose |
|---|---|
| `MCPD_HOME` | Registry and launcher directory |
| `MCPD_SERVER` | Set by generated launchers so the server name can be omitted |
| `MCPD_ARGS` | Tool arguments as JSON — the quoting-safe path on Windows |
| `MCPD_SDK_DIR` | Override the `@modelcontextprotocol/client` package directory |
| `MCPD_APP_ROOT` | Set by the plugin host for its worker child |

### Passing tool arguments

Command-line JSON is fragile on Windows: both `cmd` and PowerShell rewrite quotes
before the CLI sees them. Prefer `MCPD_ARGS`:

```powershell
$env:MCPD_ARGS = '{"action":"is_ready"}'
cocos-mcp call cocos_scene
```

If the JSON is malformed, the error quotes exactly what was received and which
source it came from, so a shell-quoting problem is obvious rather than mysterious.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | CLI error (bad name, unregistered server, connection failure, bad JSON) |
| 2 | The tool ran and reported `isError` |

---

## GUI

Under **Settings → Plugins → dsh-mcp-direct**:

1. **Server list** — name, transport, endpoint, tool count, probe status, latency
2. **Test connection** — probe one server on demand without blocking the table
3. **Tool details** — tool list plus an `inputSchema` argument table with enum values
4. **Call panel** — pre-fills required arguments from the schema, then runs and shows the result
5. **Add server** — validated identically to the CLI (`^[a-z0-9][a-z0-9-]*$`, `http(s)://`)
6. **Remove** — confirms, then clears the registry entry and generated artifacts

Styling uses only `--dsw-alias-*` theme tokens, so it follows light/dark
automatically, and no `@deepseek-ai/dsh-client-ui-*` package is imported.

---

## Security boundary

The bridge can write a file on disk and spawn processes, so request admission is the
only authorization boundary. Every request must be a same-origin loopback POST:

- source address is `127.0.0.1`, `::1`, or `::ffff:127.0.0.1`
- the `Host` header resolves to loopback
- `Sec-Fetch-Site` is not `cross-site`
- when `Origin` is present it is same-origin with `Host`
- method is `POST` (a `GET` is answered `405`)
- body is at most 64 KiB

Above that, the browser-facing layer applies its own host trust (a process-token
cookie), so any unauthenticated `/api/*` is `403` before reaching this plugin.

Server **header and env values are never sent to the GUI** — only their key names.

---

## Testing

```powershell
node tests/run.js          # both suites
node tests/run.js unit     # pure helpers only, no child processes
node tests/run.js e2e      # end-to-end CLI against a real stdio MCP server
```

The e2e suite spawns the real CLI against `tests/fixtures/echo-server.js`, a
dependency-free MCP server, in a throwaway `MCPD_HOME`.

> **Sandbox note.** Under a confined Windows sandbox, a child process cannot capture
> its own child's piped stdio (`spawn EPERM`). The runner detects this, reports
> `SKIP` for the e2e suite rather than a false failure, and the unit suite still
> runs. Re-run outside the sandbox for the full result.

---

## Known limitations

- **stdio transfer cannot be exercised under a confined sandbox** — Node's piped
  stdio is denied there (`spawn EPERM`). HTTP is unaffected and verified end to end;
  the host process is not sandboxed, so the plugin's stdio support works at runtime.
- MCP `resources` and `prompts` are not read.
- MCP prompt templates are not implemented.
- Generated launchers are Windows `.cmd` files. The Node code is cross-platform, but
  the launcher layer would need a `.sh` equivalent elsewhere.

---

## License

MIT — see [LICENSE](LICENSE).
