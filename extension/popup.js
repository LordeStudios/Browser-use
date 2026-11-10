const status = document.querySelector('#status');
const pair = document.querySelector('#pair');

function setStatus(message) {
  status.textContent = message;
}

pair.addEventListener('click', async () => {
  pair.disabled = true;
  setStatus('Creating one-time local pairing offer…');
  try {
    const result = await chrome.runtime.sendMessage({ type: 'pair-active-tab' });
    if (!result?.ok) throw new Error(result?.error || 'Pairing failed');
    setStatus(`Pairing code copied for tab ${result.target.tabId}. It expires at ${new Date(result.offer.expiresAt).toLocaleTimeString()}.`);
  } catch (error) {
    setStatus(error.message);
    pair.disabled = false;
  }
});
