'use strict';
/*
 * Realistic plugin boot verification: import the LINKED plugin directory with
 * NO toolDir override, so detectToolDir() resolves the deployed core the same
 * way the DSH host will after restart. Run: node tests/verify-boot.js
 */
const { mkdtempSync, writeFileSync, rmSync } = require('fs');
const { tmpdir } = require('os');
const path = require('path');
const { createServer } = require('http');

(async () => {
    const PLUGIN = 'D:/aiAsk/dsh-mcp-direct-plugin/index.js';
    const { apply } = await import('file:///' + PLUGIN.replace(/\\/g, '/'));

    const dir = mkdtempSync(path.join(tmpdir(), 'mcpd-boot-'));
    const registryPath = path.join(dir, 'servers.json');
    writeFileSync(registryPath, JSON.stringify({
        servers: { cocos: { transport: 'streamable-http', url: 'http://127.0.0.1:3100/mcp', headers: {}, addedAt: 'x' } },
    }, null, 2), 'utf8');

    const routes = [];
    const logs = [];
    const ctx = {
        logger: { info: (m) => logs.push('INFO ' + m), error: (m) => logs.push('ERROR ' + m) },
        effect(fn) { return fn(); },
        webServer: { register(r) { routes.push(r); return () => {}; } },
    };
    // Only the registry is redirected; toolDir, binDir, skillsDir all come from
    // detection — exactly the config-free contract.
    apply(ctx, { registryPath });

    let pass = 0;
    const check = (label, cond, detail) => {
        console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' :: ' + detail : ''}`);
        if (cond) pass += 1;
    };

    const infoLine = logs.find((l) => l.includes('registry='));
    check('no ERROR logged', !logs.some((l) => l.startsWith('ERROR')), logs.join(' | '));
    check('routes registered', routes.length >= 7, String(routes.length));
    check('toolDir auto-detected', Boolean(infoLine), infoLine || 'no info line');
    check('detects the deployed core dir',
        Boolean(infoLine && infoLine.includes('D:\\soft\\ai\\dsh\\tools\\dsh-mcp-direct')),
        infoLine || '');

    const server = createServer((req, res) => {
        const route = routes.find((r) => r.path === new URL(req.url, 'http://x').pathname);
        if (!route) { res.writeHead(404); res.end('no route'); return; }
        route.handler(req, res);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}/api/dsh-mcp-direct`;

    const st = await fetch(`${base}/status`, { method: 'POST', body: '{}' }).then((r) => r.json());
    check('status ok', st.ok === true, JSON.stringify(st).slice(0, 200));
    check('workerPaths.home points at deployed core',
        String(st?.value?.workerPaths?.home).includes('\\soft\\ai\\dsh\\tools\\dsh-mcp-direct'),
        JSON.stringify(st?.value?.workerPaths));

    server.close();
    rmSync(dir, { recursive: true, force: true });
    console.log(`\n${pass} checks passed`);
    process.exitCode = pass === 6 ? 0 : 1;
})();