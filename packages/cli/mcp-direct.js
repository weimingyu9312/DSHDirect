#!/usr/bin/env node
/*
 * mcp-direct — generic MCP direct client/manager for DSH Desktop.
 *
 * Bypasses DSH's dsh-mcp-client (which OOM-crashes the Desktop host when it
 * loads MCP tools). Runs the official @modelcontextprotocol/client SDK in a
 * standalone Node process; nothing is registered into the host's tool runtime.
 *
 * Supports both streamable-http and stdio transports.
 *
 * All connection, registry, and artifact logic lives in lib/core.js, shared
 * with the dsh-mcp-direct DSH plugin so the CLI and the GUI can never drift.
 *
 * Commands:
 *   mcp-direct list                     list registered servers (+ probe)
 *   mcp-direct add <name> <url> [--header K=V ...]
 *                                        register an HTTP MCP server (one-liner),
 *                                        probe it, and generate <name>-mcp.cmd + skill
 *   mcp-direct add-stdio <name> <command> [args...]
 *                                        register a stdio MCP server, probe, generate command+skill
 *   mcp-direct remove <name>             unregister server + its .cmd + skill
 *   mcp-direct tools <name>              list tools of a server
 *   mcp-direct schema <name> <tool>      show tool input schema
 *   mcp-direct call <name> <tool> <json> call a tool (json via arg, env MCPD_ARGS, or stdin)
 *   mcp-direct probe <name>              reconnect and report tool count
 *
 * Global options (any position):
 *   --home <dir>      registry + launcher directory (env MCPD_HOME)
 *   --bin-dir <dir>   where <name>-mcp.cmd is written (default: --home)
 *   --skills-dir <d>  where <name>-mcp/SKILL.md is written (default: ~/.dsh/skills)
 *   --json            machine-readable output where supported
 *   --help, --version
 */
'use strict';

const core = require('./lib/core.js');

const TOOL_DIR = __dirname;
// The deploy pattern copies only mcp-direct.js + lib/, so package.json may not
// exist next to this script. A missing manifest must not crash the CLI.
let VERSION = '0.0.0-dev';
try { VERSION = require('./package.json').version; } catch (e) { /* standalone copy */ }

/**
 * Split argv into options and positionals.
 *
 * Options may appear anywhere, so a `--home` after the subcommand works the
 * same as before it. `--` ends option parsing.
 *
 * @param {string[]} argv - process.argv.slice(2).
 * @returns {{positionals: string[], flags: object}}
 */
function parseArgs(argv) {
    const positionals = [];
    const flags = { headers: {} };
    let i = 0;
    let optionsDone = false;
    while (i < argv.length) {
        const arg = argv[i];
        if (optionsDone || !arg.startsWith('--')) {
            positionals.push(arg);
            i += 1;
            continue;
        }
        if (arg === '--') { optionsDone = true; i += 1; continue; }
        const eq = arg.indexOf('=');
        const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
        const inlineValue = eq === -1 ? undefined : arg.slice(eq + 1);
        const take = () => {
            if (inlineValue !== undefined) return inlineValue;
            i += 1;
            return argv[i];
        };
        switch (key) {
            case 'help': case 'h': flags.help = true; i += 1; break;
            case 'version': case 'v': flags.version = true; i += 1; break;
            case 'json': flags.json = true; i += 1; break;
            case 'home': flags.home = take(); i += 1; break;
            case 'bin-dir': case 'binDir': flags.binDir = take(); i += 1; break;
            case 'skills-dir': case 'skillsDir': flags.skillsDir = take(); i += 1; break;
            case 'header': {
                const kv = String(take() || '').split('=');
                if (kv[0]) flags.headers[kv[0]] = kv.slice(1).join('=');
                i += 1;
                break;
            }
            default:
                throw new Error(`unknown option: ${arg}`);
        }
    }
    return { positionals, flags };
}

/**
 * Apply global flags to the process environment.
 *
 * Setting MCPD_HOME here (rather than passing a path everywhere) means every
 * core helper — registry, launcher, skill — agrees on one home without each
 * call site having to thread it through.
 *
 * @param {object} flags
 */
function applyGlobalFlags(flags) {
    if (flags.home) process.env[core.HOME_ENV_VAR] = flags.home;
}

/**
 * @param {object} flags
 * @returns {{binDir: string, skillsDir: string}}
 */
function artifactPaths(flags) {
    return {
        binDir: flags.binDir || core.defaultBinDir(),
        skillsDir: flags.skillsDir || core.defaultSkillsDir(),
    };
}

async function cmdList(flags) {
    const reg = core.loadRegistry();
    const names = Object.keys(reg.servers).sort();
    if (names.length === 0) {
        console.log('(no servers registered — use: mcp-direct add <name> <url>)');
        console.log(`registry: ${core.defaultRegistryPath()}`);
        return;
    }
    const rows = [];
    for (const n of names) {
        const s = reg.servers[n];
        const r = await core.probe(s);
        rows.push({ name: n, transport: core.describeTransport(s), ok: r.ok, tools: r.tools.length, error: r.ok ? undefined : r.error, ms: r.ms });
        if (flags.json) continue;
        if (r.ok) {
            console.log(`[${n}] ${core.describeTransport(s)} · ${r.tools.length} tools · OK (${r.ms}ms)`);
        } else {
            console.log(`[${n}] ${core.describeTransport(s)} · FAILED: ${r.error.slice(0, 200)}`);
        }
    }
    if (flags.json) console.log(JSON.stringify({ registry: core.defaultRegistryPath(), servers: rows }, null, 2));
}

/**
 * Register a server: probe first, persist only on success.
 *
 * @param {object} entry - registry entry to add.
 * @param {string} name - validated server name.
 * @param {object} flags
 */
async function addEntry(name, entry, flags) {
    const reg = core.loadRegistry();
    if (reg.servers[name]) throw new Error(`服务器 "${name}" 已存在`);
    const r = await core.probe(entry);
    if (!r.ok) throw new Error('连接失败: ' + r.error);
    console.log(`连接成功: ${r.tools.length} 个工具`);
    reg.servers[name] = entry;
    core.saveRegistry(reg);
    const paths = artifactPaths(flags);
    const results = { registry: core.defaultRegistryPath(), command: null, skill: null, failed: [] };
    try {
        results.command = core.generateCommand(name, { binDir: paths.binDir, toolDir: TOOL_DIR });
    } catch (e) {
        results.failed.push({ path: 'launcher', error: core.errText(e) });
    }
    try {
        results.skill = await core.generateSkill(name, entry, { skillsDir: paths.skillsDir, tools: r.tools });
    } catch (e) {
        results.failed.push({ path: 'skill', error: core.errText(e) });
    }
    if (results.command) console.log(`  ✓ global command: ${results.command}`);
    if (results.skill) console.log(`  ✓ skill: ${results.skill}`);
    for (const f of results.failed) console.error(`  ! ${f.path}: ${f.error}`);
    console.log('\n完成！现在可以全局使用：');
    console.log(`  ${name}-mcp tools`);
    console.log(`  ${name}-mcp call <tool> '{"...":"..."}'`);
    if (!flags.binDir && !process.env.PATH.split(require('path').delimiter).includes(core.defaultBinDir())) {
        console.log(`\n提示：${core.defaultBinDir()} 不在 PATH 中，请把它加入 PATH 才能直接使用 ${name}-mcp。`);
    }
}

async function cmdAdd(name, url, headers, flags) {
    if (!core.nameOk(name)) throw new Error('服务器名需为 [a-z0-9-]，如 mydb / android-studio');
    if (!/^https?:\/\//.test(url || '')) throw new Error('url 需以 http(s):// 开头');
    await addEntry(name, {
        transport: 'streamable-http',
        url,
        headers: headers || {},
        addedAt: new Date().toISOString(),
    }, flags);
}

async function cmdAddStdio(name, command, args, flags) {
    if (!core.nameOk(name)) throw new Error('服务器名需为 [a-z0-9-]');
    if (!command) throw new Error('缺少 stdio 启动命令');
    await addEntry(name, {
        transport: 'stdio',
        command,
        args: args || [],
        env: {},
        addedAt: new Date().toISOString(),
    }, flags);
}

async function cmdRemove(name, flags) {
    const reg = core.loadRegistry();
    if (!reg.servers[name]) throw new Error(`服务器 "${name}" 不存在`);
    delete reg.servers[name];
    core.saveRegistry(reg);
    const paths = artifactPaths(flags);
    const cleanup = core.removeArtifacts(name, paths);
    console.log(`已移除 ${name} 及其命令/技能`);
    for (const p of cleanup.removed) console.log(`  - ${p}`);
    for (const f of cleanup.failed) console.error(`  ! ${f.path}: ${f.error}`);
}

async function cmdTools(name, flags) {
    const reg = core.loadRegistry();
    const s = reg.servers[name];
    if (!s) throw new Error(`服务器 "${name}" 未注册（先 mcp-direct add ${name} <url>）`);
    const r = await core.probe(s);
    if (!r.ok) throw new Error(r.error);
    const tools = r.tools.slice().sort((a, b) => a.name.localeCompare(b.name));
    if (flags.json) {
        console.log(JSON.stringify({ name, tools }, null, 2));
        return;
    }
    console.log(`=== ${name} (${tools.length} tools) ===`);
    for (const t of tools) {
        const line = `[${t.name}] ${t.description || ''}`.split('\n')[0];
        console.log(line.length > 170 ? line.slice(0, 167) + '...' : line);
    }
}

async function cmdSchema(name, tool, flags) {
    const reg = core.loadRegistry();
    const s = reg.servers[name];
    if (!s) throw new Error(`服务器 "${name}" 未注册`);
    const r = await core.probe(s);
    if (!r.ok) throw new Error(r.error);
    const tools = r.tools;
    const t = tools.find((x) => x.name === tool || x.name === `${name}_${tool}`)
        || tools.find((x) => x.name.includes(tool));
    if (!t) {
        console.log(JSON.stringify(tools.map((x) => x.name), null, 2));
        throw new Error(`未找到工具: ${tool}`);
    }
    console.log(JSON.stringify({ name: t.name, description: t.description, inputSchema: t.inputSchema }, null, 2));
}

/**
 * Read tool arguments from the command line, MCPD_ARGS, or stdin.
 *
 * @param {string|undefined} argsJson
 * @returns {Promise<object>}
 */
async function readArgs(argsJson) {
    let source = 'argv';
    let raw = argsJson || process.env.MCPD_ARGS;
    if (!argsJson && process.env.MCPD_ARGS) source = 'MCPD_ARGS';
    if (!raw) {
        // Only wait on stdin when it is actually piped: reading a terminal
        // stdin would hang forever waiting for an EOF the user cannot send.
        raw = await new Promise((resolve) => {
            if (process.stdin.isTTY) { resolve(''); return; }
            let d = '';
            process.stdin.setEncoding('utf8');
            process.stdin.on('data', (c) => { d += c; });
            process.stdin.on('end', () => resolve(d));
            process.stdin.on('error', () => resolve(''));
        });
        source = 'stdin';
    }
    if (!raw || !raw.trim()) return {};
    try {
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('参数必须是 JSON 对象');
        }
        return parsed;
    } catch (e) {
        // Quote the offending input: the usual cause on Windows is the shell or
        // PowerShell rewriting the quotes before mcp-direct ever sees them.
        throw new Error(`参数不是合法 JSON（来自 ${source}）: ${raw.trim().slice(0, 200)}\n  ${core.errText(e)}`);
    }
}

async function cmdCall(name, tool, argsJson, flags) {
    const reg = core.loadRegistry();
    const s = reg.servers[name];
    if (!s) throw new Error(`服务器 "${name}" 未注册`);
    if (!tool) throw new Error('缺少工具名');
    const args = await readArgs(argsJson);
    const r = await core.callTool(s, tool, args);
    if (!r.ok) throw new Error(r.error);
    if (flags.json) {
        console.log(JSON.stringify({ content: core.flattenContent(r.content), isError: r.isError }, null, 2));
    } else {
        for (const item of core.flattenContent(r.content)) console.log(item.text);
    }
    if (r.isError) process.exitCode = 2;
}

const USAGE = `mcp-direct ${VERSION} — direct MCP client/manager for DSH Desktop

usage:
  mcp-direct list                          list registered servers (probes each)
  mcp-direct add <name> <url> [--header K=V ...]
  mcp-direct add-stdio <name> <command> [args...]
  mcp-direct remove <name>
  mcp-direct tools <name>                  list a server's tools
  mcp-direct schema <name> <tool>          show a tool's inputSchema
  mcp-direct call <name> <tool> <json>     call a tool (arg | MCPD_ARGS | stdin)
  mcp-direct probe <name>                  reconnect and report tool count

options:
  --home <dir>        registry + launcher dir (env: MCPD_HOME)
  --bin-dir <dir>     where <name>-mcp.cmd is written (default: --home)
  --skills-dir <dir>  where <name>-mcp/SKILL.md is written (default: ~/.dsh/skills)
  --json              machine-readable output
  --help, --version

environment:
  MCPD_HOME     override the mcp-direct home directory
  MCPD_SERVER   set by generated <name>-mcp.cmd launchers to imply <name>
  MCPD_ARGS     tool arguments as JSON (avoids shell quoting problems)
  MCPD_SDK_DIR  override the @modelcontextprotocol/client package directory`;

async function main() {
    let parsed;
    try {
        parsed = parseArgs(process.argv.slice(2));
    } catch (e) {
        console.error('错误: ' + core.errText(e));
        process.exitCode = 1;
        return;
    }
    const { positionals, flags } = parsed;

    if (flags.version) { console.log(VERSION); return; }
    if (flags.help) { console.log(USAGE); return; }

    applyGlobalFlags(flags);

    let [cmd, a1, a2, ...rest] = positionals;
    // Generated <name>-mcp.cmd launchers set MCPD_SERVER=<name> and expect to
    // omit the server name on the command line: `cocos-mcp tools`,
    // `cocos-mcp schema <tool>`, `cocos-mcp call <tool> <json>`.
    // Remap arguments to the canonical (name, tool, json) form when set.
    const sv = process.env.MCPD_SERVER;
    if (sv && (cmd === 'tools' || cmd === 'list-tools' || cmd === 'probe' ||
        cmd === 'schema' || cmd === 'call' || cmd === 'remove')) {
        switch (cmd) {
            case 'tools': case 'list-tools': case 'probe':
                // `cocos-mcp tools` — the server comes from MCPD_SERVER and any
                // positional the user typed is not a server name.
                a1 = sv;
                break;
            case 'schema':
                a2 = a1; a1 = sv;
                break;
            case 'call':
                rest = [a2, ...rest]; a2 = a1; a1 = sv;
                break;
            case 'remove':
                a1 = sv;
                break;
        }
    }

    try {
        switch (cmd) {
            case undefined: case 'help': console.log(USAGE); return;
            case 'list': return await cmdList(flags);
            case 'add': return await cmdAdd(a1, a2, flags.headers, flags);
            case 'add-stdio': return await cmdAddStdio(a1, a2, rest, flags);
            case 'remove': return await cmdRemove(a1, flags);
            case 'tools': case 'list-tools': return await cmdTools(a1, flags);
            case 'schema': return await cmdSchema(a1, a2, flags);
            case 'probe': {
                const target = a1;
                const reg = core.loadRegistry();
                const s = reg.servers[target];
                if (!s) throw new Error(`服务器 "${target}" 未注册`);
                const r = await core.probe(s);
                if (flags.json) {
                    console.log(JSON.stringify(r.ok
                        ? { ok: true, name: target, tools: r.tools.length, ms: r.ms }
                        : { ok: false, name: target, error: r.error }, null, 2));
                    if (!r.ok) process.exitCode = 1;
                    return;
                }
                if (r.ok) console.log(`[${target}] OK · ${r.tools.length} tools · ${r.ms}ms`);
                else { console.error(`[${target}] FAILED: ${r.error}`); process.exitCode = 1; }
                return;
            }
            case 'call': return await cmdCall(a1, a2, rest[0], flags);
            default:
                console.error(`未知命令: ${cmd}\n`);
                console.log(USAGE);
                process.exitCode = 1;
        }
    } catch (e) {
        console.error('错误: ' + core.errText(e));
        process.exitCode = 1;
    }
}

main();