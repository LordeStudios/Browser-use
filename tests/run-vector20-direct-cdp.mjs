import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';

async function runVector20OverDirectCdp() {
  console.log('🔌 Connecting to Direct CDP endpoint http://127.0.0.1:9222/json/list...');
  const listRes = await fetch('http://127.0.0.1:9222/json/list');
  const pages = await listRes.json();
  const targetPage = pages.find(p => p.type === 'page' && !p.url.includes('desktop/renderer/index.html')) || pages.find(p => p.type === 'page');
  assert.ok(targetPage?.webSocketDebuggerUrl, 'No active page target found on CDP port 9222');

  console.log(`📡 Connecting WebSocket to ${targetPage.webSocketDebuggerUrl}...`);
  const ws = new WebSocket(targetPage.webSocketDebuggerUrl);

  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });

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

  const indexPath = path.resolve('C:/Users/Administrator/Desktop/New folder (9)/index.html');
  const targetUrl = pathToFileURL(indexPath).href;
  console.log(`🌐 Navigating active desktop tab to ${targetUrl}...`);
  await sendCdp('Page.navigate', { url: targetUrl });
  await new Promise(r => setTimeout(r, 1200));

  console.log('▶️ Clicking Begin 20-stage benchmark button via Direct CDP...');
  const startBtnPos = await sendCdp('Runtime.evaluate', {
    returnByValue: true,
    expression: `(() => {
      const btn = document.getElementById('startButton');
      if (!btn) return null;
      const rect = btn.getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    })()`
  });

  const btnCoords = startBtnPos.result.value;
  assert.ok(btnCoords, 'Start button not found in page');

  await sendCdp('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, x: btnCoords.x, y: btnCoords.y });
  await sendCdp('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: btnCoords.x, y: btnCoords.y });

  console.log('🎯 Running 20-stage Target Acquisition Benchmark over Direct CDP WebSocket...');

  let lastReportedStage = -1;
  const startTime = Date.now();

  while (Date.now() - startTime < 120_000) {
    const pageState = await sendCdp('Runtime.evaluate', {
      returnByValue: true,
      expression: `(() => {
        const results = document.getElementById('resultsView');
        if (results && !results.classList.contains('hidden')) return { done: true };
        const arena = document.getElementById('arena');
        if (!arena || arena.dataset.state !== 'active') return { waiting: true };
        const target = arena.querySelector('.target');
        if (!target) return { waiting: true };
        const rect = target.getBoundingClientRect();
        const state = window.__v20State;
        return {
          done: false,
          stageIndex: state ? state.stageIndex : 0,
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
          label: target.getAttribute('aria-label')
        };
      })()`
    });

    const info = pageState.result.value;
    if (info.done) {
      console.log('🏆 All 20 stages completed successfully!');
      break;
    }

    if (info.waiting || !info.x || !info.y) {
      await new Promise(r => setTimeout(r, 100));
      continue;
    }

    const currentStage = info.stageIndex + 1;
    if (currentStage !== lastReportedStage) {
      console.log(`  ➔ Active Stage ${currentStage}/20 [Target: ${info.label}]`);
      lastReportedStage = currentStage;
    }

    // Direct low-latency CDP mouse move & click dispatch
    await sendCdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: info.x, y: info.y });
    await sendCdp('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, x: info.x, y: info.y });
    await sendCdp('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: info.x, y: info.y });

    await new Promise(r => setTimeout(r, 1050));
  }

  // Verify final results view
  const resultsState = await sendCdp('Runtime.evaluate', {
    returnByValue: true,
    expression: `(() => {
      const results = document.getElementById('resultsView');
      const desc = document.getElementById('resultsDescription');
      const rows = document.querySelectorAll('#resultRows tr');
      return {
        visible: results && !results.classList.contains('hidden'),
        description: desc ? desc.textContent : '',
        completedRows: rows ? rows.length : 0
      };
    })()`
  });

  const res = resultsState.result.value;
  console.log('\n📊 Vector 20 Final Results Summary over Direct CDP:');
  console.log(`   - Results View Visible: ${res.visible}`);
  console.log(`   - Summary: ${res.description}`);
  console.log(`   - Completed Rows: ${res.completedRows}/20`);

  assert.equal(res.visible, true, 'Results view should be visible at end of run');
  assert.equal(res.completedRows, 20, 'All 20 stages should have completed result rows');

  console.log('\n✅ Vector 20 Target Acquisition Benchmark test over Direct CDP PASSED 100% with perfection!');
  ws.close();
}

runVector20OverDirectCdp().catch((error) => {
  console.error('\n❌ Direct CDP Vector 20 Test Failed:', error);
  process.exitCode = 1;
});
