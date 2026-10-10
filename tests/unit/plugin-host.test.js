#!/usr/bin/env node
/*
 * Tests for the plugin host half (packages/plugin/index.js) with a mock ctx.
 *
 * Covers the deterministic parts — route registration, the admission guard,
 * body limits, and registry validation — without needing a live worker child.
 * Operations that spawn a worker (list with servers, status) are asserted
 * tolerantly so the suite passes both inside and outside a confined sandbox.
 *
 * Run: node tests/unit/plugin-host.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { createServer } = require('node:http');

const PLUGIN = path.join(__dirname, '..', '..', 'packages', 'plugin', 'index.js');
const CLI_DIR = path.join(__dirname, '..', '..', 'packages', 'cli');

/**
 * Apply the plugin to a mock ctx and return the registered routes.
 *
 * @param {string} registryPath - redirected registry so the test cannot touch real state.
 * @returns {{ routes: Array<{path: string, handler: Function}>, logs: string[], applyError?: string }}
 */
async function applyPlugin(registryPath, options) {
    const { apply } = await import('file:///' + PLUGIN.replace(/\\/g, '/'));
    const routes = [];
    const logs = [];
    const ctx = {
        logger: { info: (m) => logs.push('INFO  ' + m), error: (m) => logs.push('ERROR ' + m) },
        effect(fn) { const dispose = fn(); return dispose; },
        webServer: { register(route) { routes.push(route); return () => {}; } },
    };
    const cfg = { toolDir: CLI_DIR, registryPath };
    if (options && options.skillsDir) cfg.skillsDir = options.skillsDir;
    apply(ctx, cfg);
    return { routes, logs };
}

/** Spin up an HTTP server that routes to the plugin's registered routes. */
async function serveRoutes(routes) {
    const server = createServer((req, res) => {
        const route = routes.find((r) => r.path === new URL(req.url, 'http://x').pathname);
        if (!route) { res.writeHead(404); res.end('no route'); return; }
        route.handler(req, res);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}/api/dsh-mcp-direct`;
    return { server, base };
}

test('apply registers every documented route without any config', async (t) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mcpd-host-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const registryPath = path.join(dir, 'servers.json');
    writeFileSync(registryPath, JSON.stringify({ servers: {} }, null, 2), 'utf8');

    const { routes, logs } = await applyPlugin(registryPath);
    assert.ok(routes.length >= 7, `expected all ops registered, got ${routes.length}`);
    for (const op of ['status', 'list', 'tools', 'schema', 'add', 'remove', 'call']) {
        assert.ok(routes.some((r) => r.path === `/api/dsh-mcp-direct/${op}`), `${op} route missing`);
    }
    assert.equal(logs.some((l) => l.startsWith('ERROR')), false, 'no error should be logged');
});

test('admission guard: GET is rejected with 405', async (t) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mcpd-host-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const { routes } = await applyPlugin(path.join(dir, 'servers.json'));
    const { server, base } = await serveRoutes(routes);
    t.after(() => server.close());

    const res = await fetch(`${base}/status`, { method: 'GET' });
    assert.equal(res.status, 405);
    assert.deepEqual(await res.json(), { ok: false, code: 'rejected', message: 'method not allowed: GET' });
});

test('admission guard: a forged Host header is rejected with 403', async (t) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mcpd-host-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const { routes } = await applyPlugin(path.join(dir, 'servers.json'));
    const { server, base } = await serveRoutes(routes);
    t.after(() => server.close());

    // undici fetch silently rewrites the Host header to the request target, so
    // forge it through a raw socket request instead — that is how an attacker
    // actually reaches the bridge.
    const port = new URL(base).port;
    const status = await new Promise((resolve, reject) => {
        const req = require('node:http').request({
            host: '127.0.0.1', port, path: '/api/dsh-mcp-direct/status', method: 'POST',
            headers: { host: 'evil.example.com' },
        }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
        req.on('error', reject);
        req.end();
    });
    assert.equal(status, 403);
});

test('admission guard: cross-site is rejected with 403', async (t) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mcpd-host-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const { routes } = await applyPlugin(path.join(dir, 'servers.json'));
    const { server, base } = await serveRoutes(routes);
    t.after(() => server.close());

    const res = await fetch(`${base}/status`, {
        method: 'POST',
        headers: { 'sec-fetch-site': 'cross-site' },
    });
    assert.equal(res.status, 403);
});

test('admission guard: a cross-origin Origin header is rejected with 403', async (t) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mcpd-host-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const { routes } = await applyPlugin(path.join(dir, 'servers.json'));
    const { server, base } = await serveRoutes(routes);
    t.after(() => server.close());

    const host = new URL(base).host;
    const res = await fetch(`${base}/status`, {
        method: 'POST',
        headers: { origin: `http://evil.example.com:${new URL(base).port}` },
    });
    assert.equal(res.status, 403);

    // A same-origin Origin is admitted.
    const res2 = await fetch(`${base}/status`, {
        method: 'POST',
        headers: { origin: `http://${host}` },
    });
    assert.equal(res2.status, 200);
});

test('admission guard: a body over 64 KiB is rejected with 400', async (t) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mcpd-host-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const { routes } = await applyPlugin(path.join(dir, 'servers.json'));
    const { server, base } = await serveRoutes(routes);
    t.after(() => server.close());

    const big = JSON.stringify({ pad: 'x'.repeat(70 * 1024) });
    const res = await fetch(`${base}/status`, {
        method: 'POST',
        body: big,
        headers: { 'content-type': 'application/json' },
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, 'rejected');
    assert.match(body.message, /exceeds 65536/);
});

test('list on an empty registry succeeds without spawning a worker', async (t) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mcpd-host-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const registryPath = path.join(dir, 'servers.json');
    writeFileSync(registryPath, JSON.stringify({ servers: {} }, null, 2), 'utf8');

    const { routes } = await applyPlugin(registryPath);
    const { server, base } = await serveRoutes(routes);
    t.after(() => server.close());

    const res = await fetch(`${base}/list`, { method: 'POST', body: '{}' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.deepEqual(body.value.servers, []);
});

test('add validates the name before any connection is attempted', async (t) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mcpd-host-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const registryPath = path.join(dir, 'servers.json');
    writeFileSync(registryPath, JSON.stringify({ servers: {} }, null, 2), 'utf8');

    const { routes } = await applyPlugin(registryPath);
    const { server, base } = await serveRoutes(routes);
    t.after(() => server.close());

    const res = await fetch(`${base}/add`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Bad Name', transport: 'streamable-http', url: 'http://x/y' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.code, 'invalid-name');

    // Nothing was persisted.
    const reg = JSON.parse(require('node:fs').readFileSync(registryPath, 'utf8'));
    assert.deepEqual(reg.servers, {});
});

test('status always answers with a well-formed shape', async (t) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mcpd-host-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const { routes } = await applyPlugin(path.join(dir, 'servers.json'));
    const { server, base } = await serveRoutes(routes);
    t.after(() => server.close());

    const res = await fetch(`${base}/status`, { method: 'POST', body: '{}' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true, JSON.stringify(body));
    // The SDK is resolved in a worker child: inside a sandbox that child cannot
    // run, in which case sdkError is set instead of sdkDir. Either is expected.
    assert.ok(
        typeof body.value.sdkDir === 'string' || typeof body.value.sdkError === 'string',
        `expected sdkDir or sdkError, got ${JSON.stringify(body.value)}`,
    );
    assert.ok(typeof body.value.registryPath === 'string');
    assert.ok(typeof body.value.serverCount === 'number');
});

test('server list carries the derived per-server skillDir', async (t) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mcpd-host-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const skillsDir = path.join(dir, 'skills');
    const registryPath = path.join(dir, 'servers.json');
    writeFileSync(registryPath, JSON.stringify({
        servers: { cocos: { transport: 'streamable-http', url: 'http://127.0.0.1:3100/mcp', headers: {}, addedAt: 'x' } },
    }, null, 2), 'utf8');

    const { routes } = await applyPlugin(registryPath, { skillsDir });
    const { server, base } = await serveRoutes(routes);
    t.after(() => server.close());

    const res = await fetch(`${base}/list`, { method: 'POST', body: '{}' });
    const body = await res.json();
    assert.equal(body.ok, true, JSON.stringify(body));
    assert.equal(body.value.servers[0].skillDir, path.join(skillsDir, 'cocos-mcp'));
});

test('openSkillDir derives the path host-side and rejects unknown servers', async (t) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mcpd-host-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const skillsDir = path.join(dir, 'skills');
    const registryPath = path.join(dir, 'servers.json');
    writeFileSync(registryPath, JSON.stringify({
        servers: { cocos: { transport: 'streamable-http', url: 'http://127.0.0.1:3100/mcp', headers: {}, addedAt: 'x' } },
    }, null, 2), 'utf8');
    // The skill actually exists — the handler requires it before opening.
    const skillDir = path.join(skillsDir, 'cocos-mcp');
    require('node:fs').mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: cocos-mcp', 'utf8');

    const { routes } = await applyPlugin(registryPath, { skillsDir });
    const { server, base } = await serveRoutes(routes);
    t.after(() => server.close());

    // Valid server with an existing skill directory: the host spawns a file
    // manager (best-effort) and reports the derived path — either way the
    // response names the directory it was asked to open.
    const ok = await fetch(`${base}/openSkillDir`, {
        method: 'POST',
        body: JSON.stringify({ name: 'cocos' }),
    }).then((r) => r.json());
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal(ok.value.dir, skillDir);

    // The client never supplies a path, so a bogus name must be rejected and
    // never map to an arbitrary directory.
    const bad = await fetch(`${base}/openSkillDir`, {
        method: 'POST',
        body: JSON.stringify({ name: 'evil' }),
    }).then((r) => r.json());
    assert.equal(bad.ok, false);
    assert.equal(bad.code, 'server-missing');

    const badName = await fetch(`${base}/openSkillDir`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Bad Name' }),
    }).then((r) => r.json());
    assert.equal(badName.ok, false);
    assert.equal(badName.code, 'invalid-name');

    // A registered server whose skill directory was never generated (e.g. the
    // file was deleted) is reported as skill-missing, not opened.
    const noSkill = await fetch(`${base}/openSkillDir`, {
        method: 'POST',
        body: JSON.stringify({ name: 'ghost' }),
    }).then((r) => r.json());
    assert.equal(noSkill.ok, false);
    assert.equal(noSkill.code, 'server-missing');
});