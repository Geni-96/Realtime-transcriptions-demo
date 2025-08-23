// Background service worker (MV3)
// Handles control messages, starts tab audio capture, and integrates with Gemini for STT.

console.log('[serviceWorker] loaded');

chrome.runtime.onInstalled.addListener(() => {
  console.log('[serviceWorker] onInstalled');
  try {
    // Make the toolbar icon open our side panel when clicked
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (_) {}
});

import { postSegmentToBackground } from '../audio/audioCapture.js';
// Developer config (do not commit secrets). Create src/background/config.js from config.example.js
let GEMINI_CONFIG = { apiKey: 'AIzaSyAi5fFFnBjvmbrLIFI_J-6KanD5mFcx1VI', model: 'gemini-2.5-flash' };

async function loadGeminiConfig() {
  try {
    // eslint-disable-next-line import/no-unresolved
    // @ts-ignore
    const mod = await import('./config.js');
    if (mod?.GEMINI_CONFIG) GEMINI_CONFIG = mod.GEMINI_CONFIG;
  } catch (e) {
    console.warn('[serviceWorker] No config.js found. Using defaults from example.');
  }
}

loadGeminiConfig();

let running = false; // transcription running state
let tabCaptures = new Map(); // tabIdOrActive -> capture controller
let gemini = { apiKey: GEMINI_CONFIG.apiKey || null, model: GEMINI_CONFIG.model || 'gemini-2.5-flash' };
let segmentQueue = [];
let processing = false;

// Side Panel visibility control: enable on http/https pages; disable on chrome/internal pages
function isHttpUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}

async function updateSidePanelForTab(tab) {
  if (!tab || typeof tab.id !== 'number') return;
  const enable = !!isHttpUrl(tab.url);
  try {
    await chrome.sidePanel.setOptions({
      tabId: tab.id,
      enabled: enable,
      path: 'src/sidepanel/sidepanel.html',
    });
  } catch (e) {
    // setOptions can throw if the tab is closing; ignore
  }
}

async function refreshAllTabsSidePanel() {
  try {
    const tabs = await chrome.tabs.query({});
    await Promise.all(tabs.map(updateSidePanelForTab));
  } catch (e) {
    console.warn('[serviceWorker] refreshAllTabsSidePanel error', e);
  }
}

// Initialize side panel enablement on startup
refreshAllTabsSidePanel();

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!tab) return;
  if ('url' in changeInfo || changeInfo.status === 'complete') {
    updateSidePanelForTab(tab);
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try { const tab = await chrome.tabs.get(tabId); updateSidePanelForTab(tab); } catch (_) {}
});

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

// Simulation removed: only real transcripts from Gemini are broadcast.

// Storage is not used for Gemini config anymore; developers provide config.js.

// Call Gemini GenerateContent with audio parts and return text
async function callGeminiTranscribe({ chunks, mimeType, label, seq }) {
  if (!gemini.apiKey) throw new Error('Gemini API key not set');
  const model = gemini.model || 'gemini-2.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(gemini.apiKey)}`;
  const parts = [
    { text: 'Transcribe the following audio into plain text. Respond with transcript only.' },
    ...chunks.map((c) => ({ inline_data: { mime_type: mimeType || 'audio/webm', data: c.base64 } })),
  ];
  const body = { contents: [{ role: 'user', parts }] };
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => String(resp.status));
    throw new Error(`Gemini error ${resp.status}: ${txt}`);
  }
  const data = await resp.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join(' ').trim();
  if (!text) throw new Error('No transcript returned');
  return { text, label, seq };
}

async function processQueue() {
  if (processing) return;
  processing = true;
  try {
    while (segmentQueue.length > 0 && running) {
      const seg = segmentQueue.shift();
      try {
        setStatus('listening');
        const { text } = await callGeminiTranscribe(seg);
        // Use now as receipt timestamp; could be improved by computing start time from seq/segment durations.
        const ts = Date.now();
        broadcast({ source: 'serviceWorker', type: 'TRANSCRIPT_CHUNK', payload: { text, ts } });
      } catch (e) {
        console.warn('[serviceWorker] Gemini STT failed', e);
        broadcast({ source: 'serviceWorker', type: 'TRANSCRIPTION_ERROR', payload: { message: 'Transcription error', detail: String(e?.message || e) } });
      }
    }
  } finally {
    processing = false;
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.source === 'serviceWorker') return; // ignore own messages
  const { type, payload } = message;
  if (type === 'START_TRANSCRIPTION') {
    // payload: { source: 'tab'|'mic'|'tab+mic'|'multi-tab', tabIds?: number[] }
    if (!running) {
      running = true;
      setStatus('listening');
    }
  // Sidepanel owns capture (tab/mic/share). Background only processes segments.
    sendResponse?.({ ok: true });
  } else if (type === 'STOP_TRANSCRIPTION') {
    if (running) {
      running = false;
      setStatus('stopped');
    }
  // Nothing to stop in background; sidepanel controls capture lifecycles.
    sendResponse?.({ ok: true });
  } else if (type === 'AUDIO_CHUNK' && message.source === 'audioCapture') {
    // Chunks bridged from sidepanel (e.g., microphone). In a real app, forward to ASR here.
    // For now, we just acknowledge and could aggregate/measure.
    // Optionally, broadcast to other UIs for debugging.
    // broadcast({ source: 'serviceWorker', type: 'AUDIO_CHUNK', payload });
    sendResponse?.({ ok: true });
  } else if (type === 'AUDIO_SEGMENT' && message.source === 'audioCapture') {
    // Enqueue for transcription; structure: { chunks: [{base64, ms}], mimeType, source, label, totalMs, overlapMs, seq }
    if (!running) { sendResponse?.({ ok: false, reason: 'not-running' }); return; }
    segmentQueue.push(payload);
    processQueue();
    sendResponse?.({ ok: true });
  }
});

// No dynamic config load; using static developer config.
