import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const pty = require('node-pty');
const log = (msg) => { fs.writeSync(2, `[pty-smoke] ${msg}\n`); };
log('spawning...');
const p = pty.spawn(process.execPath, ['-e', 'console.log("hello from pty"); setTimeout(() => process.exit(0), 1500)'], {
  name: 'xterm-256color', cols: 80, rows: 24, cwd: process.cwd(), env: process.env
});
let out = '';
p.onData((d) => { out += d; });
p.onExit(({ exitCode }) => { log(`exit code=${exitCode} output=${JSON.stringify(out.slice(0, 200))}`); process.exit(0); });
setTimeout(() => { log('TIMEOUT waiting for pty exit'); process.exit(1); }, 10000);
