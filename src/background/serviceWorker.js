// Background service worker (MV3)
// Handles control messages, starts tab audio capture, and simulates transcript events.

console.log('[serviceWorker] loaded');

chrome.runtime.onInstalled.addListener(() => {
  console.log('[serviceWorker] onInstalled');
});

import { startTabCapture } from '../audio/audioCapture.js';

let running = false; // transcription running state
let intervalId = null; // simulation interval
let tabCaptures = new Map(); // tabIdOrActive -> capture controller

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
  const { type, payload } = message;
  if (type === 'START_TRANSCRIPTION') {
    // payload: { source: 'tab'|'mic'|'tab+mic'|'multi-tab', tabIds?: number[] }
    if (!running) {
      running = true;
      setStatus('listening');
      startSimulation(); // keep demo transcript flowing
    }
    // Start tab capture(s) if requested
    if (payload?.source === 'tab' || payload?.source === 'tab+mic' || payload?.source === 'multi-tab') {
      const tabIds = Array.isArray(payload?.tabIds) && payload.tabIds.length ? payload.tabIds : [null]; // null => active tab
      tabIds.forEach(async (tid) => {
        const key = tid ?? 'active';
        if (tabCaptures.has(key)) return; // already capturing
        try {
          const controller = await startTabCapture({
            targetTabId: tid ?? undefined,
            onChunk: ({ blob, mimeType, source, label }) => {
              // Forward raw audio chunks to any listeners or a backend (future)
              blob.arrayBuffer().then((ab) => {
                const base64 = btoa(String.fromCharCode(...new Uint8Array(ab)));
                broadcast({ source: 'serviceWorker', type: 'AUDIO_CHUNK', payload: { base64, mimeType, source, label } });
              }).catch((e) => console.warn('[serviceWorker] arrayBuffer failed', e));
            },
          });
          tabCaptures.set(key, controller);
          console.log('[serviceWorker] tab capture started', key);
        } catch (e) {
          console.warn('[serviceWorker] tab capture failed', e);
        }
      });
    }
    sendResponse?.({ ok: true });
  } else if (type === 'STOP_TRANSCRIPTION') {
    if (running) {
      running = false;
      stopSimulation();
      setStatus('stopped');
    }
    // Stop all tab captures
    for (const [key, ctrl] of tabCaptures.entries()) {
      try { ctrl.stop(); } catch (_) {}
      tabCaptures.delete(key);
      console.log('[serviceWorker] tab capture stopped', key);
    }
    sendResponse?.({ ok: true });
  } else if (type === 'AUDIO_CHUNK' && message.source === 'audioCapture') {
    // Chunks bridged from sidepanel (e.g., microphone). In a real app, forward to ASR here.
    // For now, we just acknowledge and could aggregate/measure.
    // Optionally, broadcast to other UIs for debugging.
    // broadcast({ source: 'serviceWorker', type: 'AUDIO_CHUNK', payload });
    sendResponse?.({ ok: true });
  }
});
