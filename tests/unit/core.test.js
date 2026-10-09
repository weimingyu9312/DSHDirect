#!/usr/bin/env node
/*
 * Unit tests for lib/core.js — pure helpers, no network and no SDK needed.
 *
 * Run: node --test tests/unit/
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const core = require('../../packages/cli/lib/core.js');

/** @returns {string} a fresh temp directory removed when the test ends. */
function tempDir(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpd-test-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

test('nameOk accepts slug names and rejects everything else', () => {
    for (const ok of ['a', 'mydb', 'android-studio', 'x1-y2', '0abc']) {
        assert.equal(core.nameOk(ok), true, `${ok} should be valid`);
    }
    for (const bad of ['', 'A', 'Bad Name', '-lead', '_x', 'a.b', 'a/b', null, undefined, 42]) {
        assert.equal(core.nameOk(bad), false, `${String(bad)} should be rejected`);
    }
});

test('describeTransport defaults to streamable-http', () => {
    assert.equal(core.describeTransport({}), 'streamable-http');
    assert.equal(core.describeTransport({ transport: 'stdio' }), 'stdio');
    assert.equal(core.describeTransport({ transport: 'streamable-http' }), 'streamable-http');
});

test('describeEndpoint renders a url or a command line', () => {
    assert.equal(core.describeEndpoint({ url: 'http://x/y' }), 'http://x/y');
    assert.equal(
        core.describeEndpoint({ transport: 'stdio', command: 'node', args: ['a.js', '--flag'] }),
        'node a.js --flag',
    );
});

test('loadRegistry returns an empty shape when the file is absent', (t) => {
    const reg = core.loadRegistry(path.join(tempDir(t), 'missing.json'));
    assert.deepEqual(reg.servers, {});
});

test('loadRegistry rejects malformed and wrongly-shaped files', (t) => {
    const dir = tempDir(t);
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(bad, '{ not json', 'utf8');
    assert.throws(() => core.loadRegistry(bad), (e) => e.code === 'registry-unreadable');

    const arr = path.join(dir, 'arr.json');
    fs.writeFileSync(arr, '[1,2,3]', 'utf8');
    assert.throws(() => core.loadRegistry(arr), (e) => e.code === 'registry-unreadable');

    const badServers = path.join(dir, 'bs.json');
    fs.writeFileSync(badServers, '{"servers":[]}', 'utf8');
    assert.throws(() => core.loadRegistry(badServers), (e) => e.code === 'registry-unreadable');
});

test('saveRegistry round-trips UTF-8 without a BOM', (t) => {
    const file = path.join(tempDir(t), 'servers.json');
    core.saveRegistry({ servers: { cocos: { transport: 'streamable-http', url: 'http://127.0.0.1:3100/mcp' } } }, file);

    const bytes = fs.readFileSync(file);
    assert.notDeepEqual([...bytes.subarray(0, 3)], [0xEF, 0xBB, 0xBF], 'file must not start with a UTF-8 BOM');

    const loaded = core.loadRegistry(file);
    assert.equal(loaded.servers.cocos.url, 'http://127.0.0.1:3100/mcp');
});

test('saveRegistry does not invent a version field', (t) => {
    const file = path.join(tempDir(t), 'servers.json');
    core.saveRegistry({ servers: {} }, file);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, undefined);
});

test('migrateRegistry stamps a v1 file in memory only', (t) => {
    const file = path.join(tempDir(t), 'servers.json');
    const v1 = { servers: { cocos: { transport: 'streamable-http', url: 'http://x' } } };
    fs.writeFileSync(file, JSON.stringify(v1, null, 2), 'utf8');
    const before = fs.readFileSync(file, 'utf8');

    const migrated = core.migrateRegistry(file);
    assert.equal(migrated.version, core.REGISTRY_VERSION);
    assert.equal(migrated.migratedFrom, 1);
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'reading must not rewrite the file');
});

test('flattenContent pretty-prints JSON text blocks and notes others', () => {
    const out = core.flattenContent([
        { type: 'text', text: '{"a":1}' },
        { type: 'text', text: 'plain words' },
        { type: 'image', data: 'x' },
    ]);
    assert.equal(out[0].text, '{\n  "a": 1\n}');
    assert.equal(out[1].text, 'plain words');
    assert.equal(out[2].type, 'note');
    assert.match(out[2].text, /image/);
});

test('flattenContent tolerates empty and undefined input', () => {
    assert.deepEqual(core.flattenContent([]), []);
    assert.deepEqual(core.flattenContent(undefined), []);
});

test('firstLine truncates on the first line only', () => {
    assert.equal(core.firstLine('one\ntwo'), 'one');
    assert.equal(core.firstLine('abcdefghij', 5), 'abcd…');
    assert.equal(core.firstLine(undefined), '');
});

test('errText is single-line and bounded', () => {
    assert.equal(core.errText(new Error('boom')), 'boom');
    assert.equal(core.errText('plain'), 'plain');
    assert.equal(core.errText(new Error('x'.repeat(900))).length, 500);
});

test('MCPD_HOME redirects the registry and launcher directory', (t) => {
    const home = tempDir(t);
    const previous = process.env.MCPD_HOME;
    process.env.MCPD_HOME = home;
    t.after(() => {
        if (previous === undefined) delete process.env.MCPD_HOME;
        else process.env.MCPD_HOME = previous;
    });

    assert.equal(core.homeDir(), home);
    assert.equal(core.defaultRegistryPath(), path.join(home, 'servers.json'));
    assert.equal(core.defaultBinDir(), home);
});

test('binDirForHome honours the <bin>/tools/dsh-mcp-direct layout', () => {
    // A home at <bin>/tools/dsh-mcp-direct places launchers two levels up (the
    // PATH directory), matching the plugin host. An explicit MCPD_HOME wins.
    const home = path.join('C:', '', 'bin', 'tools', 'dsh-mcp-direct');
    assert.equal(core.binDirForHome(home, false), path.join('C:', '', 'bin'));
    assert.equal(core.binDirForHome(home, true), home);

    // A plain checkout (packages/cli) uses the home itself.
    const checkout = path.join('R:', '', 'repo', 'packages', 'cli');
    assert.equal(core.binDirForHome(checkout, false), checkout);
});

test('generateCommand writes a BOM-free launcher that pins MCPD_SERVER', (t) => {
    const dir = tempDir(t);
    const file = core.generateCommand('echo', { binDir: dir, toolDir: path.join(dir, 'tool') });
    assert.equal(file, path.join(dir, 'echo-mcp.cmd'));

    const bytes = fs.readFileSync(file);
    assert.notDeepEqual([...bytes.subarray(0, 3)], [0xEF, 0xBB, 0xBF], 'launcher must not start with a BOM');

    const text = bytes.toString('utf8');
    assert.match(text, /set "MCPD_SERVER=echo"/);
    assert.match(text, /mcp-direct\.js/);
    // The launcher must work on a Desktop-only machine with no standalone node.
    assert.match(text, /ELECTRON_RUN_AS_NODE/);
});

test('generateSkill writes the SKILL.md and names the direct route', async (t) => {
    const dir = tempDir(t);
    const file = await core.generateSkill('echo', { transport: 'streamable-http', url: 'http://127.0.0.1:9/mcp' }, {
        skillsDir: dir,
        tools: [{ name: 'echo', description: 'Echo back text.' }],
    });
    assert.equal(file, path.join(dir, 'echo-mcp', 'SKILL.md'));

    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /name: echo-mcp/);
    assert.match(text, /echo-mcp call <tool>/);
    assert.match(text, /`echo`: Echo back text\./);
});

test('generateSkill survives an empty tool list', async (t) => {
    const dir = tempDir(t);
    const file = await core.generateSkill('bare', { transport: 'streamable-http', url: 'http://x' }, {
        skillsDir: dir,
        tools: [],
    });
    assert.match(fs.readFileSync(file, 'utf8'), /未声明任何工具/);
});

test('removeArtifacts reports what it deleted and ignores absent files', (t) => {
    const dir = tempDir(t);
    const binDir = path.join(dir, 'bin');
    const skillsDir = path.join(dir, 'skills');
    core.generateCommand('gone', { binDir, toolDir: dir });
    fs.mkdirSync(path.join(skillsDir, 'gone-mcp'), { recursive: true });
    fs.writeFileSync(path.join(skillsDir, 'gone-mcp', 'SKILL.md'), 'x', 'utf8');

    const cleanup = core.removeArtifacts('gone', { binDir, skillsDir });
    assert.equal(cleanup.failed.length, 0);
    assert.equal(cleanup.removed.length, 3);
    assert.equal(fs.existsSync(path.join(binDir, 'gone-mcp.cmd')), false);

    // A second call is a no-op rather than an error.
    const again = core.removeArtifacts('gone', { binDir, skillsDir });
    assert.equal(again.removed.length, 0);
    assert.equal(again.failed.length, 0);
});

test('removeArtifacts keeps a skill directory holding user files', (t) => {
    const dir = tempDir(t);
    const skillsDir = path.join(dir, 'skills');
    const skillDir = path.join(skillsDir, 'kept-mcp');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), 'x', 'utf8');
    fs.writeFileSync(path.join(skillDir, 'notes.md'), 'mine', 'utf8');

    const cleanup = core.removeArtifacts('kept', { binDir: dir, skillsDir });
    assert.equal(cleanup.failed.length, 0);
    assert.equal(fs.existsSync(path.join(skillDir, 'notes.md')), true, 'user files must survive');
});

test('resolveSdk honours MCPD_SDK_DIR and reports the paths it tried', (t) => {
    const dir = tempDir(t);
    const previous = process.env.MCPD_SDK_DIR;
    process.env.MCPD_SDK_DIR = dir;
    t.after(() => {
        if (previous === undefined) delete process.env.MCPD_SDK_DIR;
        else process.env.MCPD_SDK_DIR = previous;
    });

    assert.throws(() => core.resolveSdk(), /does not exist/);
    assert.deepEqual(core.getLastSdkProbePaths(), [dir]);
});

test('candidateAppRoots never hardcodes a personal install path', () => {
    const roots = core.candidateAppRoots();
    for (const root of roots) {
        assert.doesNotMatch(String(root), /soft[\\/]ai/i, `personal path leaked: ${root}`);
    }
});
