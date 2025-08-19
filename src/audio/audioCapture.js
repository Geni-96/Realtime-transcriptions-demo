// Audio capture utilities for tab and microphone.
// Designed for use from both the background service worker (tab capture)
// and the sidepanel (microphone capture).

/**
 * Contract
 * - Each start*Capture returns an object with stop() and isRunning()
 * - onChunk is called with { blob, mimeType, source, label, meta }
 */

function createRecorder(stream, { timeslice = 250, source = 'unknown', label = source, onChunk }) {
  const mimeType = (() => {
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/ogg',
    ];
    for (const t of candidates) {
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported?.(t)) return t;
    }
    return '';
  })();

  let recorder;
  try {
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  } catch (e) {
    console.error('[audio] Failed to create MediaRecorder', e);
    throw e;
  }

  let running = false;
  recorder.ondataavailable = (ev) => {
    if (!ev.data || ev.data.size === 0) return;
    try {
      onChunk?.({ blob: ev.data, mimeType: ev.data.type || mimeType || 'application/octet-stream', source, label, meta: {} });
    } catch (e) {
      console.warn('[audio] onChunk error', e);
    }
  };
  recorder.onstart = () => { running = true; };
  recorder.onstop = () => { running = false; };
  recorder.onerror = (e) => console.warn('[audio] recorder error', e);

  recorder.start(timeslice);
  return {
    stop() {
      try { recorder.stop(); } catch (_) {}
      try { stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
    },
    isRunning() { return running; },
    stream,
    recorder,
    mimeType: mimeType || 'application/octet-stream',
  };
}

// Background/extension context only (chrome.tabCapture)
export async function startTabCapture({ onChunk, targetTabId } = {}) {
  if (!chrome?.tabCapture) throw new Error('tabCapture API not available');
  const options = {
    audio: true,
    video: false,
    // Some Chrome versions support targetTabId for non-active tabs; ignore if unsupported
    // @ts-ignore
    targetTabId,
  };
  const stream = await new Promise((resolve, reject) => {
    try {
      chrome.tabCapture.capture(options, (mediaStream) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!mediaStream) {
          reject(new Error('Failed to capture tab audio'));
          return;
        }
        resolve(mediaStream);
      });
    } catch (e) {
      reject(e);
    }
  });

  const label = typeof targetTabId === 'number' ? `tab:${targetTabId}` : 'tab:active';
  return createRecorder(stream, { source: 'tab', label, onChunk });
}

// Window/page context only (sidepanel): microphone via getUserMedia
export async function startMicCapture({ onChunk, deviceId } = {}) {
  if (!navigator?.mediaDevices?.getUserMedia) throw new Error('getUserMedia not available');
  const constraints = { audio: deviceId ? { deviceId: { exact: deviceId } } : true, video: false };
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  return createRecorder(stream, { source: 'mic', label: 'mic', onChunk });
}

// Optional: merge multiple streams into a multichannel stream (best-effort)
export async function startMergedCapture({ streams, labels = [], onChunk, timeslice = 250 }) {
  if (!streams || streams.length === 0) throw new Error('No streams to merge');
  const ctx = new (globalThis.AudioContext || globalThis.webkitAudioContext)();
  const merger = ctx.createChannelMerger(streams.length);
  streams.forEach((s, i) => {
    const src = ctx.createMediaStreamSource(s);
    // Route each source to its own channel
    // Note: createMediaStreamDestination collapses to stereo in many browsers; true multichannel is best-effort.
    src.connect(merger, 0, i);
  });
  const dest = ctx.createMediaStreamDestination();
  merger.connect(dest);

  const label = labels.length ? `merged:${labels.join('+')}` : 'merged';
  return createRecorder(dest.stream, { timeslice, source: 'merged', label, onChunk });
}

// Utilities to send audio to background for transcription
export function postChunkToBackground({ blob, mimeType, source, label, meta }) {
  const reader = new FileReader();
  reader.onload = () => {
    const base64 = btoa(String.fromCharCode(...new Uint8Array(reader.result)));
    chrome.runtime.sendMessage({
      source: 'audioCapture',
      type: 'AUDIO_CHUNK',
      payload: { base64, mimeType, source, label, meta }
    });
  };
  reader.readAsArrayBuffer(blob);
}

