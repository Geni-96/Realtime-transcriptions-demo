const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const transcriptDiv = document.getElementById('transcript');
const statusDiv = document.getElementById('status');
const includeMicCheckbox = document.getElementById('includeMicrophone');
const monitorAudioCheckbox = document.getElementById('monitorAudio');
// Backend-managed secrets: configure backendUrl in chrome.storage.local
const DEFAULT_BACKEND_URL = 'http://localhost:3001'; // change if you host elsewhere
let backend = { baseUrl: DEFAULT_BACKEND_URL };

let recorder;
let mediaStream; // final stream used by MediaRecorder (mixed or single source)
let tabStream;   // raw tab capture stream
let micStream;   // raw microphone stream
let audioCtx;    // shared AudioContext for mixing/monitoring
let monitorNode; // optional connection to destination for monitoring
const segmentQueue = [];
let isProcessing = false;

// Batching & rate limiting to avoid API 500s/throttling
// IMPORTANT: Do NOT use MediaRecorder timeslice. Instead, stop and recreate
// the recorder every CHUNK_MS so each blob is a complete, standalone file
// with a valid container/header (required by Gemini).
const CHUNK_MS = 3000; // target ~3s chunks
// Important: Concatenating WebM/Opus blobs can yield invalid containers.
// Stick to single-segment requests unless you remux with a real muxer (ffmpeg).
const BATCH_SEGMENTS = 1;  // process one segment per request
const MIN_GAP_BETWEEN_REQUESTS_MS = 1000; // small delay between requests
const INITIAL_BACKOFF_MS = 2000; // start backoff at 2s on error
const MAX_BACKOFF_MS = 15000;     // cap backoff at 15s

// Recording loop control
let isActive = false; // true while the user has recording enabled
let sessionTimerId = null; // timer to stop the current recorder

// Load backend URL from storage on init
try {
  chrome.storage?.local?.get(['backendUrl'], (res) => {
    if (chrome.runtime.lastError) {
      console.warn('[SidePanel] storage.get error:', chrome.runtime.lastError);
    }
    if (res && typeof res.backendUrl === 'string' && res.backendUrl.trim()) {
      backend.baseUrl = res.backendUrl.trim().replace(/\/$/, '');
      setStatus('Backend URL loaded');
    } else if (backend.baseUrl) {
      setStatus(`Using backend: ${backend.baseUrl}`);
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithTimeout(url, options, timeoutMs = 30000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal });
    return resp;
  } finally {
    clearTimeout(id);
  }
}

function clearSessionTimer() {
  if (sessionTimerId) {
    clearTimeout(sessionTimerId);
    sessionTimerId = null;
  }
}

function scheduleSessionStop() {
  clearSessionTimer();
  sessionTimerId = setTimeout(() => {
    try {
      if (recorder && recorder.state !== 'inactive') {
        recorder.stop(); // triggers onstop, which will start the next session if isActive
      }
    } catch (e) {
      console.warn('[SidePanel] Error stopping recorder:', e);
    }
  }, CHUNK_MS);
}

function startNewRecorderSession() {
  if (!isActive) return;
  if (!mediaStream) {
    console.warn('[SidePanel] startNewRecorderSession: no mediaStream');
    return;
  }
  try {
    const preferredMime = 'audio/webm;codecs=opus';
    const mimeType = MediaRecorder.isTypeSupported?.(preferredMime) ? preferredMime : undefined;

    // Create a fresh MediaRecorder so the next Blob is a complete file with header
    recorder = new MediaRecorder(mediaStream, { mimeType });
    let sessionBlob = null; // capture a single, final blob per session

    recorder.onstart = () => {
      console.log('[SidePanel] MediaRecorder session started');
      setStatus('Recording…');
      scheduleSessionStop();
    };
    recorder.onerror = (e) => console.error('[SidePanel] MediaRecorder error:', e);
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        // Keep only the last available blob for this session
        sessionBlob = event.data;
      }
    };
    recorder.onstop = () => {
      clearSessionTimer();
      try {
        if (sessionBlob && sessionBlob.size > 0) {
          // Push the complete, standalone file blob
          segmentQueue.push(sessionBlob);
          void processQueue();
        } else {
          console.warn('[SidePanel] No blob produced for this session');
        }
      } finally {
        // Immediately start a new session to continue near real-time capture
        if (isActive) {
          // Give the event loop a tick to avoid overlap
          setTimeout(() => startNewRecorderSession(), 0);
        }
      }
    };

    recorder.start(); // no timeslice; we'll stop after CHUNK_MS
  } catch (e) {
    console.error('[SidePanel] Failed to start MediaRecorder session:', e);
    setStatus('Failed to start recording session. See console.', 'error');
  }
}

async function startRecordingIfPossible() {
  if (!mediaStream) {
    console.warn('[SidePanel] startRecordingIfPossible: no mediaStream yet');
    return;
  }
  if (isActive) {
    console.log('[SidePanel] Recording already active');
    return;
  }
  isActive = true;
  startNewRecorderSession();
}

async function processQueue() {
  if (isProcessing) return;
  isProcessing = true;
  try {
    let backoff = 0;
    while (segmentQueue.length > 0) {
      // Process a single segment to keep a valid WebM container
      const segment = segmentQueue.shift();
      const currentMime = segment?.type || recorder?.mimeType || 'audio/webm;codecs=opus';
      console.log('[SidePanel] Processing segment', { size: segment?.size, type: currentMime });

      let base64;
      try {
        base64 = await blobToBase64(segment);
      } catch (e) {
        console.error('[SidePanel] blobToBase64 failed:', e);
        appendTranscript('<span style=\"color:red;\">Failed to prepare audio chunk.</span>');
        continue;
      }

  const { text, label } = await callBackendTranscribe({ chunks: [{ base64 }], mimeType: currentMime });
      console.log('[SidePanel] Transcription result:', text);
      if (label === 'error') {
        appendTranscript('<span style="color:red;">Transcription error. Backing off…</span>');
        backoff = backoff ? Math.min(backoff * 2, MAX_BACKOFF_MS) : INITIAL_BACKOFF_MS;
        await new Promise((r) => setTimeout(r, backoff));
      } else {
        if (text) appendTranscript(text);
        backoff = 0; // reset on success
        await new Promise((r) => setTimeout(r, MIN_GAP_BETWEEN_REQUESTS_MS));
      }
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
    const resp = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(body),
    }, 30000);
    if (!resp.ok) {
      const txt = await resp.text().catch(() => String(resp.status));
      const err = new Error(`Backend error ${resp.status}: ${txt}`);
      err.status = resp.status;
      throw err;
    }
    const data = await resp.json();
    const text = data?.text ?? data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join(' ').trim();
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
  setStatus('Requesting audio…');
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
    const useFinalStream = (finalStream) => {
      mediaStream = finalStream;
      void startRecordingIfPossible();
    };

    const getMicIfEnabled = async () => {
      if (!includeMicCheckbox || includeMicCheckbox.checked) {
        try {
          const constraints = {
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true
            },
            video: false
          };
          const s = await navigator.mediaDevices.getUserMedia(constraints);
          console.log('[SidePanel] Microphone stream obtained');
          return s;
        } catch (err) {
          console.warn('[SidePanel] Microphone permission/error:', err);
          setStatus('Microphone unavailable. Proceeding without mic.', 'warn');
          return null;
        }
      }
      return null;
    };

    if (typeof chrome.tabCapture.capture === 'function') {
      const options = { audio: true, video: false }; // Chrome will prompt user if needed
      console.log('[SidePanel] Calling tabCapture.capture with', options, 'for tab', activeTab.id);
      chrome.tabCapture.capture(options, async (stream) => {
        if (chrome.runtime.lastError || !stream) {
          console.error('[SidePanel] tabCapture.capture error:', chrome.runtime.lastError);
          setStatus('Tab capture failed. Trying microphone only…', 'warn');
          // Try mic-only if available
          try {
            micStream = await getMicIfEnabled();
            if (micStream) {
              // Use micStream directly
              prepareMixAndStart(null, micStream);
            } else {
              setStatus('No audio sources available.', 'error');
            }
          } catch (e) {
            console.error('[SidePanel] Failed to start with mic-only:', e);
            setStatus('Unable to start audio capture.', 'error');
          }
          return;
        }
        console.log('[SidePanel] tabCapture.capture stream obtained');
        tabStream = stream;
        try {
          micStream = await getMicIfEnabled();
        } catch (_) {
          micStream = null;
        }
        prepareMixAndStart(tabStream, micStream);
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
        }).then(async (stream) => {
          tabStream = stream;
          try {
            micStream = await getMicIfEnabled();
          } catch (_) {
            micStream = null;
          }
          prepareMixAndStart(tabStream, micStream);
        }).catch((err) => {
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
  isActive = false;
  clearSessionTimer();
      if (recorder) {
        recorder.stop();
        recorder = null;
      }
      // Stop all tracks for each stream
      [mediaStream, tabStream, micStream].forEach((s) => {
        try { s && s.getTracks().forEach((t) => t.stop()); } catch (_) {}
      });
      mediaStream = null;
      tabStream = null;
      micStream = null;
      // Close AudioContext if we created one
      if (audioCtx) {
        try { audioCtx.close(); } catch (_) {}
        audioCtx = null;
        monitorNode = null;
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

// Mix tab and mic streams into a single MediaStream, optionally monitor locally
function prepareMixAndStart(tabS, micS) {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    audioCtx = audioCtx || new AudioCtx();

    // If only one source is available, use it directly
    if (tabS && !micS) {
      setStatus('Capturing tab audio');
      useNoMonitorRoute(tabS);
      return;
    }
    if (micS && !tabS) {
      setStatus('Capturing microphone audio');
      useNoMonitorRoute(micS);
      return;
    }

    // Both available: mix
    const tabSource = audioCtx.createMediaStreamSource(tabS);
    const micSource = audioCtx.createMediaStreamSource(micS);
    const tabGain = audioCtx.createGain();
    const micGain = audioCtx.createGain();
    tabGain.gain.value = 0.9;
    micGain.gain.value = 0.9;
    const destination = audioCtx.createMediaStreamDestination();
    tabSource.connect(tabGain).connect(destination);
    micSource.connect(micGain).connect(destination);

    // Optional monitoring
    if (monitorAudioCheckbox && monitorAudioCheckbox.checked) {
      try {
        // Prevent double connections by creating a separate summing path
        const monitorMerger = audioCtx.createGain();
        tabSource.connect(monitorMerger);
        micSource.connect(monitorMerger);
        monitorNode = monitorMerger.connect(audioCtx.destination);
      } catch (e) {
        console.warn('[SidePanel] Failed to enable monitoring:', e);
      }
    }

    useFinalStream(destination.stream);
  } catch (e) {
    console.error('[SidePanel] Error preparing audio mix:', e);
    setStatus('Failed to prepare audio mix. Using available source.', 'warn');
    if (tabS) return useNoMonitorRoute(tabS);
    if (micS) return useNoMonitorRoute(micS);
    setStatus('No audio sources available.', 'error');
  }

  function useNoMonitorRoute(stream) {
    try {
      // Avoid routing to destination unless monitoring explicitly requested
      useFinalStream(stream);
    } catch (e) {
      console.warn('[SidePanel] useNoMonitorRoute error:', e);
      useFinalStream(stream);
    }
  }
}
