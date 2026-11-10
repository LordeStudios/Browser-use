const fs = require('fs');
const { spawnSync } = require('child_process');
const p = 'C:/Users/london/Desktop/browser-use/browser-use/desktop/agent/desktopChatAgent.cjs';
let s = fs.readFileSync(p, 'utf8');
const from = [
  '          if (run.eagerResults instanceof Map && run.eagerResults.has(hash)) {',
  '            run.eagerResults.delete(hash);',
  '            if (mutation) latestObservation = null;',
  '            continue;',
  '          }'
].join('\n');
const to = [
  '          if (run.eagerResults instanceof Map && run.eagerResults.has(hash)) {',
  '            const eagerEntry = run.eagerResults.get(hash);',
  '            run.eagerResults.delete(hash);',
  '            const eagerOutput = eagerEntry && typeof eagerEntry === \'object\' && eagerEntry.output !== undefined ? eagerEntry.output : eagerEntry;',
  '            if (eagerOutput && typeof eagerOutput === \'object\') {',
  '              // A consumed eager result must be recorded exactly like the',
  '              // fill-proof path above: without this.record the ledger has no',
  '              // result for the call and settle() truthfully stubs it as',
  '              // "was not executed" even though it ran eagerly.',
  '              this.record(run, call, eagerOutput);',
  '              this.publish(\'tool.result\', run, { tool: call.name, output: eagerOutput, inspection: { input: inspectionValue(call.name, call.input), output: inspectionValue(call.name, eagerOutput) } });',
  '              if (mutation) latestObservation = null;',
  '              continue;',
  '            }',
  '            // No consumable eager output: never silently drop the call —',
  '            // fall through so it executes normally and gets recorded.',
  '          }'
].join('\n');
const count = s.split(from).length - 1;
if (count !== 1) { console.log('ANCHOR-COUNT ' + count + ' (want 1) — ABORT'); process.exit(1); }
s = s.replace(from, to);
fs.writeFileSync(p, s);
const back = fs.readFileSync(p, 'utf8');
const i = back.indexOf('const eagerEntry');
console.log('READ-BACK:\n' + back.slice(i - 140, i + 1200));
const chk = spawnSync(process.execPath, ['--check', p], { encoding: 'utf8' });
console.log('SYNTAX: ' + (chk.status === 0 ? 'SYNTAX-OK' : 'SYNTAX-FAIL ' + chk.stderr));
