#!/usr/bin/env node
// GEN9 test fixture: a tiny stdio MCP server speaking newline-delimited
// JSON-RPC 2.0 (initialize / notifications/initialized / tools/list /
// tools/call / ping). Used by tests/gen9-mcp.test.mjs. Exits when stdin ends.
'use strict';

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf('\n');
    if (newline < 0) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) handleMessage(line);
  }
});
process.stdin.on('end', () => process.exit(0));

const TOOLS = [
  {
    name: 'echo',
    description: 'Echo the given text back',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
  },
  {
    name: 'add',
    description: 'Add two numbers',
    inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] }
  }
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handleMessage(line) {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id === undefined || message.id === null) return; // notification
  const id = message.id;
  try {
    if (message.method === 'initialize') {
      send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'mini-mcp', version: '1.0.0' } } });
      return;
    }
    if (message.method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      return;
    }
    if (message.method === 'tools/call') {
      const name = message.params?.name;
      const args = message.params?.arguments || {};
      if (name === 'echo') {
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `echo: ${args.text ?? ''}` }], isError: false } });
      } else if (name === 'add') {
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(Number(args.a) + Number(args.b)) }], isError: false } });
      } else {
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `unknown tool ${name}` }], isError: true } });
      }
      return;
    }
    if (message.method === 'ping') {
      send({ jsonrpc: '2.0', id, result: {} });
      return;
    }
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${message.method}` } });
  } catch (error) {
    send({ jsonrpc: '2.0', id, error: { code: -32603, message: error.message } });
  }
}
