const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const transcriptDiv = document.getElementById('transcript');
const statusDiv = document.getElementById('status');
const includeMicCheckbox = document.getElementById('includeMicrophone');
// Backend-managed secrets: configure backendUrl in chrome.storage.local
const DEFAULT_BACKEND_URL = 'http://localhost:3001'; // change if you host elsewhere
let backend = { baseUrl: DEFAULT_BACKEND_URL };

let recorder;
let mediaStream; // final stream used by MediaRecorder (mixed or single source)
let tabStream;   // raw tab capture stream
let micStream;   // raw microphone stream
let audioCtx;    // shared AudioContext for mixing/monitoring
let monitorAudioEl; // optional <audio> element used to monitor tab-only/mic-only
let originalTabMutedInfo = null; // to restore tab's muted state on stop
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

function describeError(err) {
  if (!err) return 'Unknown error';
  if (typeof err === 'string') return err;
  const name = err?.name || err?.constructor?.name;
  const message = err?.message;
  if (name && message) return `${name}: ${message}`;
  if (name) return name;
  if (message) return message;
  try {
    return JSON.stringify(err);
  } catch (_) {
    return String(err);
  }
}

function setFinalStream(finalStream) {
  mediaStream = finalStream;
  void startRecordingIfPossible();
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
  try { await waitForAudioTracks(mediaStream, 2000); } catch (_) {}
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
  // Clean up any previous streams before starting a new capture
  try {
    [mediaStream, tabStream, micStream].forEach((s) => {
      try { s && s.getTracks().forEach((t) => t.stop()); } catch (_) {}
    });
    mediaStream = null; tabStream = null; micStream = null;
  if (audioCtx) { try { audioCtx.close(); } catch (_) {} audioCtx = null; }
  } catch (_) {}
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
    const getMicIfEnabled = async () => {
      // Only request microphone if the user explicitly enabled it
      if (includeMicCheckbox && includeMicCheckbox.checked) {
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
          const detail = describeError(err);
          console.warn(`[SidePanel] Microphone permission/error: ${detail}`, err);
          setStatus('Microphone unavailable. Proceeding without mic.', 'warn');
          return null;
        }
      }
      return null;
    };

    if (typeof chrome.tabCapture.capture === 'function') {
      // Do not mute or toggle original tab audio; we want the tab to keep playing sound
      const options = { audio: true, video: false };
      console.log('[SidePanel] Calling tabCapture.capture with', options, 'for tab', activeTab.id);
      const tryCapture = () => new Promise((resolve) => {
        chrome.tabCapture.capture(options, (stream) => {
          if (chrome.runtime.lastError || !stream) {
            console.warn('[SidePanel] tabCapture.capture failed:', chrome.runtime.lastError);
            resolve(null);
          } else {
            resolve(stream);
          }
        });
      });
      const tryAlt = () => tryTabCaptureViaGUMPromise(activeTab.id);

      (async () => {
        let s = await tryCapture();
        if (!s) {
          setStatus('Tab capture failed. Trying alternate method…', 'warn');
          s = await tryAlt();
        }
        if (!s) {
          // Retry once after a short delay; playback might not have started yet
          setStatus('Retrying tab capture…', 'warn');
          await sleep(500);
          s = await tryCapture();
        }
        if (!s) {
          s = await tryAlt();
        }
        if (!s) {
          setStatus('Unable to capture tab audio. Try reloading the tab.', 'error');
          return;
        }
        console.log('[SidePanel] Tab capture stream obtained');
        tabStream = s;
        try {
          micStream = await getMicIfEnabled();
        } catch (_) {
          micStream = null;
        }
        // Ensure original tab stays audible unless the user opts to monitor via the extension
        preserveTabMutedState(activeTab.id, false);
        prepareMixAndStart(tabStream, micStream);
      })();
    } else if (typeof chrome.tabCapture.getMediaStreamId === 'function') {
      console.warn('[SidePanel] capture() not available, using getMediaStreamId + getUserMedia');
      chrome.tabCapture.getMediaStreamId({ targetTabId: activeTab.id }, (streamId) => {
        if (chrome.runtime.lastError || !streamId) {
          setStatus('getMediaStreamId failed. See console.', 'error');
          console.error('[SidePanel] getMediaStreamId error:', chrome.runtime.lastError, 'streamId:', streamId);
          return tryTabCaptureViaGUM(activeTab.id);
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
          preserveTabMutedState(activeTab.id, false);
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

// Fallback: Try tab capture via getMediaStreamId + getUserMedia if capture() fails
function tryTabCaptureViaGUM(activeTabId) {
  setStatus('Tab capture failed. Trying alternate method…', 'warn');
  if (typeof chrome.tabCapture.getMediaStreamId !== 'function') {
    console.warn('[SidePanel] getMediaStreamId not available');
    // As a last resort, try mic-only if enabled
    return (async () => {
      try {
        micStream = await (async () => {
          const includeMic = includeMicCheckbox && includeMicCheckbox.checked;
          return includeMic ? await navigator.mediaDevices.getUserMedia({ audio: true, video: false }) : null;
        })();
        if (micStream) {
          prepareMixAndStart(null, micStream);
        } else {
          setStatus('No audio sources available.', 'error');
        }
      } catch (e) {
        console.error('[SidePanel] Mic-only fallback failed:', e);
        setStatus('No audio sources available.', 'error');
      }
    })();
  }
  chrome.tabCapture.getMediaStreamId({ targetTabId: activeTabId }, (streamId) => {
    if (chrome.runtime.lastError || !streamId) {
      console.error('[SidePanel] getMediaStreamId error:', chrome.runtime.lastError);
      setStatus('Alternate capture failed. You may need to reload the tab.', 'error');
      return;
    }
    navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
      video: false,
    }).then(async (stream) => {
      tabStream = stream;
      try { micStream = await (includeMicCheckbox && includeMicCheckbox.checked ? navigator.mediaDevices.getUserMedia({ audio: true, video: false }) : null); } catch (_) { micStream = null; }
      prepareMixAndStart(tabStream, micStream);
    }).catch((err) => {
      console.error('[SidePanel] getUserMedia with streamId failed:', err);
      setStatus('Alternate capture failed. Check site permissions.', 'error');
    });
  });
}

// Promise-based alternate tab capture helper
function tryTabCaptureViaGUMPromise(activeTabId) {
  return new Promise((resolve) => {
    if (typeof chrome.tabCapture.getMediaStreamId !== 'function') {
      return resolve(null);
    }
    chrome.tabCapture.getMediaStreamId({ targetTabId: activeTabId }, (streamId) => {
      if (chrome.runtime.lastError || !streamId) {
        console.warn('[SidePanel] getMediaStreamId error:', chrome.runtime.lastError);
        return resolve(null);
      }
      navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
        video: false,
      }).then((stream) => resolve(stream)).catch((err) => {
        console.warn('[SidePanel] getUserMedia with streamId failed:', err);
        resolve(null);
      });
    });
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
      }
      // Restore tab muted state if we modified it
      if (originalTabMutedInfo) {
        try { chrome.tabs.update(originalTabMutedInfo.tabId, { muted: originalTabMutedInfo.wasMuted }); } catch (_) {}
        originalTabMutedInfo = null;
      }
      // Remove monitoring element if present
      if (monitorAudioEl) {
        try { monitorAudioEl.pause(); monitorAudioEl.srcObject = null; monitorAudioEl.remove(); } catch (_) {}
        monitorAudioEl = null;
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
    const hasAudioTracks = (s) => !!(s && s.getAudioTracks && s.getAudioTracks().length > 0);
    const includeMic = !!(includeMicCheckbox && includeMicCheckbox.checked);
    const sources = [];

    // Fast path: if mic isn't requested and tab stream exists, avoid mixer
    if (!includeMic && tabS) {
      setStatus('Capturing tab audio');
      ensureElementMonitoring(tabS);
      return setFinalStream(tabS);
    }

    // Create a fresh audio context for the mixer
    audioCtx = new AudioCtx();
    if (typeof audioCtx.resume === 'function') {
      audioCtx.resume().catch(() => {});
    }

    if (hasAudioTracks(tabS)) {
      try {
        const src = audioCtx.createMediaStreamSource(tabS);
        const gain = audioCtx.createGain();
        gain.gain.value = 0.9;
        sources.push({ src, gain });
      } catch (e) {
        console.warn('[SidePanel] Could not create source for tab stream:', e);
      }
    }
    if (hasAudioTracks(micS)) {
      try {
        const src = audioCtx.createMediaStreamSource(micS);
        const gain = audioCtx.createGain();
        gain.gain.value = 0.9;
        sources.push({ src, gain });
      } catch (e) {
        console.warn('[SidePanel] Could not create source for mic stream:', e);
      }
    }

    if (sources.length === 0) {
      // If neither stream yields a source node, fall back to direct stream usage
      if (tabS) {
        setStatus('Capturing tab (tracks not detected yet)');
        return useNoMonitorRoute(tabS);
      }
      if (micS) {
        setStatus('Capturing microphone (tracks not detected yet)');
        return useNoMonitorRoute(micS);
      }
      setStatus('No audio sources available.', 'error');
      return;
    }

    const mixBus = audioCtx.createGain();
    sources.forEach(({ src, gain }) => src.connect(gain).connect(mixBus));

    const mediaDest = audioCtx.createMediaStreamDestination();
    mixBus.connect(mediaDest);

    // Monitor the live mix locally so playback never stops
    try {
      mixBus.connect(audioCtx.destination);
    } catch (e) {
      console.warn('[SidePanel] Failed to route mix to destination:', e);
    }

  // Update status based on which sources are active
    if (sources.length === 2) setStatus('Capturing tab + microphone');
    else if (hasAudioTracks(tabS)) setStatus('Capturing tab audio');
    else setStatus('Capturing microphone audio');

      setFinalStream(mediaDest.stream);
  } catch (e) {
    console.error('[SidePanel] Error preparing audio mix:', e);
    setStatus('Failed to prepare audio mix. Using available source.', 'warn');
    // Fallback: prefer tab, else mic; even if tracks are not yet detectable, proceed
    if (tabS) return useNoMonitorRoute(tabS);
    if (micS) return useNoMonitorRoute(micS);
    setStatus('No audio sources available.', 'error');
  }

  function useNoMonitorRoute(stream) {
    try {
  ensureElementMonitoring(stream);
      return setFinalStream(stream);
    } catch (e) {
      console.warn('[SidePanel] useNoMonitorRoute error:', e);
      setFinalStream(stream);
    }
  }
}

function ensureElementMonitoring(stream) {
  try {
    if (!monitorAudioEl) {
      monitorAudioEl = document.createElement('audio');
      monitorAudioEl.style.display = 'none';
      monitorAudioEl.autoplay = true;
      monitorAudioEl.playsInline = true;
      document.body.appendChild(monitorAudioEl);
    }
    if (monitorAudioEl.srcObject !== stream) {
      monitorAudioEl.srcObject = stream;
      const p = monitorAudioEl.play();
      if (p && typeof p.then === 'function') p.catch((e) => console.warn('[SidePanel] monitor play blocked:', e));
    }
  } catch (e) {
    console.warn('[SidePanel] ensureElementMonitoring failed:', e);
  }
}

function preserveTabMutedState(tabId, muteDuringCapture) {
  try {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError || !tab) return;
      originalTabMutedInfo = { tabId, wasMuted: !!tab.mutedInfo?.muted };
      if (muteDuringCapture != null) {
        // If we explicitly choose to mute/unmute during capture based on monitoring preference
        chrome.tabs.update(tabId, { muted: !!muteDuringCapture });
      }
    });
  } catch (_) {}
}

function forceTabMute(mute) {
  try {
    if (originalTabMutedInfo && originalTabMutedInfo.tabId) {
      chrome.tabs.update(originalTabMutedInfo.tabId, { muted: !!mute });
    }
  } catch (_) {}
}

function waitForAudioTracks(stream, timeoutMs = 2000) {
  return new Promise((resolve) => {
    if (!stream) return resolve();
    const hasTracks = () => stream.getAudioTracks && stream.getAudioTracks().length > 0;
    if (hasTracks()) return resolve();
    let done = false;
    const onAddTrack = () => { if (!done && hasTracks()) { done = true; cleanup(); resolve(); } };
    const cleanup = () => {
      try { stream.removeEventListener && stream.removeEventListener('addtrack', onAddTrack); } catch (_) {}
      clearTimeout(timer);
    };
    try { stream.addEventListener && stream.addEventListener('addtrack', onAddTrack); } catch (_) {}
    const timer = setTimeout(() => { if (!done) { done = true; cleanup(); resolve(); } }, timeoutMs);
  });
}

const __testHooks = {
  triggerCapture: captureActiveTabAndStart,
  getState: () => ({
    recorder,
    mediaStream,
    tabStream,
    micStream,
    isActive
  })
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = __testHooks;
}
