// Background service worker (MV3)
// Handles control messages, starts tab audio capture, and integrates with Gemini for STT.

console.log('[serviceWorker] loaded');

chrome.runtime.onInstalled.addListener(() => {
  console.log('[serviceWorker] onInstalled');
});

import { startTabCapture, postSegmentToBackground } from '../audio/audioCapture.js';

let running = false; // transcription running state
let intervalId = null; // simulation interval
let tabCaptures = new Map(); // tabIdOrActive -> capture controller
let gemini = { apiKey: null, model: 'gemini-1.5-flash' }; // model configurable, default to widely available
let segmentQueue = [];
let processing = false;

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

// Load Gemini config from storage
async function loadGeminiConfig() {
  try {
    const { geminiApiKey, geminiModel } = await chrome.storage.local.get(['geminiApiKey', 'geminiModel']);
    gemini.apiKey = geminiApiKey || null;
    if (geminiModel && typeof geminiModel === 'string') gemini.model = geminiModel;
  } catch (_) {}
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.geminiApiKey) gemini.apiKey = changes.geminiApiKey.newValue || null;
  if (changes.geminiModel) gemini.model = changes.geminiModel.newValue || gemini.model;
});

// Call Gemini GenerateContent with audio parts and return text
async function callGeminiTranscribe({ chunks, mimeType, label, seq }) {
  if (!gemini.apiKey) throw new Error('Gemini API key not set');
  const model = gemini.model || 'gemini-1.5-flash';
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
        broadcast({ source: 'serviceWorker', type: 'TRANSCRIPT_CHUNK', payload: { text } });
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
              // Optional: still broadcast per-chunk for debugging/UX
              blob.arrayBuffer().then((ab) => {
                const base64 = btoa(String.fromCharCode(...new Uint8Array(ab)));
                broadcast({ source: 'serviceWorker', type: 'AUDIO_CHUNK', payload: { base64, mimeType, source, label } });
              }).catch((e) => console.warn('[serviceWorker] arrayBuffer failed', e));
            },
            onSegment: (segment) => {
              // Send larger, overlapped 30s segments to backend (future)
              postSegmentToBackground(segment);
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
  } else if (type === 'AUDIO_SEGMENT' && message.source === 'audioCapture') {
    // Enqueue for transcription; structure: { chunks: [{base64, ms}], mimeType, source, label, totalMs, overlapMs, seq }
    if (!running) { sendResponse?.({ ok: false, reason: 'not-running' }); return; }
    segmentQueue.push(payload);
    processQueue();
    sendResponse?.({ ok: true });
  }
});

// Initialize config on service worker load
loadGeminiConfig();
