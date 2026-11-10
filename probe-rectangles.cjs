const CDP = require('chrome-remote-interface');

async function main() {
  const client = await CDP({ target: 'ws://127.0.0.1:9222/devtools/page/604A88969C21BEB31EEE8125B72675C3' });
  try {
    const { Runtime } = client;
    await Runtime.enable();

    const { result: { value: rects } } = await Runtime.evaluate({
      expression: `(() => {
        const out = [];
        for (const el of document.querySelectorAll('[data-node-id]')) {
          const r = el.getBoundingClientRect();
          if (r.width > 10 && r.height > 10) {
            out.push({ nodeId: el.dataset.nodeId, x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) });
          }
        }
        return out.sort((a, b) => a.y - b.y || a.x - b.x);
      })()`,
      returnByValue: true
    });

    console.log(JSON.stringify({ count: rects.length, rects: rects.slice(0, 40) }, null, 2));
  } finally {
    await client.close();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
