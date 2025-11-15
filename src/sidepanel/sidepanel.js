const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const downloadBtn = document.getElementById('downloadBtn');
const transcriptDiv = document.getElementById('transcript');
const statusDiv = document.getElementById('status');
const includeMicCheckbox = document.getElementById('includeMicrophone');
const engineSelect = document.getElementById('engineSelect');
// Backend-managed secrets: configure backendUrl in chrome.storage.local
const DEFAULT_BACKEND_URL = 'http://localhost:3001'; // change if you host elsewhere
let backend = { baseUrl: DEFAULT_BACKEND_URL };

const ENGINE_STORAGE_KEY = 'transcriptionEngine';
const ENGINES = Object.freeze({
  GEMINI: 'gemini',
  FASTER_WHISPER: 'faster_whisper'
});
const ENGINE_LABEL = {
  [ENGINES.GEMINI]: 'Gemini',
  [ENGINES.FASTER_WHISPER]: 'Faster Whisper'
};

let activeEngine = ENGINES.GEMINI;

let recorder;
let mediaStream; // final stream used by MediaRecorder (mixed or single source)
let tabStream;   // raw tab capture stream
let micStream;   // raw microphone stream
let audioCtx;    // shared AudioContext for mixing/monitoring
let monitorAudioEl; // optional <audio> element used to monitor tab-only/mic-only
let originalTabMutedInfo = null; // to restore tab's muted state on stop
const segmentQueue = [];
let isProcessing = false;

// Persistent WebSocket session (used for Faster Whisper)
let ws = null;
let wsReady = false;
let wsConnecting = false;
let livePartialEl = null; // current interim (partial) line
let lastFinalEl = null;   // last finalized line for potential replacement by 'final'
let transcriptSequence = 0; // counts final transcripts

// Accumulator for non-streaming (Gemini HTTP) responses that may return
// the full conversation so far. We derive deltas, append completed sentences,
// and keep an interim line for the current incomplete sentence.
const geminiState = {
  totalFinalText: '', // text already committed as final lines in the UI
  interimEl: null,    // current interim <p> element (if any)
  interimText: ''     // current interim text content
};

// State for WebSocket streaming (Faster Whisper) so we can append immediately
// when partial text contains complete sentences and keep a bold interim.
const wsState = {
  committedInUtterance: '', // text already appended for the current utterance
};

// Batching & rate limiting to avoid API 500s/throttling
// IMPORTANT: Do NOT use MediaRecorder timeslice. Instead, stop and recreate
// the recorder every CHUNK_MS so each blob is a complete, standalone file
// with a valid container/header (required by Gemini).
// Tune chunk size: smaller chunks yield more frequent backend responses.
// Keep conservative to avoid throttling; you can lower to 1500ms if your backend can handle it.
const CHUNK_MS = 2000; // target ~2s chunks for snappier updates
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
  chrome.storage?.local?.get(['backendUrl', ENGINE_STORAGE_KEY], (res) => {
    if (chrome.runtime.lastError) {
      console.warn('[SidePanel] storage.get error:', chrome.runtime.lastError);
    }
    const storedEngine = res && res[ENGINE_STORAGE_KEY];
    if (typeof storedEngine === 'string') {
      setActiveEngine(storedEngine, { silent: true });
    } else if (engineSelect && engineSelect.value !== activeEngine) {
      engineSelect.value = activeEngine;
    }

    if (res && typeof res.backendUrl === 'string' && res.backendUrl.trim()) {
      backend.baseUrl = res.backendUrl.trim().replace(/\/$/, '');
    }

    if (backend.baseUrl) {
      setStatus(`Using backend: ${backend.baseUrl} • Engine: ${describeEngine()}`);
    } else {
      setStatus(`Backend URL not set. Save backendUrl in chrome.storage.local • Engine: ${describeEngine()}`);
    }
  });
} catch (e) {
  console.warn('[SidePanel] chrome.storage not available:', e);
}

if (engineSelect) {
  engineSelect.addEventListener('change', () => {
    setActiveEngine(engineSelect.value, { persist: true });
  });
} else {
  console.warn('[SidePanel] engineSelect not found in DOM');
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

function formatTimestamp(date = new Date()) {
  // HH:MM:SS (local)
  return date.toTimeString().slice(0, 8);
}

function appendTranscript(html, { isFinal = true, speaker = null } = {}) {
  if (!transcriptDiv) return;
  const p = document.createElement('p');
  if (isFinal) {
    transcriptSequence += 1;
    const ts = formatTimestamp();
    p.dataset.seq = String(transcriptSequence);
    p.dataset.ts = ts;
    p.dataset.role = 'final';
    p.dataset.transcript = String(html);
    if (speaker) p.dataset.speaker = String(speaker);
    p.innerHTML = `<strong>[#${transcriptSequence} ${ts}]</strong> ${speaker ? speaker + ': ' : ''}${html}`;
    lastFinalEl = p;
  } else {
    p.dataset.role = 'interim';
    p.dataset.transcript = String(html);
    if (speaker) p.dataset.speaker = String(speaker);
    p.style.fontWeight = 'bold';
    p.style.color = '#000';
    p.style.background = 'rgba(0,0,0,0.05)';
    p.style.padding = '2px 4px';
    p.style.borderRadius = '3px';
    p.textContent = `${speaker ? speaker + ': ' : ''}${html}`;
  }
  transcriptDiv.appendChild(p);
  updateDownloadButtonState();
  return p;
}

function collectTranscriptLines() {
  if (!transcriptDiv) return [];
  const paragraphs = transcriptDiv.querySelectorAll('p');
  if (!paragraphs || paragraphs.length === 0) return [];
  return Array.from(paragraphs)
    .filter((node) => node.dataset?.role === 'final')
    .map((node) => {
      const seq = node.dataset.seq || '?';
      const ts = node.dataset.ts || formatTimestamp();
      const speaker = node.dataset.speaker ? `${node.dataset.speaker}: ` : '';
      const text = node.dataset.transcript || (node.textContent || '').replace(/^\[#?(\d+) .*?\]\s*/,'').trim();
      return `[#${seq} ${ts}] ${speaker}${text}`.trim();
    })
    .filter((text) => text.length > 0);
}

function updateDownloadButtonState() {
  if (!downloadBtn) return;
  const hasContent = collectTranscriptLines().length > 0;
  downloadBtn.disabled = !hasContent;
}

function triggerTranscriptDownload() {
  const lines = collectTranscriptLines();
  if (lines.length === 0) {
    setStatus('No transcript available to download yet.', 'warn');
    return;
  }
  try {
    const plainText = lines.join('\n\n');
    const blob = new Blob([plainText], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    const fileName = `transcript-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    setTimeout(() => URL.revokeObjectURL(url), 0);
    setStatus(`Transcript downloaded as ${fileName}`);
  } catch (err) {
    console.error('[SidePanel] Failed to download transcript:', err);
    setStatus('Unable to download transcript. See console.', 'error');
  }
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

function normalizeEngine(value) {
  if (!value) return ENGINES.GEMINI;
  const normalized = String(value).toLowerCase();
  return normalized === ENGINES.FASTER_WHISPER ? ENGINES.FASTER_WHISPER : ENGINES.GEMINI;
}

function describeEngine(engine = activeEngine) {
  return ENGINE_LABEL[engine] || engine;
}

function setActiveEngine(engine, { persist = false, silent = false } = {}) {
  const normalized = normalizeEngine(engine);
  activeEngine = normalized;
  if (engineSelect && engineSelect.value !== normalized) {
    engineSelect.value = normalized;
  }
  if (persist && chrome?.storage?.local?.set) {
    try {
      chrome.storage.local.set({ [ENGINE_STORAGE_KEY]: normalized }, () => {
        if (chrome.runtime?.lastError) {
          console.warn('[SidePanel] storage.set error:', chrome.runtime.lastError);
        }
      });
    } catch (e) {
      console.warn('[SidePanel] storage.set threw:', e);
    }
  }
  if (!silent) {
    setStatus(`Engine set to ${describeEngine(normalized)}`);
  }
  return normalized;
}

function getActiveEngine() {
  return activeEngine;
}

if (engineSelect) {
  engineSelect.value = activeEngine;
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
      const engineForRequest = getActiveEngine();
      if (engineForRequest === ENGINES.FASTER_WHISPER) {
        // Stream this segment over the persistent WebSocket
        const ok = await ensureWsConnected();
        if (!ok) {
          appendTranscript('<span style="color:red;">Streaming not available. See console.</span>');
          backoff = backoff ? Math.min(backoff * 2, MAX_BACKOFF_MS) : INITIAL_BACKOFF_MS;
          await sleep(backoff);
          continue;
        }
        try {
          const ab = await segment.arrayBuffer();
          ws.send(ab);
          backoff = 0;
          await sleep(MIN_GAP_BETWEEN_REQUESTS_MS);
        } catch (e) {
          console.error('[SidePanel] WS send failed:', e);
          appendTranscript('<span style="color:red;">Failed sending audio to stream.</span>');
          backoff = backoff ? Math.min(backoff * 2, MAX_BACKOFF_MS) : INITIAL_BACKOFF_MS;
          await sleep(backoff);
        }
      } else {
        // Gemini (HTTP): derive deltas and update UI incrementally
        let base64;
        try {
          base64 = await blobToBase64(segment);
        } catch (e) {
          console.error('[SidePanel] blobToBase64 failed:', e);
          appendTranscript('<span style="color:red;">Failed to prepare audio chunk.</span>');
          continue;
        }
        const { text, label } = await callBackendTranscribe({
          engine: engineForRequest,
          chunks: [{ base64 }],
          mimeType: currentMime
        });
        console.log('[SidePanel] Transcription result:', text);
        if (label === 'error') {
          appendTranscript(`<span style=\"color:red;\">${describeEngine(engineForRequest)} error. Backing off…</span>`);
          backoff = backoff ? Math.min(backoff * 2, MAX_BACKOFF_MS) : INITIAL_BACKOFF_MS;
          await sleep(backoff);
        } else {
          if (text) handleGeminiUpdate(text);
          backoff = 0; // reset on success
          await sleep(MIN_GAP_BETWEEN_REQUESTS_MS);
        }
      }
    }
  } finally {
    isProcessing = false;
  }
}

// Split text into an array of complete sentence strings and a leftover string (no terminal punctuation)
function splitIntoSentences(text) {
  const sentences = [];
  let idx = 0;
  const re = /([\s\S]*?[\.\!\?…]+)(\s+|$)/g; // greedy up to terminal punctuation
  let m;
  while ((m = re.exec(text)) !== null) {
    const sentence = (m[1] || '').trim();
    if (sentence) sentences.push(sentence);
    idx = re.lastIndex;
  }
  const leftover = text.slice(idx).trim();
  return { sentences, leftover };
}

function finalizeInterimAs(sentence, speaker = null) {
  if (!geminiState.interimEl) return null;
  try {
    transcriptSequence += 1;
    const ts = formatTimestamp();
    const p = geminiState.interimEl;
    p.dataset.role = 'final';
    p.dataset.seq = String(transcriptSequence);
    p.dataset.ts = ts;
    p.dataset.transcript = sentence;
    if (speaker) p.dataset.speaker = speaker;
    p.style.fontWeight = 'normal';
    p.style.color = '';
    p.style.background = '';
    p.style.padding = '';
    p.style.borderRadius = '';
    p.innerHTML = `<strong>[#${transcriptSequence} ${ts}]</strong> ${speaker ? speaker + ': ' : ''}${sentence}`;
    lastFinalEl = p;
    geminiState.interimEl = null;
    geminiState.interimText = '';
    updateDownloadButtonState();
    return p;
  } catch (e) {
    console.warn('[SidePanel] finalizeInterimAs failed:', e);
    return null;
  }
}

// Handles a full-text transcript update from Gemini by appending only the delta
// and showing the current trailing partial as an interim line.
function handleGeminiUpdate(fullText) {
  // Prefer simple monotonic growth assumption; if not, compute a safe prefix.
  let baseLen = geminiState.totalFinalText.length;
  if (fullText.length < baseLen || fullText.slice(0, baseLen) !== geminiState.totalFinalText) {
    // Fallback: find longest common prefix
    const max = Math.min(fullText.length, baseLen);
    let i = 0;
    while (i < max && fullText.charCodeAt(i) === geminiState.totalFinalText.charCodeAt(i)) i++;
    baseLen = i;
  }
  const incoming = fullText.slice(baseLen);
  if (!incoming) return; // no change

  // If an interim exists and the new incoming begins with it, try to complete it first
  let rest = incoming;
  if (geminiState.interimEl && geminiState.interimText && incoming.startsWith(geminiState.interimText)) {
    const candidate = incoming; // includes prior interim prefix
    const { sentences, leftover } = splitIntoSentences(candidate);
    if (sentences.length > 0) {
      // First sentence completes the interim
      const first = sentences[0];
      finalizeInterimAs(first);
      geminiState.totalFinalText = fullText.slice(0, baseLen) + first;
      // Append any additional complete sentences after the first
      for (let j = 1; j < sentences.length; j++) {
        appendTranscript(sentences[j]);
        geminiState.totalFinalText += sentences[j];
      }
      rest = leftover;
    }
  } else {
    // No usable interim; append all complete sentences from incoming
    const { sentences, leftover } = splitIntoSentences(incoming);
    if (sentences.length > 0) {
      sentences.forEach((s) => {
        appendTranscript(s);
        geminiState.totalFinalText += s;
      });
    }
    rest = leftover;
  }

  // Update or create interim with the leftover (if any)
  if (rest && rest.length > 0) {
    if (!geminiState.interimEl) {
      geminiState.interimEl = appendTranscript(rest, { isFinal: false });
    } else {
      geminiState.interimEl.dataset.transcript = rest;
      geminiState.interimEl.textContent = rest;
    }
    geminiState.interimText = rest;
  } else {
    // No leftover; clear interim if present
    geminiState.interimEl = null;
    geminiState.interimText = '';
  }
}

function buildWsUrl() {
  try {
    if (!backend.baseUrl) return null;
    const url = new URL(backend.baseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = (url.pathname?.replace(/\/$/, '') || '') + '/ws/transcribe';
    url.search = `engine=${encodeURIComponent(ENGINES.FASTER_WHISPER)}`;
    return url.toString();
  } catch (e) {
    console.warn('[SidePanel] Invalid backend URL for WS:', e);
    return null;
  }
}

async function ensureWsConnected() {
  if (ws && wsReady) return true;
  if (wsConnecting) {
    // Wait briefly for existing attempt
    for (let i = 0; i < 10; i++) {
      await sleep(100);
      if (ws && wsReady) return true;
    }
  }
  const wsUrl = buildWsUrl();
  if (!wsUrl) return false;
  try {
    wsConnecting = true;
    ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    wsReady = false;

    ws.addEventListener('open', () => {
      wsReady = true;
      setStatus(`Streaming connected • ${describeEngine(ENGINES.FASTER_WHISPER)}`);
    });
    ws.addEventListener('message', (evt) => {
      try {
        const data = typeof evt.data === 'string' ? JSON.parse(evt.data) : null;
        if (!data) return;
        const txt = typeof data.text === 'string' ? data.text.trim() : '';
        const speaker = typeof data.speaker === 'string' ? data.speaker.trim() : null;
        // PARTIAL (interim): append any complete sentences immediately, keep trailing as bold
        if (data.type === 'partial') {
          if (!txt) return;
          // Combine what we've already committed for this utterance with the new partial
          const combined = wsState.committedInUtterance + txt;
          const { sentences, leftover } = splitIntoSentences(combined);
          // Append any new complete sentences beyond what we've already committed
          let newlyCommitted = '';
          const already = wsState.committedInUtterance;
          const afterPrefix = combined.slice(already.length);
          if (afterPrefix) {
            const { sentences: addl, leftover: rem } = splitIntoSentences(afterPrefix);
            addl.forEach((s) => appendTranscript(s, { isFinal: true, speaker }));
            newlyCommitted = addl.join('');
          }
          wsState.committedInUtterance += newlyCommitted;
          // Update or create interim with leftover from the combined string
          const finalLeftover = combined.slice(wsState.committedInUtterance.length);
          if (finalLeftover) {
            if (!livePartialEl) {
              livePartialEl = appendTranscript(finalLeftover, { isFinal: false, speaker });
            } else {
              livePartialEl.dataset.transcript = finalLeftover;
              if (speaker) livePartialEl.dataset.speaker = speaker;
              livePartialEl.textContent = `${speaker ? speaker + ': ' : ''}${finalLeftover}`;
            }
          } else if (livePartialEl) {
            // Nothing left; clear the interim line (it will be finalized when boundary arrives)
            livePartialEl.remove();
            livePartialEl = null;
          }
          updateDownloadButtonState();
          return;
        }
        // BOUNDARY (utterance_end): finalize current interim immediately
        if (data.type === 'boundary' && data.event === 'utterance_end') {
            if (livePartialEl && livePartialEl.parentNode) {
              try {
                transcriptSequence += 1;
                const ts = formatTimestamp();
                livePartialEl.dataset.role = 'final';
                livePartialEl.dataset.seq = String(transcriptSequence);
                livePartialEl.dataset.ts = ts;
                if (speaker) livePartialEl.dataset.speaker = speaker;
                const raw = livePartialEl.dataset.transcript || livePartialEl.textContent || '';
                // Remove interim styling
                livePartialEl.style.fontWeight = 'normal';
                livePartialEl.style.color = '';
                livePartialEl.style.background = '';
                livePartialEl.style.padding = '';
                livePartialEl.style.borderRadius = '';
                livePartialEl.innerHTML = `<strong>[#${transcriptSequence} ${ts}]</strong> ${speaker ? speaker + ': ' : ''}${raw}`;
                lastFinalEl = livePartialEl;
              } catch (e) {
                console.warn('[SidePanel] boundary finalize failed:', e);
              }
            }
            // Reset utterance state after boundary
            livePartialEl = null;
            wsState.committedInUtterance = '';
            updateDownloadButtonState();
            return;
        }
        // FINAL: do not replace prior lines. If final contains extra beyond what we appended, append the delta
        if (data.type === 'final' && txt) {
          const currentSoFar = wsState.committedInUtterance + (livePartialEl?.dataset?.transcript || '');
          if (txt.startsWith(currentSoFar)) {
            const delta = txt.slice(currentSoFar.length);
            if (delta) {
              const { sentences, leftover } = splitIntoSentences(delta);
              sentences.forEach((s) => appendTranscript(s, { isFinal: true, speaker }));
              wsState.committedInUtterance += sentences.join('');
              if (leftover && livePartialEl) {
                livePartialEl.dataset.transcript = leftover;
                if (speaker) livePartialEl.dataset.speaker = speaker;
                livePartialEl.textContent = `${speaker ? speaker + ': ' : ''}${leftover}`;
              }
            }
          } else if (livePartialEl) {
            // If we have an interim without boundary yet, finalize directly with final text
            transcriptSequence += 1;
            const ts = formatTimestamp();
            livePartialEl.dataset.role = 'final';
            livePartialEl.dataset.seq = String(transcriptSequence);
            livePartialEl.dataset.ts = ts;
            livePartialEl.dataset.transcript = txt;
            if (speaker) livePartialEl.dataset.speaker = speaker;
            livePartialEl.style.fontWeight = 'normal';
            livePartialEl.style.color = '';
            livePartialEl.style.background = '';
            livePartialEl.style.padding = '';
            livePartialEl.style.borderRadius = '';
            livePartialEl.innerHTML = `<strong>[#${transcriptSequence} ${ts}]</strong> ${speaker ? speaker + ': ' : ''}${txt}`;
            lastFinalEl = livePartialEl;
            livePartialEl = null;
            wsState.committedInUtterance = '';
          } else {
            // No prior lines, just append new final
            appendTranscript(txt, { isFinal: true, speaker });
          }
          updateDownloadButtonState();
          return;
        }
        if (data.type === 'error') {
          setStatus(`Stream error: ${data.error}`, 'error');
        }
      } catch (_) {}
    });
    ws.addEventListener('close', () => {
      wsReady = false;
      wsConnecting = false;
      ws = null;
      // Keep partial lines appended as historical context
      livePartialEl = null;
      if (isActive) setStatus('Streaming disconnected', 'warn');
    });
    ws.addEventListener('error', (e) => {
      console.warn('[SidePanel] WS error:', e);
    });

    // Wait for readiness up to 2s
    for (let i = 0; i < 20 && !wsReady; i++) {
      await sleep(100);
    }
    return !!wsReady;
  } catch (e) {
    console.error('[SidePanel] Failed to open WS:', e);
    wsConnecting = false;
    wsReady = false;
    ws = null;
    return false;
  } finally {
    wsConnecting = false;
  }
}

async function callBackendTranscribe({ chunks, mimeType, engine }) {
  const chosenEngine = normalizeEngine(engine);
  try {
    if (!backend.baseUrl) throw new Error('Backend URL not configured');
    const url = `${backend.baseUrl}/transcribe`;
    const chunkPayload = Array.isArray(chunks) ? chunks.map((c) => c.base64) : [];
    const body = {
      engine: chosenEngine,
      chunks: chunkPayload,
      mimeType: mimeType || 'audio/webm'
    };
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
    let text;
    if (typeof data?.text === 'string') {
      text = data.text;
    } else if (Array.isArray(data?.candidates)) {
      const parts = [];
      data.candidates.forEach((candidate) => {
        const candidateParts = candidate?.content?.parts;
        if (Array.isArray(candidateParts)) {
          candidateParts.forEach((part) => {
            if (typeof part?.text === 'string' && part.text.trim()) {
              parts.push(part.text.trim());
            }
          });
        }
      });
      if (parts.length > 0) {
        text = parts.join(' ').trim();
      }
    }
    if (typeof text !== 'string') {
      throw new Error('No transcript returned by backend');
    }
    text = typeof text.trim === 'function' ? text.trim() : text;
    const label = typeof data?.label === 'string' ? data.label : 'ok';
    const seq = Number.isInteger(data?.seq) ? data.seq : 0;
    return { text, label, seq };
  } catch (error) {
    console.error(`[SidePanel] Error calling backend (${describeEngine(chosenEngine)}):`, error);
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
  setStatus(`Requesting audio… (${describeEngine(getActiveEngine())})`);
  // Clean up any previous streams before starting a new capture
  try {
    [mediaStream, tabStream, micStream].forEach((s) => {
      try { s && s.getTracks().forEach((t) => t.stop()); } catch (_) {}
    });
    mediaStream = null; tabStream = null; micStream = null;
  if (audioCtx) { try { audioCtx.close(); } catch (_) {} audioCtx = null; }
  } catch (_) {}
  // Reset Gemini accumulation state for a fresh session
  geminiState.totalFinalText = '';
  geminiState.interimEl = null;
  geminiState.interimText = '';
    // Reset WS utterance state
    wsState.committedInUtterance = '';
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

if (downloadBtn) {
  downloadBtn.addEventListener('click', triggerTranscriptDownload);
  updateDownloadButtonState();
} else {
  console.error('[SidePanel] downloadBtn not found in DOM');
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
      // Finalize any pending interim line before tearing down
      if (geminiState.interimEl && geminiState.interimText) {
        try { finalizeInterimAs(geminiState.interimText); } catch (_) {}
      }
      // Close WS session if any
      try {
        if (ws) {
          try { ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ event: 'end' })); } catch (_) {}
          setTimeout(() => { try { ws.close(1000, 'user stop'); } catch (_) {} }, 50);
        }
      } catch (_) {}
      // Keep previously appended partial lines; clear current pointer only
      livePartialEl = null;
      transcriptSequence = transcriptSequence; // keep sequence for next session if desired
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
        const recordGain = audioCtx.createGain();
        recordGain.gain.value = 0.9;
        const monitorGain = audioCtx.createGain();
        monitorGain.gain.value = 0.9;
        sources.push({ src, recordGain, monitorGain, kind: 'tab' });
      } catch (e) {
        console.warn('[SidePanel] Could not create source for tab stream:', e);
      }
    }
    if (hasAudioTracks(micS)) {
      try {
        const src = audioCtx.createMediaStreamSource(micS);
        const recordGain = audioCtx.createGain();
        recordGain.gain.value = 0.9;
        const monitorGain = audioCtx.createGain();
        monitorGain.gain.value = 0;
        sources.push({ src, recordGain, monitorGain, kind: 'mic' });
      } catch (e) {
        console.warn('[SidePanel] Could not create source for mic stream:', e);
      }
    }

    if (sources.length === 0) {
      // If neither stream yields a source node, fall back to direct stream usage
      if (tabS) {
        setStatus('Capturing tab (tracks not detected yet)');
        return useNoMonitorRoute(tabS, { allowMonitor: true });
      }
      if (micS) {
        setStatus('Capturing microphone (tracks not detected yet)');
        return useNoMonitorRoute(micS, { allowMonitor: false });
      }
      setStatus('No audio sources available.', 'error');
      return;
    }

    const mixBus = audioCtx.createGain();
    mixBus.gain.value = 1;
    const monitorBus = audioCtx.createGain();
    monitorBus.gain.value = 1;
    let monitorConnected = false;

    sources.forEach(({ src, recordGain, monitorGain }) => {
      try {
        src.connect(recordGain);
        recordGain.connect(mixBus);
      } catch (e) {
        console.warn('[SidePanel] Failed to wire record path:', e);
      }
      if (monitorGain) {
        try {
          src.connect(monitorGain);
          monitorGain.connect(monitorBus);
          if (monitorGain.gain.value !== 0) {
            monitorConnected = true;
          }
        } catch (e) {
          console.warn('[SidePanel] Failed to wire monitor path:', e);
        }
      }
    });

    const mediaDest = audioCtx.createMediaStreamDestination();
    mixBus.connect(mediaDest);

    if (monitorConnected) {
      try {
        monitorBus.connect(audioCtx.destination);
      } catch (e) {
        console.warn('[SidePanel] Failed to route monitor bus to destination:', e);
      }
    }

  // Update status based on which sources are active
    if (sources.length === 2) setStatus('Capturing tab + microphone');
    else if (hasAudioTracks(tabS)) setStatus('Capturing tab audio');
    else setStatus('Capturing microphone audio');

    if (hasAudioTracks(tabS)) {
      try {
        ensureElementMonitoring(tabS);
      } catch (e) {
        console.warn('[SidePanel] Unable to monitor tab audio:', e);
      }
    }

      setFinalStream(mediaDest.stream);
  } catch (e) {
    console.error('[SidePanel] Error preparing audio mix:', e);
    setStatus('Failed to prepare audio mix. Using available source.', 'warn');
    // Fallback: prefer tab, else mic; even if tracks are not yet detectable, proceed
    if (tabS) return useNoMonitorRoute(tabS, { allowMonitor: true });
    if (micS) return useNoMonitorRoute(micS, { allowMonitor: false });
    setStatus('No audio sources available.', 'error');
  }

  function useNoMonitorRoute(stream, { allowMonitor = true } = {}) {
    try {
      if (allowMonitor) ensureElementMonitoring(stream);
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
    isActive,
    engine: getActiveEngine()
  })
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = __testHooks;
}
