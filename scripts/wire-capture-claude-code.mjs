// Captures the exact request Claude Code sends to its model for a task, so it
// can be compared with what the Browser-use harness sends (wire-capture.mjs).
//
// A local listener plays the Anthropic API: claude.exe is pointed at it through
// ANTHROPIC_BASE_URL, every request body is recorded, and a minimal valid reply
// ends the turn. No real model is called and no credentials leave this machine
// (the token handed to the child is a dummy).
//
//   node scripts/wire-capture-claude-code.mjs "<task text>" [name]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const { breakdownRequest } = require(path.join(root, 'desktop/agent/wireTokenizer.cjs'));

const task = process.argv[2] || 'hello';
const name = process.argv[3] || 'claude-code';
const executable = process.env.CLAUDE_CODE_EXE || path.join(os.homedir(), '.local/bin/claude.exe');
const outDir = path.join(root, 'output', 'wire-capture');
fs.mkdirSync(outDir, { recursive: true });
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bu-cc-capture-'));

const captured = [];
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    let body = null;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not JSON */ }
    captured.push({ method: req.method, url: req.url, body });
    if (!body || !/\/v1\/messages/.test(req.url) || req.url.includes('count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.url.includes('count_tokens') ? { input_tokens: 1 } : {}));
      return;
    }
    const id = 'msg_capture';
    const message = { id, type: 'message', role: 'assistant', model: body.model || 'capture', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      send('message_start', { type: 'message_start', message });
      send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'captured' } });
      send('content_block_stop', { type: 'content_block_stop', index: 0 });
      send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
      send('message_stop', { type: 'message_stop' });
      res.end();
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ...message, content: [{ type: 'text', text: 'captured' }], stop_reason: 'end_turn' }));
    }
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const env = { ...process.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_AUTH_TOKEN: 'dummy-capture-token' };
delete env.ANTHROPIC_API_KEY; delete env.CLAUDECODE; delete env.CLAUDE_CODE_ENTRYPOINT; delete env.ELECTRON_RUN_AS_NODE;

// ~/.claude/settings.json carries its own ANTHROPIC_BASE_URL and token, and
// settings beat process env. Without these two flags the child talks to the
// REAL gateway with the user's real token instead of this listener (it did, once,
// during development). --setting-sources drops user settings; --settings pins the
// listener and a dummy token on top as a second guard.
const pinned = JSON.stringify({ env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_AUTH_TOKEN: 'dummy-capture-token' } });
const args = ['--safe-mode', '--setting-sources', 'project', '--settings', pinned, '--strict-mcp-config', '--no-session-persistence', '--no-chrome', '--print', task];
const child = spawn(executable, args, { cwd: sandbox, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let stderr = '';
child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
child.stdout.resume();
const timer = setTimeout(() => {
  if (process.platform === 'win32') spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else child.kill('SIGTERM');
}, 90_000);
await new Promise((resolve) => child.on('close', resolve));
clearTimeout(timer);
server.close();

const requests = captured.filter((entry) => entry.body && /\/v1\/messages/.test(entry.url) && !entry.url.includes('count_tokens'));
if (!requests.length) {
  console.log(`no model request was captured. seen: ${captured.map((e) => `${e.method} ${e.url}`).join(', ') || 'nothing'}\nstderr: ${stderr.trim().slice(-600)}`);
  process.exit(1);
}
// The agent turn is the request with tools and the largest body; the others are
// small side calls (title generation, quota checks).
const main = [...requests].sort((a, b) => JSON.stringify(b.body).length - JSON.stringify(a.body).length)[0].body;
fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify(main, null, 2));
const report = breakdownRequest(main, {});
console.log(`${requests.length} model request(s) captured; the main one is ~${report.totals.tokens.toLocaleString()} tokens, model=${main.model}`);
for (const part of [...report.parts].sort((a, b) => b.tokens - a.tokens).slice(0, 8)) console.log(`  ${part.label.padEnd(44)} ${String(part.tokens).padStart(6)} tokens  ${part.directives} directives`);
console.log(`saved ${path.join(outDir, `${name}.json`)}`);
