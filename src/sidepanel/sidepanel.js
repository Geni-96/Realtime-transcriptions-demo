// Side panel UI logic
// Accessible controls, status, timer, transcript stream, export .txt

const state = {
  running: false,
  startTs: null,
  timerInterval: null,
  transcript: [], // array of strings
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

async function sendCommand(command) {
  try {
    const resp = await chrome.runtime.sendMessage({ source: 'sidepanel', type: command });
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

function onStart() {
  state.running = true;
  setStatus('listening');
  startTimer();
  setButtons({ running: true });
  // Hook: notify background to start capturing/transcribing
  sendCommand('START_TRANSCRIPTION');
}

function onStop() {
  state.running = false;
  setStatus('stopped');
  stopTimer();
  setButtons({ running: false });
  // Hook: notify background to stop
  sendCommand('STOP_TRANSCRIPTION');
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
  // Initial UI state
  document.getElementById('app')?.classList.add('is-stopped');
  setButtons({ running: false });

  const startBtn = document.getElementById('start-btn');
  const stopBtn = document.getElementById('stop-btn');
  const exportBtn = document.getElementById('export-btn');

  startBtn.addEventListener('click', onStart);
  stopBtn.addEventListener('click', onStop);
  exportBtn.addEventListener('click', exportTxt);

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
});

// Optional API exposed for tests
export const __ui = { setStatus, appendTranscript, clearTranscript, startTimer, stopTimer, exportTxt };
