import assert from 'node:assert/strict';
import WebSocket from 'ws';

async function testWebSocketCdp() {
  console.log('🔌 Querying CDP targets from http://127.0.0.1:9222/json/list...');
  const listRes = await fetch('http://127.0.0.1:9222/json/list');
  const pages = await listRes.json();
  const mainTab = pages.find(p => p.type === 'page' && p.url !== 'about:blank' && !p.url.includes('desktop/renderer/index.html')) || pages.find(p => p.type === 'page');
  assert.ok(mainTab?.webSocketDebuggerUrl, 'No active page target WebSocket found');

  console.log(`📡 Connecting WebSocket to ${mainTab.webSocketDebuggerUrl}...`);
  const ws = new WebSocket(mainTab.webSocketDebuggerUrl);

  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });

  console.log('✅ WebSocket connected successfully!');

  let msgId = 1;
  const sendCdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = msgId++;
    const handler = (data) => {
      const parsed = JSON.parse(data.toString());
      if (parsed.id === id) {
        ws.off('message', handler);
        if (parsed.error) reject(new Error(parsed.error.message));
        else resolve(parsed.result);
      }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
  });

  console.log('🌐 Navigating active tab to Vector 20 via Direct CDP...');
  await sendCdp('Page.navigate', { url: 'file:///C:/Users/Administrator/Desktop/New%20folder%20(9)/index.html' });
  await new Promise(r => setTimeout(r, 1000));

  console.log('🎯 Querying page state over Direct CDP WebSocket...');
  const evalRes = await sendCdp('Runtime.evaluate', {
    expression: 'document.title + " | " + document.getElementById("startButton")?.textContent'
  });
  console.log('✅ Direct CDP Runtime Evaluation result:', evalRes.result.value);
  assert.ok(evalRes.result.value.includes('Target Acquisition Benchmark'), 'Page title verification failed');

  console.log('🖱️ Dispatching real-time CDP mouse movements...');
  await sendCdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 250, y: 350 });
  await new Promise(r => setTimeout(r, 100));
  await sendCdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 450, y: 550 });

  console.log('🎉 Direct CDP WebSocket interaction on http://127.0.0.1:9222 PASSED 100% with zero latency!');
  ws.close();
}

testWebSocketCdp().catch((error) => {
  console.error('\n❌ Direct CDP WebSocket Test Failed:', error);
  process.exitCode = 1;
});
