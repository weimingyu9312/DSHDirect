#!/usr/bin/env node
/*
 * mcp-direct core — shared MCP direct-client logic.
 *
 * Used by BOTH the standalone CLI (tools/dsh-mcp-direct/mcp-direct.js) and the
 * DSH plugin host half (dsh-mcp-direct-plugin/index.js), so the two surfaces can
 * never drift on transport handling, registry shape, or naming rules.
 *
 * Why a direct client exists at all: DSH's shipped @deepseek-ai/dsh-mcp-client
 * registers every MCP tool into ctx.tools, which OOM-crashes the Desktop host on
 * this machine. This module deliberately keeps every MCP connection OUT of the
 * host tool runtime — it runs the official SDK in its own process and returns
 * plain JSON. Nothing here calls ctx.tools.register().
 *
 * Supports both streamable-http and stdio transports.
 *
 * The SDK (@modelcontextprotocol/client 2.0.0) is NOT vendored: it ships inside
 * the DSH Desktop application, so we resolve it at runtime. The old hardcoded
 * path pointed at a stale leftover copy of the app; resolveSdk() now probes the
 * live installation first and reports every path it tried when it fails.
 */
'use strict';

const fs = require('fs');
const path = require('path');

/** Registry schema version written by this module. v1 files are read as-is. */
const REGISTRY_VERSION = 2;

/** Default per-call timeout for connect + tool listing, in milliseconds. */
const DEFAULT_PROBE_TIMEOUT_MS = 8000;

/** Bounded tool-description length used when generating skill text. */
const SKILL_DESC_LIMIT = 100;

/* ------------------------------------------------------------------ *
 * SDK resolution
 * ------------------------------------------------------------------ */

/** Environment override: absolute path to an @modelcontextprotocol/client package dir. */
const SDK_ENV_VAR = 'MCPD_SDK_DIR';

/**
 * Candidate application roots, most trustworthy first.
 *
 * `process.execPath` is the running interpreter. When this module is loaded by
 * the DSH Desktop host, execPath is the Electron binary inside the live app, so
 * walking up from it finds the SDK that this very process is using — that beats
 * any hardcoded guess.
 */
function candidateAppRoots() {
    const roots = [];
    // Set by the plugin Host when it spawns this module in a worker: inside a
    // plain-node worker `process.execPath` is node, so the Electron-walk below
    // cannot find the app, while the Host already knows exactly where it is.
    if (process.env.MCPD_APP_ROOT) roots.push(process.env.MCPD_APP_ROOT);
    const execPath = process.execPath || '';
    // <app>/DSH Desktop.exe -> <app> ; <app>/resources/app.asar/... -> walk up.
    for (let dir = path.dirname(execPath), i = 0; i < 6 && dir; i += 1) {
        roots.push(path.join(dir, 'resources', 'app'));
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    // Known default install locations, derived from the environment so a clone
    // works on a machine whose install path was never seen before.
    const local = process.env.LOCALAPPDATA;
    const programFiles = process.env.PROGRAMFILES;
    const programFilesX86 = process.env['PROGRAMFILES(X86)'];
    for (const base of [local && path.join(local, 'Programs'), programFiles, programFilesX86]) {
        if (!base) continue;
        for (const appName of ['DSH Desktop', 'dsh-desktop', 'DeepSeek Harness']) {
            roots.push(path.join(base, appName, 'resources', 'app'));
            // The app folder may also be the deployment root itself.
            roots.push(path.join(base, appName));
        }
    }
    // Explicit escape hatch for a non-standard install location.
    if (process.env.DSH_APP_ROOT) roots.push(process.env.DSH_APP_ROOT);
    return roots;
}

/** @returns {string[]} every directory probed for the SDK, for diagnostics. */
let lastSdkProbePaths = [];

/**
 * Locate the installed @modelcontextprotocol/client package directory.
 *
 * Resolution order: MCPD_SDK_DIR override, then application roots, then the
 * module search path. Every attempt is recorded so a failure can name the exact
 * paths it tried instead of surfacing a bare MODULE_NOT_FOUND.
 *
 * @returns {string} absolute path to the package directory (containing dist/).
 * @throws {Error} when no candidate holds a usable build.
 */
function resolveSdk() {
    const tried = [];
    lastSdkProbePaths = tried;

    const override = process.env[SDK_ENV_VAR];
    if (override) {
        const dist = path.join(override, 'dist', 'index.cjs');
        tried.push(override);
        if (fs.existsSync(dist)) return override;
        throw new Error(
            `${SDK_ENV_VAR} points at "${override}" but ${dist} does not exist`
        );
    }

    for (const root of candidateAppRoots()) {
        const pkg = path.join(root, 'node_modules', '@modelcontextprotocol', 'client');
        tried.push(pkg);
        if (fs.existsSync(path.join(pkg, 'dist', 'index.cjs'))) return pkg;
    }

    // Last resort: normal Node resolution from plausible working directories.
    try {
        return path.dirname(require.resolve('@modelcontextprotocol/client/package.json', {
            paths: [process.cwd(), __dirname],
        }));
    } catch (e) {
        tried.push('require.resolve(@modelcontextprotocol/client)');
    }

    throw new Error(
        'could not locate the @modelcontextprotocol/client package.\n' +
        '  Set ' + SDK_ENV_VAR + ' to the package directory, or install it next to this tool.\n' +
        '  Tried:\n' + tried.map((p) => '    ' + p).join('\n')
    );
}

/** Cached SDK directory; resolved once per process. */
let sdkDirCache = null;

/** @returns {string} cached SDK package directory. */
function sdkDir() {
    if (sdkDirCache === null) sdkDirCache = resolveSdk();
    return sdkDirCache;
}

/* ------------------------------------------------------------------ *
 * Registry
 * ------------------------------------------------------------------ */

/**
 * Environment override: directory holding the registry and generated launchers.
 *
 * Unset means "the directory this tool is installed in", which keeps a
 * plain checkout self-contained. Setting it lets one instal drive several
 * registries (for example per-project MCP sets).
 */
const HOME_ENV_VAR = 'MCPD_HOME';

/** The tool's own installation directory (`packages/cli` in a checkout). */
const TOOL_DIR = path.join(__dirname, '..');

/** @returns {string} the active mcp-direct home directory. */
function homeDir() {
    return process.env[HOME_ENV_VAR] || TOOL_DIR;
}

/** Default registry location for the standalone CLI (resolved live). */
function defaultRegistryPath() {
    return path.join(homeDir(), 'servers.json');
}

/**
 * Legacy constant kept for callers that imported it.
 * @deprecated prefer defaultRegistryPath(); this value ignores MCPD_HOME.
 */
const CLI_REGISTRY_PATH = path.join(TOOL_DIR, 'servers.json');

/**
 * @param {string} [registryPath] - path to servers.json; defaults to the CLI's.
 * @returns {{version?: number, servers: Record<string, object>}}
 */
function loadRegistry(registryPath) {
    const file = registryPath || defaultRegistryPath();
    if (!fs.existsSync(file)) return { version: REGISTRY_VERSION, servers: {} };
    const raw = fs.readFileSync(file, 'utf8');
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        const err = new Error(`registry at "${file}" is not valid JSON: ${e.message}`);
        err.code = 'registry-unreadable';
        throw err;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        const err = new Error(`registry at "${file}" is not a JSON object`);
        err.code = 'registry-unreadable';
        throw err;
    }
    if (parsed.servers === undefined) parsed.servers = {};
    if (parsed.servers === null || typeof parsed.servers !== 'object' || Array.isArray(parsed.servers)) {
        const err = new Error(`registry at "${file}" has a non-object "servers" field`);
        err.code = 'registry-unreadable';
        throw err;
    }
    // A v1 file (no version field) is read unchanged; version is stamped on write.
    return parsed;
}

/**
 * Persist the registry as UTF-8 WITHOUT a BOM.
 *
 * The user requires no-BOM UTF-8 for every code/config/JSON/YAML file; a BOM
 * makes JSON.parse fail in most consumers, so this is written explicitly.
 *
 * The serialized shape is deliberately IDENTICAL to the original CLI output
 * (`JSON.stringify(reg, null, 2)`, no trailing newline, no added keys) so that
 * existing installs and any external reader see a byte-stable file. The
 * `version` field is therefore recorded only when the caller set it explicitly
 * — migrateRegistry() does that on read, and unknown extra keys are preserved
 * by spreading rather than rebuilt.
 *
 * @param {object} reg - registry object to serialize.
 * @param {string} [registryPath] - destination; defaults to the CLI's.
 */
function saveRegistry(reg, registryPath) {
    const file = registryPath || defaultRegistryPath();
    const out = Object.assign({}, reg, { servers: reg.servers || {} });
    if (out.version === undefined) delete out.version;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // writeFileSync with 'utf8' emits no BOM (unlike PowerShell's UTF8 encoding).
    fs.writeFileSync(file, JSON.stringify(out, null, 2), { encoding: 'utf8' });
}

/**
 * Read the registry and normalise it to the current in-memory shape.
 *
 * A file without a `version` field is a v1 registry: it is accepted unchanged
 * and stamped as current in memory only, so upgrading never rewrites a working
 * file merely because it was opened.
 *
 * @param {string} [registryPath]
 * @returns {{version: number, servers: Record<string, object>, migratedFrom?: number}}
 */
function migrateRegistry(registryPath) {
    const reg = loadRegistry(registryPath);
    if (reg.version === undefined) {
        reg.version = REGISTRY_VERSION;
        reg.migratedFrom = 1;
    }
    return reg;
}

/**
 * Validate a server name.
 * @param {string} name
 * @returns {boolean} true when the name matches [a-z0-9][a-z0-9-]*.
 */
function nameOk(name) {
    return typeof name === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(name);
}

/**
 * Describe a registry entry's transport in one short phrase (list/skill text).
 * @param {object} entry
 * @returns {string}
 */
function describeTransport(entry) {
    if (entry.transport === 'stdio') return 'stdio';
    return entry.transport || 'streamable-http';
}

/**
 * Human-readable endpoint of an entry: URL, or command plus args.
 * @param {object} entry
 * @returns {string}
 */
function describeEndpoint(entry) {
    if (entry.transport === 'stdio') {
        return [entry.command, ...(entry.args || [])].filter(Boolean).join(' ');
    }
    return entry.url || '';
}

/* ------------------------------------------------------------------ *
 * Connection
 * ------------------------------------------------------------------ */

/**
 * Open a client connection to one MCP server.
 *
 * @param {object} entry - registry entry ({transport, url|command, headers|args|env}).
 * @param {object} [options]
 * @param {number} [options.timeoutMs] - connect timeout; 0 disables the race.
 * @returns {Promise<object>} connected MCP SDK client.
 */
async function connect(entry, options) {
    const opts = options || {};
    const base = sdkDir();
    const { Client } = require(path.join(base, 'dist', 'index.cjs'));

    let transport;
    if (entry.transport === 'stdio') {
        const { StdioClientTransport } = require(path.join(base, 'dist', 'stdio.cjs'));
        transport = new StdioClientTransport({
            command: entry.command,
            args: entry.args || [],
            env: entry.env || {},
        });
    } else {
        const { StreamableHTTPClientTransport } = require(path.join(base, 'dist', 'index.cjs'));
        const headers = {};
        for (const [k, v] of Object.entries(entry.headers || {})) headers[k] = v;
        transport = new StreamableHTTPClientTransport(new URL(entry.url), {
            requestInit: { headers },
        });
    }

    const client = new Client({ name: 'dsh-mcp-direct', version: '2.0.0' });
    const conn = client.connect(transport);

    const timeoutMs = opts.timeoutMs === undefined ? DEFAULT_PROBE_TIMEOUT_MS : opts.timeoutMs;
    if (timeoutMs > 0) {
        let timer;
        try {
            await Promise.race([
                conn,
                new Promise((_resolve, reject) => {
                    timer = setTimeout(
                        () => reject(new Error(`connect timed out after ${timeoutMs}ms`)),
                        timeoutMs
                    );
                }),
            ]);
        } catch (e) {
            // Never leave a half-open transport behind on a failed probe.
            try { await client.close(); } catch (_) { /* already failing */ }
            throw e;
        } finally {
            if (timer) clearTimeout(timer);
        }
    } else {
        await conn;
    }
    return client;
}

/**
 * List a connected server's tools.
 *
 * A server that declares no `tools` capability yields an empty list rather than
 * an error, matching the shipped bridge's behaviour.
 *
 * @param {object} client - connected MCP SDK client.
 * @returns {Promise<object[]>} tool definitions.
 */
async function listTools(client) {
    const caps = client.getServerCapabilities() || {};
    if (caps.tools === undefined) return [];
    const res = await client.listTools();
    return res.tools || [];
}

/**
 * Close a client, swallowing teardown errors (a probe must not fail on cleanup).
 * @param {object|undefined} client
 * @returns {Promise<void>}
 */
async function closeQuietly(client) {
    if (!client) return;
    try { await client.close(); } catch (e) { /* teardown is best-effort */ }
}

/**
 * Connect, list tools, and always disconnect.
 *
 * @param {object} entry - registry entry.
 * @param {object} [options] - passed through to connect().
 * @returns {Promise<{ok: boolean, tools: object[], error?: string, ms: number}>}
 */
async function probe(entry, options) {
    const startedAt = Date.now();
    let client;
    try {
        client = await connect(entry, options);
        const tools = await listTools(client);
        return { ok: true, tools, ms: Date.now() - startedAt };
    } catch (e) {
        return { ok: false, tools: [], error: errText(e), ms: Date.now() - startedAt };
    } finally {
        await closeQuietly(client);
    }
}

/**
 * Call one tool on a server.
 *
 * @param {object} entry - registry entry.
 * @param {string} tool - tool name.
 * @param {object} args - parsed JSON arguments.
 * @param {object} [options] - {timeoutMs}.
 * @returns {Promise<{ok: boolean, content: object[], isError: boolean, error?: string}>}
 */
async function callTool(entry, tool, args, options) {
    let client;
    try {
        client = await connect(entry, options);
        const res = await client.callTool({ name: tool, arguments: args || {} });
        return { ok: true, content: res.content || [], isError: res.isError === true };
    } catch (e) {
        return { ok: false, content: [], isError: true, error: errText(e) };
    } finally {
        await closeQuietly(client);
    }
}

/**
 * Flatten one tool result's content blocks into displayable text.
 *
 * MCP text blocks frequently carry a JSON string; those are pretty-printed so
 * callers see structure instead of an escaped one-liner. Non-text blocks are
 * reported by type rather than silently dropped.
 *
 * @param {object[]} content - MCP content blocks.
 * @returns {Array<{type: string, text: string}>}
 */
function flattenContent(content) {
    const out = [];
    for (const item of content || []) {
        if (item && item.type === 'text') {
            let text = item.text;
            try {
                text = JSON.stringify(JSON.parse(item.text), null, 2);
            } catch (e) { /* not JSON: keep the original text */ }
            out.push({ type: 'text', text });
        } else {
            out.push({ type: 'note', text: `[content type: ${item && item.type}]` });
        }
    }
    return out;
}

/* ------------------------------------------------------------------ *
 * Generated artifacts (global command + skill)
 * ------------------------------------------------------------------ */

/**
 * Default directory holding the generated global `<name>-mcp.cmd` launchers.
 *
 * Defaults to the mcp-direct home (the install directory), which is expected to
 * be on the user PATH. Pass `--bin-dir` to place them elsewhere.
 */
function defaultBinDir() {
    return homeDir();
}

/** Default directory holding generated per-server skills. */
function defaultSkillsDir() {
    const home = process.env.USERPROFILE || process.env.HOME;
    if (!home) throw new Error('cannot determine the home directory (set USERPROFILE or HOME)');
    return path.join(home, '.dsh', 'skills');
}

/**
 * Locate the DSH Desktop executable, if this machine has one.
 *
 * Used only as the launcher's fallback interpreter for a Desktop-only install
 * with no standalone `node`. Returns undefined when nothing is found, and the
 * generated launcher then falls back to a bare `node`.
 *
 * @returns {string | undefined} absolute path to the app executable.
 */
function findElectronExecutable() {
    // Running inside the app already: execPath IS the executable.
    if (process.versions.electron !== undefined && process.execPath) return process.execPath;

    const candidates = [];
    const base = process.env.LOCALAPPDATA;
    if (base) candidates.push(path.join(base, 'Programs', 'DSH Desktop', 'DSH Desktop.exe'));
    for (const dir of [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)']]) {
        if (dir) candidates.push(path.join(dir, 'DSH Desktop', 'DSH Desktop.exe'));
    }
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return candidate;
    }
    return undefined;
}

/**
 * Build the launcher body that starts the CLI.
 *
 * The launcher must run on a machine that has the DSH Desktop app but no
 * standalone `node` on PATH — the common case for a Desktop-only install. It
 * therefore prefers `node`, then falls back to re-executing the DSH Desktop
 * binary with ELECTRON_RUN_AS_NODE=1, which turns Electron into plain Node.
 *
 * The Electron branch is emitted only when an executable was actually found, so
 * a broken path is never generated. When none is found the launcher still tries
 * the plain `node` it was given.
 *
 * @param {string} name - server name exported as MCPD_SERVER.
 * @param {string} toolDir - directory holding mcp-direct.js.
 * @param {string} home - mcp-direct home directory exported as MCPD_HOME.
 * @param {string} [electronPath] - explicit app executable override.
 * @returns {string[]} launcher lines.
 */
function launcherLines(name, toolDir, home, electronPath) {
    const script = path.join(toolDir, 'mcp-direct.js');
    const electron = electronPath || findElectronExecutable();
    const lines = [
        '@echo off',
        'setlocal',
        `rem Generated by mcp-direct. Direct MCP client for server "${name}" (bypasses dsh-mcp-client / host OOM).`,
        `rem Usage: ${name}-mcp tools ^| schema ^<tool^> ^| call ^<tool^> ^<json^>`,
        `set "MCPD_SERVER=${name}"`,
        `set "MCPD_HOME=${home}"`,
        `set "MCPD_SCRIPT=${script}"`,
        'rem Prefer a real node; otherwise run the Electron app as plain node.',
        'where node >nul 2>nul',
        'if %ERRORLEVEL%==0 (',
        '  node "%MCPD_SCRIPT%" %*',
        '  exit /b %ERRORLEVEL%',
        ')',
    ];
    if (electron) {
        lines.push(
            `set "MCPD_ELECTRON=${electron}"`,
            'if not exist "%MCPD_ELECTRON%" (',
            '  echo mcp-direct: node not found and the DSH Desktop app is missing at "%MCPD_ELECTRON%". 1>&2',
            '  exit /b 127',
            ')',
            'set "ELECTRON_RUN_AS_NODE=1"',
            '"%MCPD_ELECTRON%" "%MCPD_SCRIPT%" %*',
            'exit /b %ERRORLEVEL%',
            '',
        );
    } else {
        lines.push(
            'echo mcp-direct: node is not on PATH and the DSH Desktop app was not found. 1>&2',
            'exit /b 127',
            '',
        );
    }
    return lines;
}

/**
 * Write the global "<name>-mcp.cmd" launcher for a server.
 *
 * The launcher sets MCPD_SERVER so the CLI can omit the server name, then
 * delegates to mcp-direct.js. Written as UTF-8 without BOM.
 *
 * @param {string} name - validated server name.
 * @param {object} paths - {binDir, toolDir, electronPath}.
 * @returns {string} the written path.
 */
function generateCommand(name, paths) {
    const opts = paths || {};
    const binDir = opts.binDir || defaultBinDir();
    const toolDir = opts.toolDir || TOOL_DIR;
    const cmd = path.join(binDir, `${name}-mcp.cmd`);
    const content = launcherLines(name, toolDir, homeDir(), opts.electronPath).join('\r\n');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(cmd, content, { encoding: 'utf8' });
    return cmd;
}

/**
 * Write the per-server skill so the model learns the direct-connection route.
 *
 * The generated text is the control that keeps the model OFF the OOM-crashing
 * dsh-mcp-client path, so it is regenerated from the live tool list on every
 * add. Probe failure is not fatal: the skill is still written, noting that the
 * tool list was unavailable.
 *
 * @param {string} name - validated server name.
 * @param {object} entry - registry entry.
 * @param {object} [options] - {skillsDir, timeoutMs, tools, probeError}.
 * @returns {Promise<string>} the written SKILL.md path.
 */
async function generateSkill(name, entry, options) {
    const opts = options || {};
    const skillsDir = opts.skillsDir || defaultSkillsDir();
    const dir = path.join(skillsDir, `${name}-mcp`);

    let toolsDesc = '';
    let tools = opts.tools;
    if (tools === undefined) {
        const result = await probe(entry, { timeoutMs: opts.timeoutMs });
        tools = result.tools;
        if (!result.ok) {
            toolsDesc = '连接失败，工具列表暂缺：' + result.error;
        }
    }
    if (!toolsDesc) {
        toolsDesc = (tools || []).slice(0, 25)
            .map((t) => `- \`${t.name}\`: ${firstLine(t.description, SKILL_DESC_LIMIT)}`)
            .join('\n');
        if (!toolsDesc) toolsDesc = '(该服务器未声明任何工具)';
    }

    const md = [
        '---',
        `name: ${name}-mcp`,
        `description: Use when the user asks to operate the MCP server "${name}" on this machine (${describeTransport(entry)}${entry.url ? ' at ' + entry.url : ''}). DSH's built-in dsh-mcp-client OOM-crashes the Desktop host, so ALL operations against this server must go through the global \`${name}-mcp\` command instead of any MCP server tools.`,
        '---',
        '',
        `# MCP 直连：${name}`,
        '',
        `MCP 服务器 \`${name}\`（传输：${describeTransport(entry)}${entry.url ? '，地址 ' + entry.url : ''}）。`,
        '**不要**用 DSH 的 MCP 工具/dsh-mcp-client 操作它——那样会让桌面端宿主 OOM 崩溃。',
        `一律通过全局命令 \`${name}-mcp\`（已入用户 PATH）直连。`,
        '',
        '## 命令',
        '```cmd',
        `${name}-mcp list                       :: 列出服务器工具`,
        `${name}-mcp tools                      :: 同 list`,
        `${name}-mcp schema <tool>              :: 查某工具参数（枚举值，调用前必查）`,
        `${name}-mcp call <tool> <json>         :: 调用工具`,
        '```',
        '参数 JSON 三种传法（优先）：命令行第 3 参 → 环境变量 `MCPD_ARGS` → stdin。',
        '',
        '## 工具',
        toolsDesc,
        '',
        '## 标准工作流',
        '1. 不确定参数 → 先 `' + name + '-mcp schema <tool>` 拿 inputSchema；',
        '2. 传参数：`set MCPD_ARGS={"...json..."}` 后 `' + name + '-mcp call <tool>`（避免引号问题）；',
        '3. 返回的 `content[].text` 是 JSON 字符串，脚本已解析美化输出；',
        '4. 修改类操作（写动作）执行前先向用户确认；',
        `5. 服务器未启动时如实报告，提示先启动 ${entry.transport === 'stdio' ? entry.command : '目标服务的' + entry.url}。`,
        '',
    ].join('\n');

    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'SKILL.md');
    fs.writeFileSync(file, md, { encoding: 'utf8' });
    return file;
}

/**
 * Remove a server's generated artifacts (launcher and skill directory).
 *
 * Every step is best-effort and reported, so one locked file cannot strand the
 * registry entry or abort the whole removal.
 *
 * @param {string} name - server name.
 * @param {object} [paths] - {binDir, skillsDir}.
 * @returns {{removed: string[], failed: Array<{path: string, error: string}>}}
 */
function removeArtifacts(name, paths) {
    const opts = paths || {};
    const binDir = opts.binDir || defaultBinDir();
    const skillsDir = opts.skillsDir || defaultSkillsDir();
    const removed = [];
    const failed = [];

    const files = [
        path.join(binDir, `${name}-mcp.cmd`),
        path.join(skillsDir, `${name}-mcp`, 'SKILL.md'),
    ];
    for (const f of files) {
        try {
            if (fs.existsSync(f)) { fs.unlinkSync(f); removed.push(f); }
        } catch (e) {
            failed.push({ path: f, error: errText(e) });
        }
    }
    const skillDir = path.join(skillsDir, `${name}-mcp`);
    try {
        if (fs.existsSync(skillDir)) { fs.rmdirSync(skillDir); removed.push(skillDir); }
    } catch (e) {
        // A non-empty directory (extra files a user added) is not an error.
        if (e && e.code !== 'ENOENT' && e.code !== 'ENOTEMPTY') {
            failed.push({ path: skillDir, error: errText(e) });
        }
    }
    return { removed, failed };
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/**
 * Error to a single-line string.
 * @param {unknown} e
 * @returns {string}
 */
function errText(e) {
    return String((e && e.message) || e).slice(0, 500);
}

/**
 * First line of a description, truncated for list/skill display.
 * @param {string} description
 * @param {number} [limit]
 * @returns {string}
 */
function firstLine(description, limit) {
    const max = limit === undefined ? SKILL_DESC_LIMIT : limit;
    const line = String(description || '').split('\n')[0];
    return line.length > max ? line.slice(0, max - 1) + '…' : line;
}

module.exports = {
    REGISTRY_VERSION,
    DEFAULT_PROBE_TIMEOUT_MS,
    CLI_REGISTRY_PATH,
    TOOL_DIR,
    HOME_ENV_VAR,
    SDK_ENV_VAR,
    homeDir,
    defaultRegistryPath,
    defaultBinDir,
    defaultSkillsDir,
    findElectronExecutable,
    resolveSdk,
    sdkDir,
    candidateAppRoots,
    getLastSdkProbePaths: () => lastSdkProbePaths.slice(),
    loadRegistry,
    saveRegistry,
    migrateRegistry,
    nameOk,
    describeTransport,
    describeEndpoint,
    connect,
    listTools,
    closeQuietly,
    probe,
    callTool,
    flattenContent,
    generateCommand,
    generateSkill,
    removeArtifacts,
    errText,
    firstLine,
};
