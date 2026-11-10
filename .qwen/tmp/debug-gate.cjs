const fs = require('fs');
const log = (line) => fs.writeSync(1, `${line}\n`);
const { DesktopChatAgent } = require('../../desktop/agent/desktopChatAgent.cjs');
const controller = {
  async domSnapshot() { return { url: 'https://example.test/', title: 'Example', viewport: { width: 1280, height: 720 }, elements: [{ index: 0, tag: 'button', name: 'Save', text: 'Save', enabled: true }], truncated: false }; },
  navigationState() { return { url: 'https://example.test/', loading: false }; },
  consoleEntries() { return []; },
  networkEntries() { return []; },
  async clickElement(tabId, args, owner) { return { tabId, ...args }; },
  async screenshot() { return { data: 'base64-image' }; },
  type() { return { length: 0 }; },
  async scroll() { return {}; },
  key() { return {}; },
  releaseSessionInput() { return { released: true }; }
};
let decisions = 0;
const agent = new DesktopChatAgent({
  controller,
  getSelectedTabId: () => 'tab-1',
  emit: (e) => { log(`EVT ${e.type}`); },
  createProvider: () => ({ async complete() {
    decisions += 1;
    log(`decision ${decisions}`);
    if (decisions > 6) throw new Error('TEST BOUND: too many decisions');
    if (decisions === 1) return { toolCalls: [{ name: 'browser_click', input: { element: 0 } }] };
    return { done: { summary: 'The requested form step is complete.', success: true, verified: true } };
  } })
});
const t = setTimeout(() => { log('TIMEOUT-DEBUG run still live, decisions:' + decisions); process.exit(2); }, 15000);
agent.start({ task: 'Fill Full name "Max Test" in the open form and verify the page shows the saved name.', provider: { id: 'mock' } })
  .then((run) => {
    log('status: ' + run.status + ' result: ' + JSON.stringify(run.result));
    log('failed entries: ' + JSON.stringify(run.history.filter(h => h.output && h.output.ok === false).map(h => `${h.tool}:${h.output.recoverySource || ''}:${String(h.output.error || '').slice(0, 150)}`)));
    clearTimeout(t); process.exit(0);
  })
  .catch((e) => { log('ERR: ' + e.message); process.exit(1); });
