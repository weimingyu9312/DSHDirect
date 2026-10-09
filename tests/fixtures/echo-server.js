#!/usr/bin/env node
/*
 * A minimal stdio MCP server used by the test suite.
 *
 * Speaks just enough MCP over newline-delimited JSON-RPC on stdin/stdout to be
 * a real integration target for the stdio transport, without pulling in the
 * SDK. It is deliberately dependency-free so the suite runs on a bare checkout.
 *
 * Tools:
 *   echo     — returns its `text` argument (exercises round-tripping)
 *   add      — returns the sum of `a` and `b`
 *   boom     — fails on purpose, to exercise isError handling
 */
'use strict';

/** Tool catalogue advertised over tools/list. */
const TOOLS = [
    {
        name: 'echo',
        description: 'Echo back the provided text.',
        inputSchema: {
            type: 'object',
            properties: { text: { type: 'string', description: 'Text to echo.' } },
            required: ['text'],
        },
    },
    {
        name: 'add',
        description: 'Add two numbers.',
        inputSchema: {
            type: 'object',
            properties: {
                a: { type: 'number' },
                b: { type: 'number' },
            },
            required: ['a', 'b'],
        },
    },
    {
        name: 'boom',
        description: 'Always fails; used to test error propagation.',
        inputSchema: { type: 'object', properties: {} },
    },
];

/**
 * Execute one tool call.
 * @param {string} name
 * @param {object} args
 * @returns {{content: object[], isError?: boolean}}
 */
function callTool(name, args) {
    switch (name) {
        case 'echo':
            return { content: [{ type: 'text', text: JSON.stringify({ echoed: args.text }) }] };
        case 'add':
            return { content: [{ type: 'text', text: JSON.stringify({ sum: Number(args.a) + Number(args.b) }) }] };
        case 'boom':
            return { content: [{ type: 'text', text: 'intentional failure' }], isError: true };
        default:
            return { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true };
    }
}

/** @param {object} message @returns {object|null} response, or null for notifications. */
function handle(message) {
    const { id, method, params } = message;
    // Notifications carry no id and must not be answered.
    if (id === undefined || id === null) return null;

    switch (method) {
        case 'initialize':
            return {
                jsonrpc: '2.0',
                id,
                result: {
                    protocolVersion: (params && params.protocolVersion) || '2024-11-05',
                    capabilities: { tools: { listChanged: false } },
                    serverInfo: { name: 'dsh-mcp-direct-test-echo', version: '1.0.0' },
                },
            };
        case 'ping':
            return { jsonrpc: '2.0', id, result: {} };
        case 'tools/list':
            return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
        case 'tools/call':
            return { jsonrpc: '2.0', id, result: callTool(params && params.name, (params && params.arguments) || {}) };
        default:
            return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } };
    }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let message;
        try {
            message = JSON.parse(line);
        } catch (e) {
            continue;
        }
        const response = handle(message);
        if (response) process.stdout.write(JSON.stringify(response) + '\n');
    }
});
process.stdin.on('end', () => process.exit(0));
