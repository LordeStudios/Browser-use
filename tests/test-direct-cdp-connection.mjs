import assert from 'node:assert/strict';

async function testDirectCdp() {
  console.log('🔌 Querying Direct CDP endpoint http://127.0.0.1:9222/json/version...');
  const versionRes = await fetch('http://127.0.0.1:9222/json/version');
  assert.equal(versionRes.ok, true, `CDP version endpoint failed with HTTP ${versionRes.status}`);
  const versionData = await versionRes.json();
  console.log('✅ CDP Version Info:', JSON.stringify(versionData, null, 2));

  console.log('\n📋 Querying active CDP target pages http://127.0.0.1:9222/json/list...');
  const listRes = await fetch('http://127.0.0.1:9222/json/list');
  assert.equal(listRes.ok, true, `CDP list endpoint failed with HTTP ${listRes.status}`);
  const pages = await listRes.json();
  console.log(`✅ Found ${pages.length} active CDP targets:`);
  pages.forEach((p, i) => {
    console.log(`   [${i}] ${p.type} | title: "${p.title}" | url: ${p.url} | ws: ${p.webSocketDebuggerUrl}`);
  });

  const pageTarget = pages.find(p => p.type === 'page');
  assert.ok(pageTarget, 'No page target found on CDP port 9222');
  assert.ok(pageTarget.webSocketDebuggerUrl, 'No webSocketDebuggerUrl available for page target');

  console.log('\n🎉 Direct CDP Connection test on http://127.0.0.1:9222 PASSED 100%!');
}

testDirectCdp().catch((error) => {
  console.error('\n❌ Direct CDP Test Failed:', error);
  process.exitCode = 1;
});
