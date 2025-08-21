// Side panel UI logic
// Accessible controls, status, timer, transcript stream (real-time), export & copy.
import { startMicCapture, postChunkToBackground, postSegmentToBackground } from '../audio/audioCapture.js';

const state = {
  running: false,
  startTs: null,
  timerInterval: null,
  transcript: [], // [{ text, tsISO }]
  source: 'tab',
  micCapture: null,
};

function setStatus(status) {
  const app = document.getElementById('app');
  const statusText = document.getElementById('status-text');
  app?.classList.remove('is-stopped', 'is-listening', 'is-paused');
  switch (status) {
    case 'listening':
      app?.classList.add('is-listening');
      statusText.textContent = 'Listening';
      break;
    case 'paused':
      app?.classList.add('is-paused');
      statusText.textContent = 'Paused';
      break;
    default:
      app?.classList.add('is-stopped');
      statusText.textContent = 'Stopped';
  }
}

function formatTime(ms) {
  const s = Math.floor(ms / 1000);
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function startTimer() {
  const timerEl = document.getElementById('timer');
  state.startTs = Date.now();
  timerEl.textContent = '00:00';
  state.timerInterval = setInterval(() => {
    timerEl.textContent = formatTime(Date.now() - state.startTs);
  }, 1000);
}

function stopTimer() {
  const timerEl = document.getElementById('timer');
  if (state.timerInterval) clearInterval(state.timerInterval);
  state.timerInterval = null;
  state.startTs = null;
  timerEl.textContent = '00:00';
}

function renderTranscriptChunk({ text, tsISO }) {
  const container = document.getElementById('transcript');
  const p = document.createElement('p');
  const time = document.createElement('span');
  time.className = 'time';
  const dt = tsISO ? new Date(tsISO) : new Date();
  time.textContent = `[${dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}] `;
  time.setAttribute('aria-hidden', 'true');
  const textNode = document.createTextNode(text);
  p.appendChild(time);
  p.appendChild(textNode);
  container.appendChild(p);
}

function appendTranscript(text, ts = Date.now()) {
  if (!text) return;
  const tsISO = new Date(ts).toISOString();
  state.transcript.push({ text, tsISO });
  renderTranscriptChunk({ text, tsISO });
  // Auto-scroll to latest
  const container = document.getElementById('transcript');
  container.scrollTop = container.scrollHeight;
}

function clearTranscript() {
  state.transcript = [];
  const container = document.getElementById('transcript');
  container.innerHTML = '';
}

function exportTxt() {
  const lines = state.transcript.map((c) => {
    const t = new Date(c.tsISO);
    const stamp = t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    return `[${stamp}] ${c.text}`;
  });
  const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  a.download = `transcript-${ts}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function copyTranscript() {
  const text = state.transcript
    .map((c) => {
      const t = new Date(c.tsISO);
      const stamp = t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      return `[${stamp}] ${c.text}`;
    })
    .join('\n');
  try {
    await navigator.clipboard.writeText(text);
    announce('Transcript copied to clipboard');
  } catch (e) {
    // Fallback: create a temporary textarea
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (ok) announce('Transcript copied to clipboard');
  }
}

function announce(msg) {
  const sr = document.getElementById('sr-alert');
  if (!sr) return;
  sr.textContent = '';
  // force change for screen readers
  setTimeout(() => { sr.textContent = msg; }, 30);
}

async function sendCommand(command, payload) {
  try {
    const resp = await chrome.runtime.sendMessage({ source: 'sidepanel', type: command, payload });
    return resp;
  } catch (e) {
    console.warn('Message failed', e);
    return undefined;
  }
}

function setButtons({ running }) {
  const startBtn = document.getElementById('start-btn');
  const stopBtn = document.getElementById('stop-btn');
  const exportBtn = document.getElementById('export-btn');
  const copyBtn = document.getElementById('copy-btn');
  startBtn.disabled = running;
  stopBtn.disabled = !running;
  const hasText = state.transcript.length > 0;
  exportBtn.disabled = !hasText;
  if (copyBtn) copyBtn.disabled = !hasText;
}

async function requestMicPermission() {
  try {
    const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
    tmp.getTracks().forEach((t) => t.stop());
    return true;
  } catch (e) {
    appendTranscript('Microphone permission denied or unavailable.');
    return false;
  }
}

async function onStart() {
  state.running = true;
  setStatus('listening');
  startTimer();
  setButtons({ running: true });
  const source = state.source;
  if (source === 'mic') {
    try {
      const ok = await requestMicPermission();
      if (!ok) throw new Error('Microphone permission not granted');
      state.micCapture = await startMicCapture({
        onChunk: (chunk) => postChunkToBackground(chunk),
        onSegment: (segment) => postSegmentToBackground(segment),
      });
    } catch (e) {
  appendTranscript('Microphone capture failed. Check permissions.');
      console.warn(e);
    }
    sendCommand('START_TRANSCRIPTION', { source: 'mic' });
  } else if (source === 'tab') {
    sendCommand('START_TRANSCRIPTION', { source: 'tab' });
  } else if (source === 'tab+mic') {
    try {
      const ok = await requestMicPermission();
      if (!ok) throw new Error('Microphone permission not granted');
      state.micCapture = await startMicCapture({
        onChunk: (chunk) => postChunkToBackground(chunk),
        onSegment: (segment) => postSegmentToBackground(segment),
      });
    } catch (e) {
      appendTranscript('Microphone capture failed. Proceeding with Tab only.');
    }
    chrome.runtime.sendMessage({ source: 'sidepanel', type: 'START_TRANSCRIPTION', payload: { source: 'tab+mic' } });
  }
}

function onStop() {
  state.running = false;
  setStatus('stopped');
  stopTimer();
  setButtons({ running: false });
  sendCommand('STOP_TRANSCRIPTION');
  try { state.micCapture?.stop(); } catch (_) {}
  state.micCapture = null;
}

function handleIncomingMessage(message, _sender, _sendResponse) {
  if (!message || message.source === 'sidepanel') return;
  switch (message.type) {
    case 'TRANSCRIPT_CHUNK':
      // Accept only real chunks coming from background (Gemini results)
      appendTranscript(message.payload?.text || '', message.payload?.ts || Date.now());
      setButtons({ running: state.running });
      break;
    case 'TRANSCRIPTION_ERROR':
      appendTranscript(`Error: ${message.payload?.message || 'Transcription error'}`);
      announce('Transcription error');
      break;
    case 'TRANSCRIPTION_STATUS':
      if (message.payload?.status === 'paused') setStatus('paused');
      if (message.payload?.status === 'listening') setStatus('listening');
      if (message.payload?.status === 'stopped') setStatus('stopped');
      break;
    default:
      break;
  }
}

window.addEventListener('DOMContentLoaded', async () => {
  document.getElementById('app')?.classList.add('is-stopped');
  setButtons({ running: false });

  const startBtn = document.getElementById('start-btn');
  const stopBtn = document.getElementById('stop-btn');
  const exportBtn = document.getElementById('export-btn');
  const copyBtn = document.getElementById('copy-btn');
  const sourceSelect = document.getElementById('source-select');

  startBtn.addEventListener('click', onStart);
  stopBtn.addEventListener('click', onStop);
  exportBtn.addEventListener('click', exportTxt);
  copyBtn?.addEventListener('click', copyTranscript);

  sourceSelect.addEventListener('change', (e) => {
    state.source = e.target.value;
  });

  // Settings panel removed. API key/model provided by developers.

  document.querySelector('.controls')?.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') {
      const target = e.target;
      if (target instanceof HTMLButtonElement) return;
    }
  });

  chrome.runtime.onMessage.addListener(handleIncomingMessage);

  const container = document.getElementById('transcript');
  const hint = document.createElement('p');
  hint.className = 'muted';
  hint.textContent = 'Press Start to begin transcription. Transcript will appear here.';
  container.appendChild(hint);
});

export const __ui = { setStatus, appendTranscript, clearTranscript, startTimer, stopTimer, exportTxt };
