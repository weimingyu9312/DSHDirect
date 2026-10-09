# Troubleshooting

Symptom → cause → fix. Start with the diagnostics that name their own answers.

---

## `mcp-direct list` says the SDK cannot be located

```
错误: could not locate the @modelcontextprotocol/client package.
  Tried:
    C:\...\resources\app\node_modules\@modelcontextprotocol\client
    ...
```

The error already lists every path probed. `dsh-mcp-direct` does **not** vendor the
SDK: it uses the copy inside the DSH Desktop application.

**Check, in order:**

1. Is DSH Desktop actually installed? The SDK lives at
   `<install>\resources\app\node_modules\@modelcontextprotocol\client`.
2. Is the install in a non-standard location? Point at it explicitly:

   ```powershell
   $env:MCPD_SDK_DIR = 'D:\somewhere\DSH Desktop\resources\app\node_modules\@modelcontextprotocol\client'
   mcp-direct list
   ```

   `MCPD_SDK_DIR` must point at the **package directory** (the one containing `dist/`),
   not at the app root. An invalid value is reported as an error rather than silently
   falling back, so a typo is visible.
3. Still failing? Install the SDK next to the CLI (`npm i @modelcontextprotocol/client`)
   and it will be found by normal Node resolution as a last resort.

---

## A server shows `FAILED: connect timed out`

The MCP server is not answering, or is not on the address you registered.

**Check the port first.** On Windows, `Get-NetTCPConnection` can silently return
nothing when it lacks the privilege to enumerate, which looks exactly like "nothing is
listening". Use `netstat` instead:

```powershell
netstat -ano | Select-String ':3100'
```

A listening line confirms the process is there; the trailing number is its PID.

Then confirm the endpoint path. Many servers distinguish `/mcp` from `/stream` from
`/sse`, and registering the wrong one yields a bare timeout rather than a clear error.

Raise the timeout for a slow server:

```powershell
mcp-direct list --home <dir>       # 8 s default
```

or set `probeTimeoutMs` in the plugin config.

---

## The plugin logs an error but the host keeps running

That is deliberate — the plugin is optional, so a bad path surfaces as an actionable
message instead of a dead host. Read the message: it names the missing file.

```
dsh-mcp-direct: shared core not found at <toolDir>\lib\core.js
```

The plugin loads the shared core from the CLI package. Either install the CLI at the
expected location, or set `toolDir`:

```yaml
- insert:
    - id: mcp-direct
      name: dsh-mcp-direct
      config:
        toolDir: 'D:\your\path\to\packages\cli'
```

> Setting a `config:` value makes the patch row non-default, which the profile's
> `patchReload: live` will reconcile on every enable/disable. That is fine for a
> deliberate relocation, but do not add config merely to restate a default — see
> [architecture.md](architecture.md) for why that caused a reload loop.

---

## `spawn EPERM` / "MCP worker produced no result"

Two different causes, distinguished by context.

**Under a confined sandbox** (`EPERM`, errno `-4048`): the sandbox denies a child
process the ability to capture another child's piped stdio, and denies `spawn`
entirely for stdio transports. This is an environment limit, not a defect. HTTP
transport is unaffected and verifiable; the runner reports `SKIP` for the suite rather
than a false failure. The plugin's own host process is **not** sandboxed, so runtime
worker spawning is unaffected.

**Under Electron** ("MCP worker produced no result", a silent child): the host's
`process.execPath` is `DSH Desktop.exe`, and spawning that binary with a script path
does not run the script. Resolution tries `process.env.NODE`, then
`ELECTRON_RUN_AS_NODE=1`. If neither works, check that the app binary still exists at
the path the launcher recorded.

---

## A generated `<name>-mcp` command is not found

The launcher is written to `--bin-dir` (default: the mcp-direct home). That directory
must be on `PATH`. `add` warns when it is not:

```
提示：<dir> 不在 PATH 中，请把它加入 PATH 才能直接使用 <name>-mcp。
```

Add it to your user PATH and reopen the shell.

Note that the plugin writes launchers into **two levels up** from the tool directory
for the conventional `<bin>/tools/dsh-mcp-direct` layout — that is `<bin>`, the PATH
directory — not into `<bin>/tools`.

---

## The launcher fails on a machine with no `node`

It should not: the generated launcher prefers `node`, then falls back to running the
DSH Desktop binary with `ELECTRON_RUN_AS_NODE=1`, which makes Electron behave as plain
Node.

If it reports `exit /b 127`, neither was available — the app was not found at any
standard install location. Regenerate the launcher on that machine, or reinstall the
app.

---

## `参数不是合法 JSON` when the JSON looks correct

Windows shells rewrite quotes before the CLI sees them. The error quotes the **exact
bytes received** and their source, so compare that against what you typed.

Use `MCPD_ARGS` instead of command-line JSON — it bypasses quoting entirely:

```powershell
$env:MCPD_ARGS = '{"action":"is_ready"}'
cocos-mcp call cocos_scene
```

`MCPD_ARGS` also wins over stdin, so a stray pipe cannot corrupt the arguments.

---

## Adding a server fails with `连接失败`

`add` connects **before** persisting, so an unreachable server never enters the
registry. That is intentional: a registry full of dead entries makes the list view
useless.

Verify the endpoint reachable on its own first, then retry. Confirm the entry was not
written:

```powershell
Get-Content <home>\servers.json
```

---

## The GUI panel shows nothing

1. **Restart DSH Desktop.** Bundles load only at boot; installing a plugin has no
   effect until then.
2. **Confirm it loaded.** The host log is at
   `%APPDATA%\DSH Desktop\logs\host\dsh-<date>.log`; look for a `dsh-mcp-direct:` info
   line followed by the bridge route registration.
3. **Open the right page.** It is under **Settings → Plugins → dsh-mcp-direct → row
   config**, not a top-level navigation entry.
4. **Check for an early return.** If the log holds an error and no info line, the
   plugin found no `lib/core.js` and returned before registering any route — see the
   `toolDir` section above.

---

## Removing a server leaves files behind

`remove` reports every step. A file that could not be deleted is listed as a failure
rather than hidden:

```
已移除 echo 及其命令/技能
  - <home>\echo-mcp.cmd
  ! <home>\echo-mcp\SKILL.md: EPERM: operation not permitted
```

A locked file usually means an editor or shell holds it. Close it and delete manually.

A skill directory containing files you added yourself is deliberately **not** removed,
and is not reported as an error — the plugin will not delete user data.

---

## The host still OOMs

Then something is loading the SDK into the host process. Verify with the built-in
diagnostic, which asks the worker rather than resolving in-process precisely because
resolving would be the thing that breaks:

```powershell
# In the GUI, or:
mcp-direct probe <name> --json
```

Also check that `@deepseek-ai/dsh-mcp-client` is **not** enabled in your DSH profile.
That is the component this project exists to replace; running both reintroduces the
registration path.
