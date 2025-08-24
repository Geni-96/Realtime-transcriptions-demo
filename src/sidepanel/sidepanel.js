const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const transcriptDiv = document.getElementById('transcript');
const statusDiv = document.getElementById('status');

let recorder;
let mediaStream;
const segmentQueue = [];
let isProcessing = false;

// Backend-managed secrets: configure your backend URL in chrome.storage.local { backendUrl }
const DEFAULT_BACKEND_URL = null; // e.g., 'https://your-backend.example.com'
let backend = { baseUrl: DEFAULT_BACKEND_URL };

// Load backend URL from chrome.storage on init
try {
  chrome.storage?.local?.get(['backendUrl'], (res) => {
    if (chrome.runtime.lastError) {
      console.warn('[SidePanel] storage.get error:', chrome.runtime.lastError);
    }
    if (res && typeof res.backendUrl === 'string' && res.backendUrl.trim()) {
      backend.baseUrl = res.backendUrl.trim().replace(/\/$/, '');
      setStatus('Backend URL loaded');
    } else if (backend.baseUrl) {
      setStatus('Using default backend URL');
    } else {
      setStatus('Backend URL not set. Save backendUrl in chrome.storage.local');
    }
  });
} catch (e) {
  console.warn('[SidePanel] chrome.storage not available:', e);
}

function setStatus(msg, level = 'info') {
  if (!statusDiv) return;
  const color = level === 'error' ? 'crimson' : level === 'warn' ? '#b58900' : '#555';
  statusDiv.style.color = color;
  statusDiv.textContent = msg;
}

function appendTranscript(html) {
  if (!transcriptDiv) return;
  const p = document.createElement('p');
  p.innerHTML = html;
  transcriptDiv.appendChild(p);
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const res = reader.result;
      // result is like 'data:audio/webm;base64,AAAA...'; we only need the payload
      const commaIdx = typeof res === 'string' ? res.indexOf(',') : -1;
      resolve(commaIdx >= 0 ? res.slice(commaIdx + 1) : res);
    };
    reader.onerror = (e) => reject(e);
    reader.readAsDataURL(blob);
  });
}

async function startRecordingIfPossible() {
  if (!mediaStream) {
    console.warn('[SidePanel] startRecordingIfPossible: no mediaStream yet');
    return;
  }
  if (recorder && recorder.state !== 'inactive') {
    console.log('[SidePanel] Recorder already running');
    return;
  }
  try {
    const mimeType = 'audio/webm;codecs=opus';
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      console.warn('[SidePanel] mimeType not supported, trying default');
    }
    recorder = new MediaRecorder(mediaStream, { mimeType });
    recorder.onstart = () => console.log('[SidePanel] MediaRecorder started');
    recorder.onerror = (e) => console.error('[SidePanel] MediaRecorder error:', e);
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        segmentQueue.push(event.data);
        void processQueue();
      }
    };
    // collect chunks every second
    recorder.start(1000);
    setStatus('Recording…');
  } catch (e) {
    console.error('[SidePanel] Failed to start MediaRecorder:', e);
    setStatus('Failed to start recording. See console.', 'error');
  }
}

async function processQueue() {
  if (isProcessing) return;
  isProcessing = true;
  try {
    while (segmentQueue.length > 0) {
      const segment = segmentQueue.shift();
      console.log('[SidePanel] Processing audio segment', segment);
  // Convert blob to base64 for backend
      let base64;
      try {
        base64 = await blobToBase64(segment);
      } catch (e) {
        console.error('[SidePanel] blobToBase64 failed:', e);
        appendTranscript('<span style="color:red;">Failed to prepare audio chunk.</span>');
        continue;
      }
  const { text, label } = await callBackendTranscribe({ chunks: [{ base64 }], mimeType: 'audio/webm' });
      console.log('[SidePanel] Transcription result:', text);
      if (label === 'error') {
        appendTranscript('<span style="color:red;">Transcription error. Check console.</span>');
      }
      if (text) appendTranscript(text);
    }
  } finally {
    isProcessing = false;
  }
}

async function callBackendTranscribe({ chunks, mimeType }) {
  try {
    if (!backend.baseUrl) throw new Error('Backend URL not configured');
    const url = `${backend.baseUrl}/transcribe`;
    const body = { chunks: chunks.map((c) => c.base64), mimeType: mimeType || 'audio/webm' };
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => String(resp.status));
      throw new Error(`Backend error ${resp.status}: ${txt}`);
    }
    const data = await resp.json();
    let text = data?.text;
    if (!text) {
      text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join(' ').trim();
    }
    if (!text) throw new Error('No transcript returned by backend');
    return { text, label: 'ok', seq: 0 };
  } catch (error) {
    console.error('[SidePanel] Error calling backend:', error);
    return { text: '', label: 'error', seq: -1 };
  }
}

function captureActiveTabAndStart() {
  console.log('[SidePanel] Start button clicked');
  if (!backend.baseUrl) {
    setStatus('Backend URL not set. Save backendUrl in chrome.storage.local', 'error');
    console.error('[SidePanel] Backend URL not configured');
    return;
  }
  setStatus('Requesting tab audio…');
  if (!chrome?.tabCapture) {
    setStatus('tabCapture API not available. Are permissions set?', 'error');
    console.error('[SidePanel] chrome.tabCapture API not available in this context.');
    return;
  }
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const activeTab = tabs && tabs[0];
    if (!activeTab) {
      setStatus('No active tab found', 'error');
      console.error('[SidePanel] No active tab found');
      return;
    }
    const useCapture = (stream) => {
      console.log('[SidePanel] Got MediaStream. Routing to audio output for monitoring.');
      try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        const audioCtx = new AudioCtx();
        const source = audioCtx.createMediaStreamSource(stream);
        source.connect(audioCtx.destination);
        console.log('[SidePanel] Audio routed. AudioContext state:', audioCtx.state);
      } catch (e) {
        console.warn('[SidePanel] Failed to route audio (ok to ignore):', e);
      }
      mediaStream = stream;
      void startRecordingIfPossible();
    };

    if (typeof chrome.tabCapture.capture === 'function') {
      const options = { audio: true, video: false }; // Chrome will prompt user if needed
      console.log('[SidePanel] Calling tabCapture.capture with', options, 'for tab', activeTab.id);
      chrome.tabCapture.capture(options, (stream) => {
        if (chrome.runtime.lastError || !stream) {
          setStatus('tabCapture.capture failed. See console.', 'error');
          console.error('[SidePanel] tabCapture.capture error:', chrome.runtime.lastError);
          return;
        }
        console.log('[SidePanel] tabCapture.capture stream obtained', stream);
        useCapture(stream);
      });
    } else if (typeof chrome.tabCapture.getMediaStreamId === 'function') {
      console.warn('[SidePanel] capture() not available, using getMediaStreamId + getUserMedia');
      chrome.tabCapture.getMediaStreamId({ targetTabId: activeTab.id }, (streamId) => {
        if (chrome.runtime.lastError || !streamId) {
          setStatus('getMediaStreamId failed. See console.', 'error');
          console.error('[SidePanel] getMediaStreamId error:', chrome.runtime.lastError, 'streamId:', streamId);
          return;
        }
        console.log('[SidePanel] Obtained streamId:', streamId);
        navigator.mediaDevices.getUserMedia({
          audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
          video: false,
        }).then(useCapture).catch((err) => {
          setStatus('getUserMedia with streamId failed. See console.', 'error');
          console.error('[SidePanel] getUserMedia with streamId failed:', err);
        });
      });
    } else {
      setStatus('tabCapture API not available. Update Chrome or check permissions.', 'error');
      console.error('[SidePanel] tabCapture API not available.');
    }
  });
}

if (startBtn) {
  startBtn.addEventListener('click', captureActiveTabAndStart);
} else {
  console.error('[SidePanel] startBtn not found in DOM');
}

if (stopBtn) {
  stopBtn.addEventListener('click', () => {
    try {
      if (recorder) {
        recorder.stop();
        recorder = null;
      }
      if (mediaStream) {
        mediaStream.getTracks().forEach((track) => track.stop());
        mediaStream = null;
      }
      setStatus('Stopped');
    } catch (e) {
      console.error('[SidePanel] Error while stopping:', e);
      setStatus('Error while stopping. See console.', 'error');
    }
    console.log('[SidePanel] Stopped recording');
  });
} else {
  console.error('[SidePanel] stopBtn not found in DOM');
}
