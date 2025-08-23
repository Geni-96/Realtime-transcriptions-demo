// Side panel UI logic
// Accessible controls, status, timer, transcript stream (real-time), export & copy.
import { startMicCapture, startTabCapture, startShareAudioCapture, postChunkToBackground, postSegmentToBackground } from '../audio/audioCapture.js';

const state = {
  running: false,
  startTs: null,
  timerInterval: null,
  transcript: [], // [{ text, tsISO }]
  source: 'tab',
  micCapture: null,
  activityTimer: null,
  sawAudio: false,
  tabCapture: null,
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
  try {
    renderTranscriptChunk({ text, tsISO });
    // Auto-scroll to latest
    const container = document.getElementById('transcript');
    if (container) container.scrollTop = container.scrollHeight;
  } catch (e) {
    console.warn('appendTranscript render failed', e);
  }
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
    // tmp.getTracks().forEach((t) => t.stop());
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
  state.sawAudio = false;
  if (state.activityTimer) { clearTimeout(state.activityTimer); state.activityTimer = null; }
  // If no audio activity within 12s, surface a helpful hint
  // state.activityTimer = setTimeout(() => {
  //   if (!state.sawAudio) {
  //     const hint = source === 'mic'
  //       ? 'No microphone audio detected yet. Check input device and OS permissions.'
  //       : 'No tab audio detected yet. Make sure the active tab is playing audio.';
  //     appendTranscript(hint);
  //     announce('No audio detected yet');
  //   }
  // }, 12000);
  if (source === 'mic') {
    try {
      // const ok = await requestMicPermission();
      // if (!ok) throw new Error('Microphone permission not granted');
      state.micCapture = await startMicCapture({
  onChunk: (chunk) => { state.sawAudio = true; postChunkToBackground(chunk); },
        onSegment: (segment) => postSegmentToBackground(segment),
      });
    } catch (e) {
  appendTranscript('Microphone capture failed. Check permissions.');
  announce('Microphone capture failed');
      console.warn(e);
    }
    const resp = await sendCommand('START_TRANSCRIPTION', { source: 'mic' });
    if (!resp?.ok) {
      appendTranscript('Could not contact background. Try reloading the extension.');
    }
  } else if (source === 'tab') {
    // Start tab capture locally (MediaRecorder is not available in service worker)
    try {
      // Determine the active tab ID for the current window
      const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const targetTabId = active?.id;
      const url = active?.url || '';
      console.log('Active tab URL:', url);
      // Disallow Chrome internal and other non-capturable schemes
      if (!/^https?:/i.test(url)) {
        appendTranscript('Cannot capture this page (chrome/internal page). Switch to a regular website tab (e.g., a YouTube video) and try again.');
        state.running = false;
        setStatus('stopped');
        stopTimer();
        setButtons({ running: false });
        return;
      }
      // Ensure we have per-origin permission if the extension is set to "on click" access
      const origin = new URL(url).origin + '/*';
      try {
        const granted = await chrome.permissions.request({ origins: [origin] });
        if (!granted) {
          appendTranscript('Permission to access this site was not granted. Click the extension icon and allow “Always allow on this site”, then try again.');
          state.running = false; setStatus('stopped'); stopTimer(); setButtons({ running: false });
          return;
        }
      } catch (_) {
        // ignore; some setups auto-grant due to host_permissions
      }
      if (!targetTabId) throw new Error('No active tab found in current window');
      state.tabCapture = await startTabCapture({
        targetTabId,
        onChunk: (chunk) => { state.sawAudio = true; postChunkToBackground(chunk); },
        onSegment: (segment) => postSegmentToBackground(segment),
      });
    } catch (e) {
      appendTranscript(`Tab capture failed. ${e?.message || e}. Ensure the side panel is opened from the same window as the target tab and that the tab is active.`);
      console.warn(e);
    }
    const resp = await sendCommand('START_TRANSCRIPTION', { source: 'tab' });
    if (!resp?.ok) {
      appendTranscript('Could not contact background. Try reloading the extension.');
    } else {
      appendTranscript('Capturing audio from the active tab. Ensure it is playing.');
    }
  } else if (source === 'tab+mic') {
    try {
      const ok = await requestMicPermission();
      if (!ok) throw new Error('Microphone permission not granted');
      state.micCapture = await startMicCapture({
        onChunk: (chunk) => { state.sawAudio = true; postChunkToBackground(chunk); },
        onSegment: (segment) => postSegmentToBackground(segment),
      });
    } catch (e) {
      appendTranscript('Microphone capture failed. Proceeding with Tab only.');
    }
    try {
      state.tabCapture = await startTabCapture({
        onChunk: (chunk) => { state.sawAudio = true; postChunkToBackground(chunk); },
        onSegment: (segment) => postSegmentToBackground(segment),
      });
    } catch (e) {
      appendTranscript('Tab capture failed. Continuing with microphone only.');
    }
    chrome.runtime.sendMessage({ source: 'sidepanel', type: 'START_TRANSCRIPTION', payload: { source: 'tab+mic' } });
  } else if (source === 'share') {
    try {
      const share = await startShareAudioCapture({
        onChunk: (chunk) => { state.sawAudio = true; postChunkToBackground(chunk); },
        onSegment: (segment) => postSegmentToBackground(segment),
      });
      state.tabCapture = share; // reuse tabCapture slot for lifecycle
      appendTranscript('Shared audio capture started. If you do not hear/see audio, ensure you checked "Share audio" in the prompt.');
    } catch (e) {
      appendTranscript('Share audio prompt failed or was denied.');
      console.warn(e);
    }
    const resp = await sendCommand('START_TRANSCRIPTION', { source: 'share' });
    if (!resp?.ok) appendTranscript('Could not contact background. Try reloading the extension.');
  }
}

function onStop() {
  state.running = false;
  setStatus('stopped');
  stopTimer();
  setButtons({ running: false });
  sendCommand('STOP_TRANSCRIPTION');
  try { state.micCapture?.stop(); } catch (_) {}
  try { state.tabCapture?.stop(); } catch (_) {}
  state.micCapture = null;
  state.tabCapture = null;
}

function handleIncomingMessage(message, _sender, _sendResponse) {
  if (!message || message.source === 'sidepanel') return;
  switch (message.type) {
    case 'TRANSCRIPT_CHUNK':
      // Accept only real chunks coming from background (Gemini results)
      appendTranscript(message.payload?.text || '', message.payload?.ts || Date.now());
      setButtons({ running: state.running });
      break;
    case 'AUDIO_CHUNK':
      // Lightweight signal that audio is flowing
      state.sawAudio = true;
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
