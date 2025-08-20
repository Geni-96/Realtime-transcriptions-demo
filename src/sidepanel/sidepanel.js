// Side panel UI logic
// Accessible controls, status, timer, transcript stream, export .txt
import { startMicCapture, postChunkToBackground } from '../audio/audioCapture.js';

const state = {
  running: false,
  startTs: null,
  timerInterval: null,
  transcript: [],
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

function appendTranscript(text) {
  if (!text) return;
  state.transcript.push(text);
  const container = document.getElementById('transcript');
  const p = document.createElement('p');
  p.textContent = text;
  container.appendChild(p);
  container.scrollTop = container.scrollHeight;
}

function clearTranscript() {
  state.transcript = [];
  const container = document.getElementById('transcript');
  container.innerHTML = '';
}

function exportTxt() {
  const blob = new Blob([state.transcript.join('\n')], { type: 'text/plain;charset=utf-8' });
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
  startBtn.disabled = running;
  stopBtn.disabled = !running;
  exportBtn.disabled = state.transcript.length === 0;
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
      state.micCapture = await startMicCapture({ onChunk: (chunk) => postChunkToBackground(chunk) });
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
      state.micCapture = await startMicCapture({ onChunk: (chunk) => postChunkToBackground(chunk) });
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
      appendTranscript(message.payload?.text || '');
      setButtons({ running: state.running });
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

window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('app')?.classList.add('is-stopped');
  setButtons({ running: false });

  const startBtn = document.getElementById('start-btn');
  const stopBtn = document.getElementById('stop-btn');
  const exportBtn = document.getElementById('export-btn');
  const sourceSelect = document.getElementById('source-select');

  startBtn.addEventListener('click', onStart);
  stopBtn.addEventListener('click', onStop);
  exportBtn.addEventListener('click', exportTxt);

  sourceSelect.addEventListener('change', (e) => {
    state.source = e.target.value;
  });

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
