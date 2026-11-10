const LOCAL_SERVER = 'http://127.0.0.1:8765';

function targetFor(tab) {
  if (!tab?.id || !tab.url) throw new Error('Select a normal browser tab before pairing');
  return {
    browserInstanceId: chrome.runtime.id,
    tabId: tab.id,
    cdpTargetId: `extension-tab-${tab.id}`,
    url: tab.url,
    title: tab.title || ''
  };
}

async function createOffer() {
  const response = await fetch(`${LOCAL_SERVER}/pairing/offer`, { method: 'POST' });
  if (!response.ok) throw new Error('Browser-use is not running on the local pairing port');
  const payload = await response.json();
  if (!payload?.offer?.pairingCode) throw new Error('Browser-use did not return a pairing offer');
  return payload.offer;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'pair-active-tab') return undefined;
  (async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const target = targetFor(tab);
    const offer = await createOffer();
    await chrome.storage.session.set({ pendingPairing: { pairingCode: offer.pairingCode, target, expiresAt: offer.expiresAt } });
    await chrome.action.setBadgeText({ tabId: tab.id, text: 'PAIR' });
    await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: '#e84b5b' });
    sendResponse({ ok: true, offer: { instanceId: offer.instanceId, expiresAt: offer.expiresAt }, target });
  })().catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
});
