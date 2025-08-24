// Audio capture utilities for tab and microphone.
// Designed for use from both the background service worker (tab capture)
// and the sidepanel (microphone capture).

/**
 * Contract
 * - Each start*Capture returns an object with stop() and isRunning()
 * - onChunk is called with { blob, mimeType, source, label, meta }
 */

// Segmenting strategy:
// - Build segments of segmentMs (default 30s). After the first segment, new
//   segments include the last overlapMs (default 3s) worth of audio from the
//   previous segment.
// - We estimate chunk durations using the MediaRecorder timeslice value. This
//   avoids decoding; it is sufficient for stable segmentation.
// - Emitted segments contain arrays of chunks with { blob, ms } metadata; callers
//   can concatenate or stream chunk-wise to a backend.

function createRecorder(stream, { timeslice = 250, source = 'unknown', label = source, onChunk, onSegment, segmentMs = 30000, overlapMs = 3000 }) {
  // Ensure we have an audio track; otherwise MediaRecorder will fail to start
  try {
    const tracks = typeof stream.getAudioTracks === 'function' ? stream.getAudioTracks() : [];
    if (!tracks || tracks.length === 0) {
      try { stream.getTracks?.().forEach((t) => t.stop()); } catch (_) {}
      throw new Error('No audio track in captured stream. Ensure the tab/system prompt had "Share audio" enabled and that audio is playing.');
    }
  } catch (e) {
    // If stream is malformed, bail early
    throw e;
  }
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
  // Buffering state
  let segChunks = []; // [{ blob, ms }]
  let segDuration = 0; // ms
  let overlapChunks = []; // carry last overlapMs ms from previous segment
  let hasPrevSegment = false;
  let seq = 1;

  recorder.ondataavailable = (ev) => {
    if (!ev.data || ev.data.size === 0) return;
    const chunkMime = ev.data.type || mimeType || 'application/octet-stream';
    const ms = timeslice || 250; // estimated
    const chunk = { blob: ev.data, ms, mimeType: chunkMime };

    // Stream raw chunks if requested (debug/monitoring)
    try { onChunk?.({ blob: ev.data, mimeType: chunkMime, source, label, meta: { ms } }); } catch (e) { console.warn('[audio] onChunk error', e); }

    // Accumulate into segment
    segChunks.push(chunk);
    segDuration += ms;

    const threshold = hasPrevSegment ? Math.max(0, segmentMs - overlapMs) : segmentMs;
    if (segDuration >= threshold) {
      // Build segment: include overlap for subsequent segments
      const segmentChunks = hasPrevSegment ? [...overlapChunks, ...segChunks] : [...segChunks];
      const totalMs = (hasPrevSegment ? overlapMs : 0) + segDuration;
      const segment = { chunks: segmentChunks, totalMs, overlapMs: hasPrevSegment ? overlapMs : 0, mimeType: chunkMime, source, label, seq };
      try { onSegment?.(segment); } catch (e) { console.warn('[audio] onSegment error', e); }

      // Compute new overlap from the tail of the just-emitted segment
      let carry = [];
      let acc = 0;
      for (let i = segmentChunks.length - 1; i >= 0 && acc < overlapMs; i -= 1) {
        carry.unshift(segmentChunks[i]);
        acc += segmentChunks[i].ms;
      }
      overlapChunks = carry;

      // Reset for next segment
      segChunks = [];
      segDuration = 0;
      hasPrevSegment = true;
      seq += 1;
    }
  };
  recorder.onstart = () => { running = true; };
  recorder.onstop = () => { running = false; };
  recorder.onerror = (e) => console.warn('[audio] recorder error', e);

  recorder.start(timeslice);

  function flushPendingSegment() {
    if (segChunks.length === 0) return;
    const segmentChunks = hasPrevSegment ? [...overlapChunks, ...segChunks] : [...segChunks];
    const totalMs = (hasPrevSegment ? overlapMs : 0) + segDuration;
    const segment = { chunks: segmentChunks, totalMs, overlapMs: hasPrevSegment ? overlapMs : 0, mimeType: mimeType || 'application/octet-stream', source, label, seq };
    try { onSegment?.(segment); } catch (e) { console.warn('[audio] onSegment error', e); }
    // compute new overlap (not strictly needed on final flush)
    segChunks = [];
    segDuration = 0;
    hasPrevSegment = true;
    seq += 1;
  }
  return {
    stop() {
      try { flushPendingSegment(); } catch (_) {}
      try { recorder.stop(); } catch (_) {}
      try { stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
    },
    isRunning() { return running; },
    stream,
    recorder,
    mimeType: mimeType || 'application/octet-stream',
    flush: flushPendingSegment,
  };
}

// Background/extension context only (chrome.tabCapture)
export async function startTabCapture({ onChunk, onSegment, targetTabId, timeslice = 250, segmentMs = 30000, overlapMs = 3000 } = {}) {
  if (!chrome?.tabCapture) throw new Error('tabCapture API not available');
  const options = {
    audio: true,
    video: false,
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
  return createRecorder(stream, { timeslice, source: 'tab', label, onChunk, onSegment, segmentMs, overlapMs });
}

// Window/page context only (sidepanel): microphone via getUserMedia
export async function startMicCapture({ onChunk, onSegment, deviceId, timeslice = 250, segmentMs = 30000, overlapMs = 3000 } = {}) {
  if (!navigator?.mediaDevices?.getUserMedia) throw new Error('getUserMedia not available');
  const constraints = { audio: deviceId ? { deviceId: { exact: deviceId } } : true, video: false };
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  return createRecorder(stream, { timeslice, source: 'mic', label: 'mic', onChunk, onSegment, segmentMs, overlapMs });
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

// Fallback: capture shared tab/system audio via getDisplayMedia (user picks target)
export async function startShareAudioCapture({ onChunk, onSegment, timeslice = 250, segmentMs = 30000, overlapMs = 3000 } = {}) {
  if (!navigator?.mediaDevices?.getDisplayMedia) throw new Error('getDisplayMedia not available');
  // Most browsers will prompt the user to choose a tab/window/screen and optionally share audio
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: false });
  } catch (e) {
    // Some Chrome versions require video with getDisplayMedia; try with video:true
    stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
  }
  // On some platforms the returned stream may not include audio if the user didn’t check "Share audio"
  return createRecorder(stream, { timeslice, source: 'share', label: 'share', onChunk, onSegment, segmentMs, overlapMs });
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

// Post a segmented batch to background. Encodes each chunk to base64, preserving ms per chunk.
export async function postSegmentToBackground(segment) {
  const { chunks, mimeType, source, label, totalMs, overlapMs, seq } = segment;
  try {
    const encoded = await Promise.all(
      chunks.map(async (c) => {
        const ab = await c.blob.arrayBuffer();
        const base64 = btoa(String.fromCharCode(...new Uint8Array(ab)));
        return { base64, ms: c.ms };
      }),
    );
    chrome.runtime.sendMessage({
      source: 'audioCapture',
      type: 'AUDIO_SEGMENT',
      payload: { chunks: encoded, mimeType, source, label, totalMs, overlapMs, seq },
    });
  } catch (e) {
    console.warn('[audio] postSegmentToBackground failed', e);
  }
}

