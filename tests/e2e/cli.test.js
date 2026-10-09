#!/usr/bin/env node
/*
 * End-to-end CLI tests against a real MCP server over the stdio transport.
 *
 * Every case runs the actual `mcp-direct.js` entry point in a throwaway
 * MCPD_HOME, so the registry, launcher, and skill files are all exercised and
 * nothing outside the temp directory is touched.
 *
 * Run: node tests/e2e/cli.test.js
 *
 * NOTE: this suite spawns child processes. Under a confined sandbox that blocks
 * piped stdio it fails with `spawn EPERM`; run it outside the sandbox.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', '..', 'packages', 'cli', 'mcp-direct.js');
const ECHO = path.join(__dirname, '..', 'fixtures', 'echo-server.js');

/**
 * Run the CLI and capture its output.
 *
 * @param {string[]} argv
 * @param {object} [options] - {env, home}.
 * @returns {{status: number, stdout: string, stderr: string}}
 */
function runCli(argv, options) {
    const opts = options || {};
    try {
        const stdout = execFileSync(process.execPath, [CLI, ...argv, '--home', opts.home], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 60000,
            env: Object.assign({}, process.env, { MCPD_SERVER: '' }, opts.env || {}),
        });
        return { status: 0, stdout, stderr: '' };
    } catch (e) {
        return { status: e.status === undefined ? 1 : e.status, stdout: String(e.stdout || ''), stderr: String(e.stderr || '') };
    }
}

/** @returns {string} a temp home directory removed when the test ends. */
function tempHome(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpd-e2e-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

test('usage and version are available', (t) => {
    const home = tempHome(t);
    const help = runCli(['--help'], { home });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /usage:/);

    const version = runCli(['--version'], { home });
    assert.equal(version.status, 0);
    assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+$/);

    // No subcommand prints usage rather than failing.
    assert.match(runCli([], { home }).stdout, /usage:/);
});

test('list on an empty registry explains how to add a server', (t) => {
    const home = tempHome(t);
    const result = runCli(['list'], { home });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /no servers registered/);
    assert.match(result.stdout, new RegExp(`registry: .*servers\\.json`));
});

test('add-stdio registers a server and generates both artifacts', (t) => {
    const home = tempHome(t);
    const add = runCli(['add-stdio', 'echo', process.execPath, ECHO], { home });
    assert.equal(add.status, 0, add.stderr);
    assert.match(add.stdout, /连接成功: 3 个工具/);

    // Registry is the single source of truth and is BOM-free.
    const registryPath = path.join(home, 'servers.json');
    const bytes = fs.readFileSync(registryPath);
    assert.notDeepEqual([...bytes.subarray(0, 3)], [0xEF, 0xBB, 0xBF]);
    const registry = JSON.parse(bytes.toString('utf8'));
    assert.equal(registry.servers.echo.transport, 'stdio');
    assert.deepEqual(registry.servers.echo.args, [ECHO]);

    // Launcher lands in the home directory; skill lands under it too.
    const launcher = path.join(home, 'echo-mcp.cmd');
    assert.equal(fs.existsSync(launcher), true, 'launcher should exist');
    const skill = path.join(home, 'echo-mcp', 'SKILL.md');
    assert.equal(fs.existsSync(skill), true, 'skill should exist');

    const skillText = fs.readFileSync(skill, 'utf8');
    for (const tool of ['echo', 'add', 'boom']) {
        assert.match(skillText, new RegExp(`\`${tool}\``), `skill should list ${tool}`);
    }
});

test('add rejects duplicate names, bad names, and bad urls', (t) => {
    const home = tempHome(t);
    runCli(['add-stdio', 'echo', process.execPath, ECHO], { home });

    const dup = runCli(['add-stdio', 'echo', process.execPath, ECHO], { home });
    assert.equal(dup.status, 1);
    assert.match(dup.stderr, /已存在/);

    const badName = runCli(['add', 'Bad Name', 'http://127.0.0.1:1/mcp'], { home });
    assert.equal(badName.status, 1);
    assert.match(badName.stderr, /\[a-z0-9-\]/);

    const badUrl = runCli(['add', 'validname', 'ftp://x/y'], { home });
    assert.equal(badUrl.status, 1);
    assert.match(badUrl.stderr, /http\(s\)/);

    const unreachable = runCli(['add', 'dead', 'http://127.0.0.1:1/mcp'], { home });
    assert.equal(unreachable.status, 1, 'a server that cannot be reached must not be persisted');
    assert.match(unreachable.stderr, /连接失败/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'servers.json'), 'utf8')).servers.dead, undefined);
});

test('tools lists the server catalogue', (t) => {
    const home = tempHome(t);
    runCli(['add-stdio', 'echo', process.execPath, ECHO], { home });

    const result = runCli(['tools', 'echo'], { home });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /=== echo \(3 tools\) ===/);
    assert.match(result.stdout, /\[add\]/);
    assert.match(result.stdout, /\[boom\]/);
    assert.match(result.stdout, /\[echo\]/);

    const json = runCli(['tools', 'echo', '--json'], { home });
    const parsed = JSON.parse(json.stdout);
    assert.deepEqual(parsed.tools.map((x) => x.name), ['add', 'boom', 'echo']);
});

test('schema prints the inputSchema for a tool', (t) => {
    const home = tempHome(t);
    runCli(['add-stdio', 'echo', process.execPath, ECHO], { home });

    const result = runCli(['schema', 'echo', 'add'], { home });
    assert.equal(result.status, 0, result.stderr);
    const schema = JSON.parse(result.stdout);
    assert.equal(schema.name, 'add');
    assert.deepEqual(schema.inputSchema.required, ['a', 'b']);
});

test('schema reports an unknown tool without crashing', (t) => {
    const home = tempHome(t);
    runCli(['add-stdio', 'echo', process.execPath, ECHO], { home });
    const result = runCli(['schema', 'echo', 'nope'], { home });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /未找到工具/);
});

test('call passes JSON arguments through and pretty-prints the result', (t) => {
    const home = tempHome(t);
    runCli(['add-stdio', 'echo', process.execPath, ECHO], { home });

    const result = runCli(['call', 'echo', 'add', '{"a":2,"b":40}'], { home });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"sum": 42/);

    // MCPD_ARGS is the quoting-safe path and must win when no argv JSON exists.
    const viaEnv = runCli(['call', 'echo', 'echo'], { home, env: { MCPD_ARGS: '{"text":"hi"}' } });
    assert.equal(viaEnv.status, 0, viaEnv.stderr);
    assert.match(viaEnv.stdout, /"echoed": "hi"/);
});

test('call surfaces a tool-level error as exit code 2', (t) => {
    const home = tempHome(t);
    runCli(['add-stdio', 'echo', process.execPath, ECHO], { home });
    const result = runCli(['call', 'echo', 'boom', '{}'], { home });
    assert.equal(result.status, 2);
    assert.match(result.stdout, /intentional failure/);
});

test('call rejects malformed or non-object arguments', (t) => {
    const home = tempHome(t);
    runCli(['add-stdio', 'echo', process.execPath, ECHO], { home });

    const badJson = runCli(['call', 'echo', 'add', '{oops'], { home });
    assert.equal(badJson.status, 1);
    assert.match(badJson.stderr, /不是合法 JSON/);
    // The offending input is echoed so a shell-quoting mistake is visible.
    assert.match(badJson.stderr, /\{oops/);

    const notObject = runCli(['call', 'echo', 'add', '[1,2]'], { home });
    assert.equal(notObject.status, 1);
    assert.match(notObject.stderr, /JSON 对象/);
});

test('call on an unregistered server fails clearly', (t) => {
    const home = tempHome(t);
    const result = runCli(['call', 'ghost', 'x', '{}'], { home });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /未注册/);
});

test('MCPD_SERVER lets the launcher form omit the server name', (t) => {
    const home = tempHome(t);
    runCli(['add-stdio', 'echo', process.execPath, ECHO], { home });

    const tools = runCli(['tools'], { home, env: { MCPD_SERVER: 'echo' } });
    assert.equal(tools.status, 0, tools.stderr);
    assert.match(tools.stdout, /=== echo \(3 tools\) ===/);

    const schema = runCli(['schema', 'add'], { home, env: { MCPD_SERVER: 'echo' } });
    assert.equal(JSON.parse(schema.stdout).name, 'add');

    const call = runCli(['call', 'add', '{"a":1,"b":1}'], { home, env: { MCPD_SERVER: 'echo' } });
    assert.match(call.stdout, /"sum": 2/);
});

test('probe reports status in text and JSON', (t) => {
    const home = tempHome(t);
    runCli(['add-stdio', 'echo', process.execPath, ECHO], { home });

    const text = runCli(['probe', 'echo'], { home });
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /OK · 3 tools/);

    const json = runCli(['probe', 'echo', '--json'], { home });
    assert.deepEqual(JSON.parse(json.stdout), { ok: true, name: 'echo', tools: 3, ms: JSON.parse(json.stdout).ms });
});

test('remove deletes the entry and its generated artifacts', (t) => {
    const home = tempHome(t);
    runCli(['add-stdio', 'echo', process.execPath, ECHO], { home });
    assert.equal(fs.existsSync(path.join(home, 'echo-mcp.cmd')), true);

    const result = runCli(['remove', 'echo'], { home });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /已移除 echo/);
    assert.equal(fs.existsSync(path.join(home, 'echo-mcp.cmd')), false);
    assert.equal(fs.existsSync(path.join(home, 'echo-mcp', 'SKILL.md')), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'servers.json'), 'utf8')).servers, {});

    const again = runCli(['remove', 'echo'], { home });
    assert.equal(again.status, 1);
    assert.match(again.stderr, /不存在/);
});

test('an unknown option and an unknown command fail with guidance', (t) => {
    const home = tempHome(t);
    const badFlag = runCli(['list', '--nope'], { home });
    assert.equal(badFlag.status, 1);
    assert.match(badFlag.stderr, /unknown option/);

    const badCmd = runCli(['frobnicate'], { home });
    assert.equal(badCmd.status, 1);
    assert.match(badCmd.stderr, /未知命令/);
    assert.match(badCmd.stdout, /usage:/);
});
