/**
 * dsh-mcp-direct — Host half.
 *
 * Owns the MCP server registry and exposes management operations to the Web
 * GUI over a loopback-only HTTP bridge. It NEVER registers an MCP tool into
 * ctx.tools: that registration is exactly what makes the shipped
 * @deepseek-ai/dsh-mcp-client OOM-crash the Desktop host, and staying out of
 * the tool runtime is this plugin's reason to exist.
 *
 * Architecture:
 *   GUI (client.js) --fetch--> loopback bridge (this file) --spawn--> mcp-worker.js
 *                                                                        |
 *                                                          @modelcontextprotocol/client
 *                                                          (separate process, then exits)
 *
 * The Host must never require the MCP SDK. Loading it costs ~27 MB of resident
 * memory that GC does not reclaim (a module graph, not transient garbage), and
 * the Electron Host heap is capped near 4 GB and climbs close to it in normal
 * use. Doing that load in-process turned "open the MCP manager page" into the
 * final allocation before OOM:
 *
 *     OOM error in V8: MarkCompactCollector ... 3938.9 (4074.0) MB
 *
 * So every MCP operation runs in a short-lived worker child. The Host's resident
 * cost for MCP support is zero, and a hung or crashing server kills only a child.
 *
 * The registry file is shared with the standalone `mcp-direct` CLI, so the GUI
 * and the `<name>-mcp` commands always agree.
 *
 * Security: the bridge mutates a file on disk and spawns processes, so it is
 * gated on a genuine loopback request (address + Host + same-origin + POST).
 */

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';

const require = createRequire(import.meta.url);

/** Bridge route prefix; every route below is an exact POST endpoint. */
const BRIDGE_PREFIX = '/api/dsh-mcp-direct';

/** Request body cap; a management payload is far smaller than this. */
const MAX_JSON_BODY_BYTES = 64 * 1024;

/** Default per-server probe timeout. */
const DEFAULT_PROBE_TIMEOUT_MS = 8000;

/** Hard ceiling for one worker run, including process start and teardown. */
const WORKER_TIMEOUT_MS = 20000;

/**
 * Resolve a Node.js executable able to run mcp-worker.js as a script.
 *
 * The Host runs inside Electron, where `process.execPath` is the DESKTOP
 * APPLICATION binary (DSH Desktop.exe), not node. Spawning that binary with a
 * script path does not execute the script: it produced a silent child with no
 * stdout, which surfaced in the GUI as "MCP worker produced no result".
 *
 * Electron nevertheless ships a full Node runtime. Two supported ways to reach
 * it, tried in order:
 *
 *   1. `process.env.NODE` — the node binary Electron was launched with.
 *   2. `ELECTRON_RUN_AS_NODE=1` in the child environment — makes the Electron
 *      binary itself behave as plain node. This is the reliable fallback
 *      because it needs no external node installation at all.
 *
 * When the Host is already plain node (e.g. a headless `dsh` run), execPath is
 * node and case 1 applies naturally.
 *
 * The Host also forwards the SDK location it can already see, because inside
 * the worker `process.execPath` is node and the Electron-installation probing in
 * core.js no longer applies.
 *
 * @returns {{command: string, env: Record<string, string>, reason: string}}
 */
function resolveNodeRuntime() {
    const env = { ...process.env };

    // Hand the worker the app installation root so it can find the MCP SDK even
    // though its own execPath no longer points at the Electron app.
    if (process.versions.electron !== undefined && process.resourcesPath) {
        env.MCPD_APP_ROOT = path.join(process.resourcesPath, 'app');
    }

    // Plain node: execPath is the interpreter, so it can run the script directly.
    if (process.versions.electron === undefined) {
        return { command: process.execPath, env, reason: 'host is plain node' };
    }

    // Electron with an explicit node binary.
    if (process.env.NODE && existsSync(process.env.NODE)) {
        return { command: process.env.NODE, env, reason: 'process.env.NODE' };
    }

    // Electron as node: the app binary re-executes as plain node.
    env.ELECTRON_RUN_AS_NODE = '1';
    return { command: process.execPath, env, reason: 'ELECTRON_RUN_AS_NODE' };
}

/**
 * Run one MCP operation in a short-lived worker process.
 *
 * The worker is given a single JSON request on stdin and answers with a single
 * JSON line on stdout. Spawning per operation (rather than keeping one alive)
 * means the Host holds no MCP state at all: no SDK module graph, no live socket,
 * no handle to leak. Startup costs roughly 250 ms, which is irrelevant for a
 * management UI.
 *
 * The child is always killed on timeout so a hung server cannot accumulate
 * processes in the Host.
 *
 * @param {string} workerPath - absolute path to mcp-worker.js.
 * @param {object} request - {op, entry, tool?, args?, timeoutMs?}.
 * @param {number} [timeoutMs] - override for the whole worker run.
 * @returns {Promise<{ok: true, value: object} | {ok: false, error: string}>}
 */
function runWorker(workerPath, request, timeoutMs) {
    return new Promise((resolve) => {
        // The Host is Electron, whose execPath is the app binary — see
        // resolveNodeRuntime() for why that cannot run the worker directly.
        const runtime = resolveNodeRuntime();
        let child;
        try {
            child = spawn(runtime.command, [workerPath], {
                stdio: ['pipe', 'pipe', 'pipe'],
                windowsHide: true,
                env: runtime.env,
            });
        } catch (error) {
            resolve({ ok: false, error: `could not start MCP worker: ${String(error && error.message || error)}` });
            return;
        }

        let stdout = '';
        let stderr = '';
        let settled = false;
        const limit = timeoutMs === undefined ? WORKER_TIMEOUT_MS : timeoutMs;

        const finish = (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            // Detach the child regardless: a stuck server must not outlive the call.
            try { child.kill(); } catch (error) { /* already gone */ }
            resolve(result);
        };

        const timer = setTimeout(() => {
            finish({ ok: false, error: `MCP worker exceeded ${limit}ms and was terminated` });
        }, limit);

        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('error', (error) => {
            finish({ ok: false, error: `MCP worker failed to start: ${String(error && error.message || error)}` });
        });
        child.on('close', (code) => {
            if (code !== 0 && stdout.trim() === '') {
                finish({
                    ok: false,
                    error: `MCP worker exited with code ${code}`
                        + (stderr.trim() ? `: ${stderr.trim().split('\n')[0]}` : ''),
                });
                return;
            }
            // The worker prints exactly one JSON line; take the last non-empty
            // line so a stray warning on stdout cannot break parsing.
            const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
            const last = lines[lines.length - 1];
            if (!last) {
                finish({ ok: false, error: 'MCP worker produced no result' });
                return;
            }
            try {
                finish(JSON.parse(last));
            } catch (error) {
                finish({ ok: false, error: `MCP worker returned unparsable output: ${last.slice(0, 200)}` });
            }
        });

        try {
            child.stdin.end(JSON.stringify(request));
        } catch (error) {
            finish({ ok: false, error: `could not send request to MCP worker: ${String(error && error.message || error)}` });
        }
    });
}

/**
 * Resolve the shared core module path without loading it.
 *
 * Only the pure helpers are imported by the Host (registry IO, name validation,
 * artifact generation). The MCP SDK is reached solely through mcp-worker.js, so
 * requiring core.js here does NOT pull the SDK into the Host: its `require` of
 * the SDK is inside `connect()`, which the Host never calls.
 *
 * @param {string | undefined} toolDir - directory holding lib/core.js.
 * @returns {{ok: true, core: object, workerPath: string} | {ok: false, error: string}}
 */
function loadCore(toolDir) {
    if (!toolDir) {
        return {
            ok: false,
            error: 'could not locate the mcp-direct tool directory (expected lib/core.js under '
                + '<dsh>/tools/dsh-mcp-direct). Set config.toolDir to override the detection.',
        };
    }
    const corePath = path.join(toolDir, 'lib', 'core.js');
    if (!existsSync(corePath)) {
        return { ok: false, error: `shared core not found at ${corePath}` };
    }
    const workerPath = path.join(toolDir, 'lib', 'mcp-worker.js');
    if (!existsSync(workerPath)) {
        return { ok: false, error: `MCP worker not found at ${workerPath}` };
    }
    try {
        return { ok: true, core: require(corePath), workerPath };
    } catch (error) {
        return { ok: false, error: `could not load ${corePath}: ${error && error.message ? error.message : String(error)}` };
    }
}

/**
 * Locate the mcp-direct CLI tool directory without configuration.
 *
 * Defaults are resolved in code rather than in `cordis.patch.yml` on purpose.
 * The profile uses `patchReload: live`, so any config value that differs from
 * the bundle's declared default forces the entry to be updated and reconciled
 * on every enable/disable — which, combined with a `disabled: true` row written
 * into the profile's own patch, produced a reconcile loop that repeatedly
 * reloaded the Host and killed live page connections (ECONNRESET). Keeping the
 * row config-free leaves the patch entry a pure `insert`, so toggling the bundle
 * cannot oscillate.
 *
 * Probe order: MCPD_HOME, the DSH home convention, then any PATH entry whose
 * `tools/dsh-mcp-direct` sibling holds the tool.
 *
 * @returns {string | undefined} directory containing mcp-direct.js and lib/core.js.
 */
function detectToolDir() {
    const candidates = [
        process.env.MCPD_HOME,
        path.join(homedir(), '.dsh', 'tools', 'dsh-mcp-direct'),
    ];
    for (const dir of candidates) {
        if (dir && existsSync(path.join(dir, 'lib', 'core.js'))) return dir;
    }
    // Fall back to a PATH lookup for the launcher, whose sibling holds the tool.
    const pathVar = process.env.PATH || '';
    for (const entry of pathVar.split(path.delimiter)) {
        if (!entry) continue;
        const dir = path.join(entry, 'tools', 'dsh-mcp-direct');
        if (existsSync(path.join(dir, 'lib', 'core.js'))) return dir;
    }
    return undefined;
}

/**
 * Choose the directory that receives the generated `<name>-mcp.cmd` launchers.
 *
 * The launcher has to land where the user's PATH already looks. Two layouts are
 * supported without any configuration:
 *
 *   <bin>/tools/dsh-mcp-direct   the conventional install; the launcher goes in
 *                                <bin>, which is on PATH, not in <bin>/tools.
 *   any other directory          the tool directory itself, which is the case
 *                                for a plain checkout (`packages/cli`).
 *
 * When the caller passes MCPD_HOME that choice always wins, because the CLI
 * writes its launchers there too and both surfaces must agree.
 *
 * @param {string} toolDir - directory holding mcp-direct.js.
 * @returns {string} directory for generated launchers.
 */
function defaultBinDir(toolDir) {
    if (process.env.MCPD_HOME) return process.env.MCPD_HOME;
    const parts = toolDir.split(path.sep);
    if (parts[parts.length - 1] === 'dsh-mcp-direct' && parts[parts.length - 2] === 'tools') {
        return path.dirname(path.dirname(toolDir));
    }
    return toolDir;
}

/**
 * Resolve the effective paths once, filling defaults from the core module.
 *
 * Every field is optional: an unset row config yields sensible detected values,
 * which keeps the patch row config-free and therefore a pure `insert`.
 *
 * @param {object} config - resolved plugin config.
 * @param {object} core - loaded core module.
 * @returns {{registryPath: string, toolDir: string, binDir: string, skillsDir: string, probeTimeoutMs: number}}
 */
function resolvePaths(config, core) {
    const toolDir = config.toolDir || detectToolDir();
    return {
        toolDir,
        registryPath: config.registryPath || core.defaultRegistryPath(),
        // The generated <name>-mcp.cmd launchers belong in the directory that is
        // already on the user PATH. For the conventional <bin>/tools/dsh-mcp-direct
        // install that is TWO levels up — not the immediate parent, which would be
        // <bin>/tools and is not on PATH.
        binDir: config.binDir || defaultBinDir(toolDir),
        skillsDir: config.skillsDir || core.defaultSkillsDir(),
        probeTimeoutMs: typeof config.probeTimeoutMs === 'number' && config.probeTimeoutMs > 0
            ? config.probeTimeoutMs
            : DEFAULT_PROBE_TIMEOUT_MS,
    };
}

/* ------------------------------------------------------------------ *
 * HTTP helpers
 * ------------------------------------------------------------------ */

/**
 * Reject any request that is not a genuine same-origin loopback POST.
 *
 * The bridge mutates the registry and can spawn processes, so this is the only
 * authorization boundary. It mirrors the checks the shipped free-search bridge
 * uses: source address, Host header, Sec-Fetch-Site, and Origin same-origin.
 *
 * @param {import('node:http').IncomingMessage} request
 * @returns {true | string} true when admitted, else a rejection reason.
 */
function admissionFailure(request) {
    const address = request.socket && request.socket.remoteAddress;
    if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') {
        return 'loopback requests only';
    }
    const host = request.headers.host;
    if (typeof host !== 'string') return 'missing Host header';
    let hostUrl;
    try {
        hostUrl = new URL('http://' + host);
    } catch {
        return 'malformed Host header';
    }
    if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') {
        return 'loopback Host required';
    }
    if (request.headers['sec-fetch-site'] === 'cross-site') return 'cross-site request rejected';
    const origin = request.headers.origin;
    if (origin !== undefined) {
        try {
            if (new URL(origin).host !== hostUrl.host) return 'cross-origin request rejected';
        } catch {
            return 'malformed Origin header';
        }
    }
    if (request.method !== 'POST') return 'method not allowed: ' + String(request.method ?? '');
    return true;
}

/**
 * Write a JSON response.
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function writeJson(res, status, body) {
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'referrer-policy': 'no-referrer',
        'cache-control': 'no-store',
    });
    res.end(JSON.stringify(body));
}

/**
 * Read and parse a bounded JSON body.
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<{ok: true, value: unknown} | {ok: false, error: string}>}
 */
async function readJsonBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_JSON_BODY_BYTES) return { ok: false, error: `body exceeds ${MAX_JSON_BODY_BYTES} bytes` };
        chunks.push(chunk);
    }
    if (chunks.length === 0) return { ok: true, value: {} };
    try {
        return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
    } catch (error) {
        return { ok: false, error: 'malformed JSON body' };
    }
}

/** @param {unknown} error @returns {string} */
function errText(error) {
    return String((error && error.message) || error);
}

/* ------------------------------------------------------------------ *
 * Host plugin
 * ------------------------------------------------------------------ */

export const name = 'dsh-mcp-direct';

export const inject = ['webServer'];

/**
 * Plugin entry point: register the loopback management bridge.
 *
 * @param {object} ctx - plugin context.
 * @param {object} config - resolved row config from cordis.patch.yml.
 */
export function apply(ctx, config) {
    const resolvedConfig = config || {};
    // Detect the tool directory first: it locates lib/core.js and becomes the
    // base for every other default path.
    const toolDir = resolvedConfig.toolDir || detectToolDir();
    const loaded = loadCore(toolDir);
    if (!loaded.ok) {
        // Fail loudly but do not abort boot: the plugin is optional, and a bad
        // path should surface as an actionable message rather than a dead host.
        ctx.logger?.error?.(`dsh-mcp-direct: ${loaded.error}`);
        return;
    }
    const core = loaded.core;
    const workerPath = loaded.workerPath;
    const paths = resolvePaths(Object.assign({}, resolvedConfig, { toolDir }), core);

    ctx.logger?.info?.(
        `dsh-mcp-direct: registry=${paths.registryPath} bin=${paths.binDir} skills=${paths.skillsDir} worker=${workerPath}`
    );

    /**
     * Read the registry, tolerating a missing file.
     * @returns {{ok: true, value: object} | {ok: false, code: string, message: string}}
     */
    function readRegistry() {
        try {
            return { ok: true, value: core.loadRegistry(paths.registryPath) };
        } catch (error) {
            return {
                ok: false,
                code: error?.code === 'registry-unreadable' ? 'registry-unreadable' : 'registry-error',
                message: errText(error),
            };
        }
    }

    /**
     * A server entry shaped for the GUI (never includes env/header values).
     * @param {string} name
     * @param {object} entry
     */
    function serverView(name, entry) {
        return {
            name,
            transport: core.describeTransport(entry),
            endpoint: core.describeEndpoint(entry),
            url: entry.url,
            command: entry.command,
            args: entry.args || [],
            addedAt: entry.addedAt,
            headerNames: Object.keys(entry.headers || {}),
            envNames: Object.keys(entry.env || {}),
        };
    }

    /**
     * Probe one server through the worker process.
     *
     * Normalised so every caller sees the same shape regardless of whether the
     * failure came from the MCP server or from the worker itself.
     *
     * @param {object} entry - registry entry.
     * @returns {Promise<{ok: boolean, tools: object[], ms: number, error?: string}>}
     */
    async function probeEntry(entry) {
        const startedAt = Date.now();
        const result = await runWorker(workerPath, {
            op: 'probe',
            entry,
            timeoutMs: paths.probeTimeoutMs,
        }, paths.probeTimeoutMs + WORKER_TIMEOUT_MS);
        if (!result.ok) {
            return { ok: false, tools: [], ms: Date.now() - startedAt, error: result.error };
        }
        return { ok: true, tools: result.value.tools || [], ms: result.value.ms };
    }

    /** Management operations, each returning {ok, value} or {ok, code, message}. */
    const handlers = {
        /** List servers with a live probe of each. */
        async list() {
            const reg = readRegistry();
            if (!reg.ok) return reg;
            const names = Object.keys(reg.value.servers);

            // One worker for every server: N servers must not cost N process
            // starts, each of which would allocate a fresh SDK module graph.
            let results = [];
            if (names.length > 0) {
                const batch = await runWorker(workerPath, {
                    op: 'probe-many',
                    entries: names.map((n) => ({ name: n, entry: reg.value.servers[n] })),
                    timeoutMs: paths.probeTimeoutMs,
                }, paths.probeTimeoutMs * names.length + WORKER_TIMEOUT_MS);
                if (batch.ok) {
                    results = batch.value.results || [];
                } else {
                    // A worker-level failure (start, timeout, protocol) is
                    // reported per server rather than failing the whole list.
                    results = names.map(() => ({ ok: false, tools: [], ms: 0, error: batch.error }));
                }
            }

            const servers = names.map((n, i) => {
                const entry = reg.value.servers[n];
                const result = results[i] || { ok: false, tools: [], ms: 0, error: 'no result' };
                return Object.assign(serverView(n, entry), {
                    toolCount: result.tools.length,
                    ok: result.ok,
                    error: result.ok ? undefined : result.error,
                    ms: result.ms,
                });
            });

            return {
                ok: true,
                value: {
                    servers,
                    registryPath: paths.registryPath,
                    paths: { toolDir: paths.toolDir, binDir: paths.binDir, skillsDir: paths.skillsDir },
                },
            };
        },

        /** Full tool list (with inputSchema) for one server. */
        async tools(request) {
            const reg = readRegistry();
            if (!reg.ok) return reg;
            const n = request && request.name;
            const entry = reg.value.servers[n];
            if (!entry) return { ok: false, code: 'server-missing', message: `服务器 "${n}" 未注册` };
            const result = await probeEntry(entry);
            if (!result.ok) return { ok: false, code: 'connect-failed', message: result.error };
            return {
                ok: true,
                value: {
                    name: n,
                    tools: result.tools
                        .map((t) => ({
                            name: t.name,
                            description: t.description || '',
                            inputSchema: t.inputSchema || null,
                        }))
                        .sort((a, b) => a.name.localeCompare(b.name)),
                    ms: result.ms,
                },
            };
        },

        /** Show one tool's schema (mirrors the CLI `schema` command). */
        async schema(request) {
            const listed = await handlers.tools(request);
            if (!listed.ok) return listed;
            const wanted = request && request.tool;
            const tools = listed.value.tools;
            const found = tools.find((t) => t.name === wanted)
                || tools.find((t) => t.name === `${request.name}_${wanted}`)
                || tools.find((t) => t.name.includes(wanted));
            if (!found) return { ok: false, code: 'tool-missing', message: `未找到工具: ${wanted}` };
            return { ok: true, value: found };
        },

        /**
         * Register a new server (HTTP or stdio), probe it, then persist.
         *
         * Persist-last is deliberate: a server that cannot be reached must not
         * enter the registry, matching the CLI's contract.
         */
        async add(request) {
            const n = request && request.name;
            const transport = (request && request.transport) || 'streamable-http';
            if (!core.nameOk(n)) {
                return { ok: false, code: 'invalid-name', message: '服务器名需为 [a-z0-9-]，如 mydb / android-studio' };
            }
            const reg = readRegistry();
            if (!reg.ok) return reg;
            if (reg.value.servers[n]) return { ok: false, code: 'server-exists', message: `服务器 "${n}" 已存在` };

            let entry;
            if (transport === 'stdio') {
                const command = request && request.command;
                if (!command) return { ok: false, code: 'invalid-command', message: '缺少 stdio 启动命令' };
                entry = {
                    transport: 'stdio',
                    command,
                    args: Array.isArray(request.args) ? request.args : [],
                    env: request.env && typeof request.env === 'object' ? request.env : {},
                    addedAt: new Date().toISOString(),
                };
            } else {
                const url = request && request.url;
                if (typeof url !== 'string' || !/^https?:\/\//.test(url)) {
                    return { ok: false, code: 'invalid-url', message: 'url 需以 http(s):// 开头' };
                }
                entry = {
                    transport: 'streamable-http',
                    url,
                    headers: request.headers && typeof request.headers === 'object' ? request.headers : {},
                    addedAt: new Date().toISOString(),
                };
            }

            const result = await probeEntry(entry);
            if (!result.ok) {
                return { ok: false, code: 'connect-failed', message: `连接失败: ${result.error}` };
            }

            reg.value.servers[n] = entry;
            core.saveRegistry(reg.value, paths.registryPath);

            // Artifacts are best-effort: a locked .cmd must not lose the entry.
            const artifacts = { command: null, skill: null, failed: [] };
            try {
                artifacts.command = core.generateCommand(n, { binDir: paths.binDir, toolDir: paths.toolDir });
            } catch (error) {
                artifacts.failed.push({ path: 'launcher', error: errText(error) });
            }
            try {
                // `tools` is always supplied so generateSkill never probes on its
                // own — that would load the SDK in the Host process.
                artifacts.skill = await core.generateSkill(n, entry, {
                    skillsDir: paths.skillsDir,
                    tools: result.tools,
                });
            } catch (error) {
                artifacts.failed.push({ path: 'skill', error: errText(error) });
            }

            return {
                ok: true,
                value: { name: n, toolCount: result.tools.length, artifacts },
            };
        },

        /**
         * Remove a server and its generated artifacts.
         *
         * The registry write happens first so a locked artifact file cannot
         * leave the entry stranded; failures are reported, not hidden.
         */
        async remove(request) {
            const n = request && request.name;
            const reg = readRegistry();
            if (!reg.ok) return reg;
            if (!reg.value.servers[n]) return { ok: false, code: 'server-missing', message: `服务器 "${n}" 不存在` };
            delete reg.value.servers[n];
            core.saveRegistry(reg.value, paths.registryPath);
            const cleanup = core.removeArtifacts(n, { binDir: paths.binDir, skillsDir: paths.skillsDir });
            return { ok: true, value: { name: n, removed: cleanup.removed, failed: cleanup.failed } };
        },

        /** Call one tool and return its flattened content. */
        async call(request) {
            const reg = readRegistry();
            if (!reg.ok) return reg;
            const n = request && request.name;
            const entry = reg.value.servers[n];
            if (!entry) return { ok: false, code: 'server-missing', message: `服务器 "${n}" 未注册` };
            const tool = request && request.tool;
            if (!tool) return { ok: false, code: 'tool-missing', message: '缺少工具名' };
            const args = request && request.args;
            if (args !== undefined && (args === null || typeof args !== 'object' || Array.isArray(args))) {
                return { ok: false, code: 'invalid-args', message: '参数必须是 JSON 对象' };
            }
            const result = await runWorker(workerPath, {
                op: 'call',
                entry,
                tool,
                args: args || {},
                timeoutMs: paths.probeTimeoutMs,
            }, paths.probeTimeoutMs + WORKER_TIMEOUT_MS);
            if (!result.ok) return { ok: false, code: 'call-failed', message: result.error };
            return { ok: true, value: result.value };
        },

        /** Report how the plugin resolved its runtime inputs (diagnostics). */
        async status() {
            const reg = readRegistry();
            // Ask the worker to resolve the SDK path; resolving it here would
            // load the SDK into the Host, which is exactly what this design
            // exists to prevent.
            const sdk = await runWorker(workerPath, { op: 'resolve-sdk' }, WORKER_TIMEOUT_MS);
            const resolved = sdk.ok ? sdk.value : {};
            return {
                ok: true,
                value: {
                    sdkDir: resolved.sdkDir ?? null,
                    sdkError: sdk.ok ? null : sdk.error,
                    registryPath: paths.registryPath,
                    registryOk: reg.ok,
                    registryError: reg.ok ? undefined : reg.message,
                    serverCount: reg.ok ? Object.keys(reg.value.servers).length : 0,
                    paths: { toolDir: paths.toolDir, binDir: paths.binDir, skillsDir: paths.skillsDir },
                    // What the worker itself resolved. Divergence from `paths`
                    // above means the Host's detection and the worker's differ,
                    // which is the first thing to check when an artifact lands
                    // somewhere unexpected.
                    workerPaths: {
                        toolDir: resolved.toolDir,
                        home: resolved.home,
                        registryPath: resolved.registryPath,
                    },
                    home: homedir(),
                    probeTimeoutMs: paths.probeTimeoutMs,
                },
            };
        },
    };

    /**
     * Register every bridge route as an effect-owned resource.
     *
     * Each route is POST-only; the method check lives in admissionFailure so a
     * GET cannot reach a handler.
     */
    ctx.effect(() => {
        const disposers = Object.keys(handlers).map((op) => ctx.webServer.register({
            kind: 'exact',
            path: `${BRIDGE_PREFIX}/${op}`,
            handler: async (req, res) => {
                const admitted = admissionFailure(req);
                if (admitted !== true) {
                    writeJson(res, admitted.startsWith('method not allowed') ? 405 : 403, {
                        ok: false, code: 'rejected', message: admitted,
                    });
                    return;
                }
                const body = await readJsonBody(req);
                if (!body.ok) {
                    writeJson(res, 400, { ok: false, code: 'rejected', message: body.error });
                    return;
                }
                try {
                    writeJson(res, 200, await handlers[op](body.value));
                } catch (error) {
                    // A handler crash must not kill the route: report it as a typed failure.
                    ctx.logger?.error?.(`dsh-mcp-direct: ${op} failed: ${errText(error)}`);
                    writeJson(res, 200, { ok: false, code: 'handler-error', message: errText(error) });
                }
            },
        }));
        return () => {
            for (const dispose of disposers) dispose();
        };
    }, 'dsh-mcp-direct: management bridge');
}
