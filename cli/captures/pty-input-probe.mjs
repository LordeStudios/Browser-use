import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const pty = require('node-pty');
const mode = process.argv[2] || 'conpty';
const log = (m) => fs.writeSync(2, `[probe:${mode}] ${m}\n`);
const opts = { name: 'xterm-256color', cols: 100, rows: 28, cwd: process.cwd(), env: process.env };
if (mode === 'winpty') opts.useConpty = false;
const p = pty.spawn(process.execPath, ['-e', `
  process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  let buf = '';
  process.stdin.on('data', (d) => {
    buf += JSON.stringify(d);
    process.stdout.write('GOT:' + JSON.stringify(d).slice(0, 120) + '\\r\\n');
    if (buf.length > 400) process.exit(0);
  });
  console.log('READY');
`], opts);
let out = '';
p.onData((d) => { out += d; if (out.includes('READY')) { p.write('abc\r'); setTimeout(() => p.write('def\r'), 400); } });
p.onExit(() => { log('done'); process.exit(0); });
setTimeout(() => { log(`TIMEOUT. captured: ${out.slice(0, 400)}`); process.exit(1); }, 8000);
