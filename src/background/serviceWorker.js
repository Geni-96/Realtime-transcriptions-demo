// Background service worker (MV3)
// Handles control messages and (for now) simulates transcript events.

console.log('[serviceWorker] loaded');

chrome.runtime.onInstalled.addListener(() => {
  console.log('[serviceWorker] onInstalled');
});

let running = false;
let intervalId = null;

function broadcast(message) {
  try {
    chrome.runtime.sendMessage(message);
  } catch (e) {
    console.warn('[serviceWorker] broadcast error', e);
  }
}

function setStatus(status) {
  broadcast({ source: 'serviceWorker', type: 'TRANSCRIPTION_STATUS', payload: { status } });
}

function startSimulation() {
  const samples = [
    'This is a realtime transcription demo.',
    'Speaking clearly improves accuracy.',
    'Short sentences arrive as chunks.',
    'Export will save the transcript to a text file.',
  ];
  let i = 0;
  intervalId = setInterval(() => {
    if (!running) return;
    const text = samples[i % samples.length];
    i += 1;
    broadcast({ source: 'serviceWorker', type: 'TRANSCRIPT_CHUNK', payload: { text } });
  }, 1500);
}

function stopSimulation() {
  if (intervalId) clearInterval(intervalId);
  intervalId = null;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.source === 'serviceWorker') return; // ignore own messages
  const { type } = message;
  if (type === 'START_TRANSCRIPTION') {
    if (!running) {
      running = true;
      setStatus('listening');
      startSimulation();
    }
    sendResponse?.({ ok: true });
  } else if (type === 'STOP_TRANSCRIPTION') {
    if (running) {
      running = false;
      stopSimulation();
      setStatus('stopped');
    }
    sendResponse?.({ ok: true });
  }
});
