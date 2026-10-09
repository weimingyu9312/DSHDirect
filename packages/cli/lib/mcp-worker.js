#!/usr/bin/env node
/*
 * mcp-direct worker — one short-lived MCP operation in its own process.
 *
 * WHY THIS EXISTS
 * ---------------
 * The DSH Desktop Host is an Electron process running a V8 heap that is capped
 * near 4 GB, and on this machine it climbs close to that ceiling during normal
 * use. Loading @modelcontextprotocol/client costs roughly 27 MB of resident
 * memory that is NOT reclaimed by GC (it is a module graph, not transient
 * garbage). Doing that load inside the Host turned "open the MCP manager page"
 * into the final allocation that tipped the heap over:
 *
 *     OOM error in V8: MarkCompactCollector ... 3938.9 (4074.0) MB
 *
 * So the Host never loads the SDK. It spawns this worker, which does the MCP
 * work in its own process, prints one JSON line, and exits. The Host's resident
 * cost for MCP support becomes zero, and a hung or crashing server can only
 * kill a child.
 *
 * CONTRACT
 * --------
 * stdin:  one JSON object `{ op, entry, tool?, args?, timeoutMs? }`
 * stdout: exactly one JSON line `{ ok: true, value } | { ok: false, error }`
 * Any diagnostic noise must go to stderr, because stdout carries the result.
 * Exit code is 0 for a completed request (including a reported failure) and 1
 * only when the request could not be processed at all.
 */
'use strict';

const core = require('./core.js');

/**
 * Run the requested operation and resolve to a plain JSON value.
 *
 * @param {object} request - parsed request from stdin.
 * @returns {Promise<{ok: true, value: object} | {ok: false, error: string}>}
 */
async function run(request) {
    const { op, entry, timeoutMs } = request;
    const options = { timeoutMs: timeoutMs === undefined ? core.DEFAULT_PROBE_TIMEOUT_MS : timeoutMs };

    // `resolve-sdk` reports this process's SDK/registry resolution and needs no
    // server entry; `probe-many` carries its own list of entries.
    // Every other op acts on exactly one server.
    if (op === 'resolve-sdk') {
        return {
            ok: true,
            value: {
                sdkDir: core.sdkDir(),
                toolDir: core.TOOL_DIR,
                home: core.homeDir(),
                registryPath: core.defaultRegistryPath(),
            },
        };
    }

    if (op === 'probe-many') {
        // Probing every server through one worker avoids N process starts for
        // N servers. Entries are probed sequentially: MCP connections are
        // rarely the bottleneck, and sequential probing keeps this child's peak
        // memory bounded regardless of server count.
        const entries = Array.isArray(request.entries) ? request.entries : [];
        const results = [];
        for (const item of entries) {
            if (!item || item.entry === null || item.entry === undefined) {
                results.push({ ok: false, tools: [], ms: 0, error: 'missing entry' });
                continue;
            }
            const startedAt = Date.now();
            const result = await core.probe(item.entry, options);
            results.push(result.ok
                ? { ok: true, tools: result.tools, ms: result.ms }
                : { ok: false, tools: [], ms: Date.now() - startedAt, error: result.error });
        }
        return { ok: true, value: { results } };
    }

    if (entry === undefined || entry === null) {
        return { ok: false, error: 'missing MCP server entry' };
    }

    switch (op) {
        case 'probe': {
            const result = await core.probe(entry, options);
            // `probe` already converts failures into {ok:false,error}; pass it
            // through unchanged so the Host reports the real connection error.
            return result.ok
                ? { ok: true, value: { tools: result.tools, ms: result.ms } }
                : { ok: false, error: result.error };
        }

        case 'call': {
            const result = await core.callTool(entry, request.tool, request.args || {}, options);
            if (!result.ok) return { ok: false, error: result.error };
            return {
                ok: true,
                value: { content: core.flattenContent(result.content), isError: result.isError },
            };
        }

        default:
            return { ok: false, error: `unknown op "${String(op)}"` };
    }
}

/**
 * Read all of stdin as text.
 * @returns {Promise<string>}
 */
function readStdin() {
    return new Promise((resolve, reject) => {
        let data = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (chunk) => { data += chunk; });
        process.stdin.on('end', () => resolve(data));
        process.stdin.on('error', reject);
    });
}

async function main() {
    let request;
    try {
        let raw = await readStdin();
        // Tolerate a UTF-8 BOM and surrounding whitespace. A caller on Windows
        // may produce this request with a tool that prepends a BOM (PowerShell's
        // `Set-Content -Encoding UTF8` does exactly that), and JSON.parse
        // rejects it with an unhelpful "Unexpected token" error.
        if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
        request = JSON.parse(raw.trim());
    } catch (error) {
        process.stdout.write(JSON.stringify({ ok: false, error: `invalid worker request: ${String(error && error.message || error)}` }) + '\n');
        process.exitCode = 1;
        return;
    }

    let result;
    try {
        result = await run(request);
    } catch (error) {
        result = { ok: false, error: String(error && error.message || error) };
    }
    // Exactly one JSON line on stdout; the Host reads that and nothing else.
    process.stdout.write(JSON.stringify(result) + '\n');
}

main();
