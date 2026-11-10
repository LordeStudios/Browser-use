#!/usr/bin/env node
// Fake agent-cli for the queueing E2E (tui.test.mjs + debug driver): honors
// the stdin control protocol — logs every queue line, emits a
// continuation-start trace event per queued message after its first terminal
// state, then exits 0.
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf('--' + name); return i === -1 ? null : args[i + 1]; };
const outDir = arg('out-dir');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'started'), String(process.pid));
const tracePath = path.join(outDir, 'trace.jsonl');
const trace = (event) => fs.appendFileSync(tracePath, JSON.stringify({ ts: Date.now(), ...event }) + '\n');
trace({ type: 'harness.boot', phase: 'modules', ms: 1 });
const queuedTexts = [];
let buffer = '';
process.stdin.setEncoding('utf8');
const sink = fs.createWriteStream(path.join(outDir, 'queue.jsonl'), { flags: 'a' });
process.stdin.on('data', (chunk) => {
  buffer += String(chunk);
  let index;
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    sink.write(line + '\n');
    try { const parsed = JSON.parse(line); if (parsed.type === 'queue' && parsed.text) queuedTexts.push(parsed.text); } catch {}
  }
});
process.stdin.on('error', () => {});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
setTimeout(async () => {
  // Terminal state reached: drain the queue as continuations (one trace
  // event each — the TUI's tailer renders a clean continuation card).
  for (const text of queuedTexts) {
    trace({ type: 'harness.continuation.started', task: text, remaining: Math.max(0, queuedTexts.length - queuedTexts.indexOf(text) - 1), conversationId: 'fake-conv' });
    await sleep(120);
  }
  fs.writeFileSync(path.join(outDir, 'final-state.json'), JSON.stringify({
    status: 'completed',
    meta: { exitCode: 0, elapsedMs: 2000, runId: 'fake-conv' },
    counts: { decisionCount: 2, stepCount: 2, traceLines: 3, toolResultEvents: 0 },
    toolCallCount: 0,
    toolCalls: [],
    result: { ok: true, summary: 'fake run completed' },
    state: { status: 'completed', id: 'fake-conv' }
  }, null, 2));
  console.log(JSON.stringify({ ok: true, runId: 'fake-conv', status: 'completed', elapsedMs: 2000, outDir }, null, 2));
  process.exit(0);
}, 2500);
