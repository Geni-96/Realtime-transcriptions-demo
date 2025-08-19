// Side panel UI logic
// Accessible controls, status, timer, transcript stream, export .txt
import { startMicCapture, postChunkToBackground } from '../audio/audioCapture.js';

const state = {
  running: false,
  startTs: null,
  timerInterval: null,
  transcript: [], // array of strings
  source: 'tab',
  micDevices: [],
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

async function ensureMicPermission() {
  try {
    // Prompt once to get permission so that enumerateDevices returns labels
    await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (_) {
    // ignore; user may deny
  }
}

async function refreshMicDevices() {
  if (!navigator?.mediaDevices?.enumerateDevices) return;
  const devices = await navigator.mediaDevices.enumerateDevices();
  state.micDevices = devices.filter((d) => d.kind === 'audioinput');
  const micSelect = document.getElementById('mic-select');
  micSelect.innerHTML = '';
  state.micDevices.forEach((d) => {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || `Microphone (${d.deviceId.slice(0, 6)})`;
    micSelect.appendChild(opt);
  });
}

async function onStart() {
  state.running = true;
  setStatus('listening');
  startTimer();
  setButtons({ running: true });
  const source = state.source;
  if (source === 'mic') {
    // Start mic capture in sidepanel and stream chunks to background
    try {
      const micSelect = document.getElementById('mic-select');
      const deviceId = micSelect?.value || undefined;
      state.micCapture = await startMicCapture({
        deviceId,
        onChunk: (chunk) => postChunkToBackground(chunk),
      });
    } catch (e) {
      appendTranscript('Microphone capture failed. Check permissions.');
      console.warn(e);
    }
    // Ask background to start overall transcription (simulation + any backend)
    sendCommand('START_TRANSCRIPTION');
  } else if (source === 'tab') {
    sendCommand('START_TRANSCRIPTION', { source: 'tab' });
  } else if (source === 'tab+mic') {
    // Start mic locally and tab capture in background
    try {
      const micSelect = document.getElementById('mic-select');
      const deviceId = micSelect?.value || undefined;
      state.micCapture = await startMicCapture({
        deviceId,
        onChunk: (chunk) => postChunkToBackground(chunk),
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
  // Hook: notify background to stop
  sendCommand('STOP_TRANSCRIPTION');
  // Stop mic if running
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

window.addEventListener('DOMContentLoaded', async () => {
  // Initial UI state
  document.getElementById('app')?.classList.add('is-stopped');
  setButtons({ running: false });

  const startBtn = document.getElementById('start-btn');
  const stopBtn = document.getElementById('stop-btn');
  const exportBtn = document.getElementById('export-btn');
  const sourceSelect = document.getElementById('source-select');
  const micSelect = document.getElementById('mic-select');

  startBtn.addEventListener('click', onStart);
  stopBtn.addEventListener('click', onStop);
  exportBtn.addEventListener('click', exportTxt);

  sourceSelect.addEventListener('change', async (e) => {
    state.source = e.target.value;
    const micNeeded = state.source === 'mic' || state.source === 'tab+mic';
    micSelect.hidden = !micNeeded;
    if (micNeeded) {
      await ensureMicPermission();
      await refreshMicDevices();
    }
  });

  // Keyboard shortcuts (accessible): Space to toggle start/stop when focused on controls
  document.querySelector('.controls')?.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') {
      const target = e.target;
      if (target instanceof HTMLButtonElement) return; // native buttons handle Enter/Space
    }
  });

  // Listen for messages from background/content
  chrome.runtime.onMessage.addListener(handleIncomingMessage);

  // Example: show placeholder hint
  const container = document.getElementById('transcript');
  const hint = document.createElement('p');
  hint.className = 'muted';
  hint.textContent = 'Press Start to begin transcription. Transcript will appear here.';
  container.appendChild(hint);

  // Preload mic list if permissions already granted
  try { await refreshMicDevices(); } catch (_) {}
});

// Optional API exposed for tests
export const __ui = { setStatus, appendTranscript, clearTranscript, startTimer, stopTimer, exportTxt };
