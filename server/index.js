require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const ffmpegPath = require('ffmpeg-static');

const app = express();
app.use(cors());
app.use(express.json({ limit: '15mb' }));

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL = normalizeModelName(process.env.GEMINI_MODEL) || 'gemini-2.0-flash-lite';
const API_VERSION = (process.env.GEMINI_API_VERSION || 'v1beta').trim();
const GEMINI_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS || 30000);
const GEMINI_RETRY_BASE_MS = Number(process.env.GEMINI_RETRY_BASE_MS || 1000);
const GEMINI_RETRY_MAX_MS = Number(process.env.GEMINI_RETRY_MAX_MS || 8000);
const GEMINI_RETRY_BACKOFF = Number(process.env.GEMINI_RETRY_BACKOFF || 2);

const ENGINES = Object.freeze({
  GEMINI: 'gemini',
  FASTER_WHISPER: 'faster_whisper'
});

const DEFAULT_FASTER_WHISPER_WS_URL = 'ws://localhost:8000/ws';
const FASTER_WHISPER_WS_URL = (() => {
  const raw = process.env.FASTER_WHISPER_WS_URL;
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  return DEFAULT_FASTER_WHISPER_WS_URL;
})();
const FASTER_WHISPER_TIMEOUT_MS = Number(process.env.FASTER_WHISPER_TIMEOUT_MS || 45000);
const FASTER_WHISPER_FRAME_BYTES = 640;
const FASTER_WHISPER_SAMPLE_RATE = 16000;
const FASTER_WHISPER_POST_STREAM_DELAY_MS = Number(process.env.FASTER_WHISPER_POST_STREAM_DELAY_MS || 200);

const WAIT = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (!ffmpegPath) {
  console.warn('[Server] ffmpeg-static binary not found; Faster Whisper engine will be unavailable.');
}

if (!GEMINI_API_KEY && process.env.NODE_ENV !== 'test') {
  console.warn('[Server] GEMINI_API_KEY not set. Set it in .env');
}

function normalizeModelName(name) {
  return (name || '').replace(/^models\//, '').trim();
}

function buildModelFallbacks(preferred) {
  const ordered = [];
  const add = (value) => {
    const normalized = normalizeModelName(value);
    if (normalized && !ordered.includes(normalized)) ordered.push(normalized);
  };

  add(preferred);

  if (preferred.endsWith('-latest')) {
    add(preferred.replace(/-latest$/, '-001'));
  } else if (/-\d+$/.test(preferred)) {
    add(preferred.replace(/-\d+$/, '-latest'));
  }

  const curatedFallbacks = [
    'gemini-2.0-flash-lite-001',
    'gemini-2.0-flash',
    'gemini-2.5-flash-lite',
    'gemini-2.5-flash',
    'gemini-flash-latest',
  ];

  for (const candidate of curatedFallbacks) {
    add(candidate);
  }

  return ordered;
}

function normalizeEngineChoice(value) {
  if (!value) return ENGINES.GEMINI;
  const normalized = String(value).trim().toLowerCase();
  return normalized === ENGINES.FASTER_WHISPER ? ENGINES.FASTER_WHISPER : ENGINES.GEMINI;
}

function sanitizeMime(m) {
  if (!m) return 'audio/webm';
  const base = String(m).split(';')[0].trim();
  const allowed = ['audio/webm', 'audio/ogg', 'audio/mp3', 'audio/mpeg', 'audio/wav'];
  return allowed.includes(base) ? base : 'audio/webm';
}

async function callGeminiModel({ model, body }) {
  const url = `https://generativelanguage.googleapis.com/${API_VERSION}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const raw = await resp.text();
    let parsed;
    if (raw) {
      try { parsed = JSON.parse(raw); } catch (_) { parsed = null; }
    }

    if (!resp.ok) {
      const err = new Error(parsed?.error?.message || raw || `Gemini error ${resp.status}`);
      err.httpStatus = resp.status;
      err.httpBody = parsed || raw;
      throw err;
    }

    const data = parsed ?? (raw ? JSON.parse(raw) : {});
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join(' ').trim();
    if (!text) {
      const err = new Error('No transcript returned');
      err.httpStatus = 502;
      err.httpBody = data;
      throw err;
    }
    return { text, data };
  } finally {
    clearTimeout(timeoutId);
  }
}

function convertToPCM16LE(buffer, { sampleRate = FASTER_WHISPER_SAMPLE_RATE } = {}) {
  if (!buffer || buffer.length === 0) {
    return Promise.resolve(Buffer.alloc(0));
  }
  if (!ffmpegPath) {
    return Promise.reject(new Error('ffmpeg-static binary not found. Install ffmpeg-static or set FFMPEG_PATH.'));
  }
  return new Promise((resolve, reject) => {
    const args = [
      '-loglevel', 'error',
      '-i', 'pipe:0',
      '-ac', '1',
      '-ar', String(sampleRate),
      '-f', 's16le',
      'pipe:1'
    ];
    const ffmpeg = spawn(ffmpegPath, args);
    const chunks = [];
    let stderr = '';

    ffmpeg.stdout.on('data', (chunk) => chunks.push(chunk));
    ffmpeg.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    ffmpeg.on('error', reject);
    ffmpeg.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks));
      } else {
        reject(new Error(`ffmpeg exited with code ${code}: ${stderr || 'unknown error'}`));
      }
    });
    ffmpeg.stdin.on('error', (err) => {
      if (err.code === 'EPIPE') return;
      reject(err);
    });
    ffmpeg.stdin.end(buffer);
  });
}

function extractTextFromParsedMessage(obj) {
  if (!obj || typeof obj !== 'object') return '';
  const directKeys = ['text', 'transcript', 'message', 'utterance', 'result', 'partial'];
  for (const key of directKeys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  const nestedPaths = [
    ['data', 'text'],
    ['data', 'transcript'],
    ['result', 'text'],
    ['result', 'transcript'],
    ['detail', 'text']
  ];

  for (const path of nestedPaths) {
    let current = obj;
    for (const segment of path) {
      current = current?.[segment];
      if (current == null) break;
    }
    if (typeof current === 'string' && current.trim()) {
      return current.trim();
    }
  }

  if (Array.isArray(obj.segments)) {
    const joined = obj.segments
      .map((segment) => (typeof segment?.text === 'string' ? segment.text.trim() : ''))
      .filter(Boolean)
      .join(' ')
      .trim();
    if (joined) return joined;
  }

  if (Array.isArray(obj.results)) {
    const nested = obj.results
      .map((result) => extractTextFromParsedMessage(result))
      .filter(Boolean)
      .join(' ')
      .trim();
    if (nested) return nested;
  }

  return '';
}

function detectFinalFlag(obj) {
  if (!obj || typeof obj !== 'object') return false;
  const booleanKeys = ['final', 'is_final', 'done', 'finished', 'complete', 'completed'];
  if (booleanKeys.some((key) => obj[key] === true)) {
    return true;
  }

  const stringKeys = ['type', 'event', 'state', 'stage', 'message_type'];
  for (const key of stringKeys) {
    const value = obj[key];
    if (typeof value === 'string') {
      const normalized = value.toLowerCase();
      if (normalized.includes('final') || normalized === 'complete' || normalized === 'completed' || normalized === 'finished') {
        return true;
      }
    }
  }

  if (obj.result && typeof obj.result === 'object') {
    if (detectFinalFlag(obj.result)) {
      return true;
    }
  }

  if (Array.isArray(obj.segments)) {
    return obj.segments.some((segment) => detectFinalFlag(segment));
  }

  return false;
}

function parseFasterWhisperMessage(payload) {
  let stringPayload = '';
  if (Buffer.isBuffer(payload)) {
    stringPayload = payload.toString('utf8');
  } else if (typeof payload === 'string') {
    stringPayload = payload;
  }

  let parsed;
  if (stringPayload) {
    try {
      parsed = JSON.parse(stringPayload);
    } catch (_) {
      parsed = null;
    }
  }

  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const text = extractTextFromParsedMessage(parsed).trim();
    const isFinal = detectFinalFlag(parsed);
    return { text, isFinal };
  }

  const trimmed = stringPayload.trim();
  return { text: trimmed, isFinal: true };
}

async function streamPcmBuffersThroughWs(pcmBuffers) {
  if (!Array.isArray(pcmBuffers) || pcmBuffers.length === 0) {
    return { text: '' };
  }

  return new Promise((resolve, reject) => {
    const finalParts = [];
    let latestPartial = '';
    let finished = false;

    const ws = new WebSocket(FASTER_WHISPER_WS_URL, {
      handshakeTimeout: Math.min(FASTER_WHISPER_TIMEOUT_MS, 10000)
    });

    const overallTimer = FASTER_WHISPER_TIMEOUT_MS > 0
      ? setTimeout(() => cleanup(new Error('Faster Whisper timed out')), FASTER_WHISPER_TIMEOUT_MS)
      : null;

    const sendFrame = (frame) => new Promise((resolveSend, rejectSend) => {
      ws.send(frame, { binary: true }, (err) => (err ? rejectSend(err) : resolveSend()));
    });

    const cleanup = (err) => {
      if (finished) return;
      finished = true;
      if (overallTimer) clearTimeout(overallTimer);
      try {
        ws.removeAllListeners();
      } catch (_) {}
      try {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.terminate();
        }
      } catch (_) {}
      if (err) {
        reject(err);
      } else {
        const text = [...finalParts, latestPartial].filter(Boolean).join(' ').trim();
        resolve({ text });
      }
    };

    ws.on('open', () => {
      (async () => {
        try {
          for (const pcm of pcmBuffers) {
            if (!pcm || pcm.length === 0) continue;
            for (let offset = 0; offset < pcm.length; offset += FASTER_WHISPER_FRAME_BYTES) {
              const slice = pcm.subarray(offset, offset + FASTER_WHISPER_FRAME_BYTES);
              let frame = slice;
              if (slice.length < FASTER_WHISPER_FRAME_BYTES) {
                frame = Buffer.alloc(FASTER_WHISPER_FRAME_BYTES);
                slice.copy(frame);
              }
              await sendFrame(frame);
            }
          }
          if (FASTER_WHISPER_POST_STREAM_DELAY_MS > 0) {
            await WAIT(FASTER_WHISPER_POST_STREAM_DELAY_MS);
          }
          ws.close(1000, 'end of audio');
        } catch (err) {
          cleanup(err);
        }
      })();
    });

    ws.on('message', (payload) => {
      const { text, isFinal } = parseFasterWhisperMessage(payload);
      if (!text) return;
      if (isFinal) {
        if (finalParts.length === 0 || finalParts[finalParts.length - 1] !== text) {
          finalParts.push(text);
        }
        latestPartial = '';
      } else {
        latestPartial = text;
      }
    });

    ws.once('error', (err) => cleanup(err));
    ws.on('close', () => cleanup());
  });
}

async function transcribeWithFasterWhisper({ chunks, mimeType }) {
  if (!Array.isArray(chunks) || chunks.length === 0) {
    throw new Error('Missing chunks');
  }
  if (!FASTER_WHISPER_WS_URL) {
    throw new Error('FASTER_WHISPER_WS_URL not configured');
  }

  const pcmBuffers = [];
  for (const b64 of chunks) {
    if (typeof b64 !== 'string' || !b64) continue;
    const audioBuffer = Buffer.from(b64, 'base64');
    if (!audioBuffer.length) continue;
    // Convert each chunk to PCM 16LE at 16 kHz to satisfy Faster Whisper API.
    const pcm = await convertToPCM16LE(audioBuffer, { sampleRate: FASTER_WHISPER_SAMPLE_RATE });
    if (pcm.length) {
      pcmBuffers.push(pcm);
    }
  }

  if (pcmBuffers.length === 0) {
    return { text: '' };
  }

  const { text } = await streamPcmBuffersThroughWs(pcmBuffers);
  return { text };
}

app.get('/health', (_req, res) => res.json({ ok: true }));

const isRetryableError = (error) => {
  if (!error) return false;
  if (error.name === 'AbortError') return true;

  const status = error?.httpStatus ?? error?.status;
  const message = String(error?.message || error || '');
  if (status && [404, 409, 425, 429, 500, 503].includes(Number(status))) {
    return true;
  }
  if (/aborted|timeout|timed\s*out|deadline/i.test(message)) {
    return true;
  }
  return /not\s+found|not\s+supported|overload|try again later|temporarily unavailable|backend error/i.test(message);
};

app.post('/transcribe', async (req, res) => {
  let engine = ENGINES.GEMINI;
  try {
    const { chunks, mimeType, engine: requestedEngine } = req.body || {};
    if (!Array.isArray(chunks) || chunks.length === 0) {
      return res.status(400).json({ error: 'Missing chunks' });
    }

    engine = normalizeEngineChoice(requestedEngine);

    if (engine === ENGINES.FASTER_WHISPER) {
      try {
        const result = await transcribeWithFasterWhisper({ chunks, mimeType });
        return res.json({ text: result.text, engine });
      } catch (err) {
        console.error('[Server] Faster Whisper transcription failed:', err);
        const status =
          err?.code === 'ECONNREFUSED' || err?.code === 'ECONNRESET'
            ? 503
            : err?.httpStatus || err?.status || (err?.message && /ffmpeg/i.test(err.message) ? 500 : 502);
        return res.status(status).json({ error: String(err?.message || err), engine });
      }
    }

    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: 'Server not configured: GEMINI_API_KEY missing', engine });
    }

    const cleanMime = sanitizeMime(mimeType);
    const parts = [
      { text: 'Transcribe the following audio into plain text. Respond with transcript only.' },
      ...chunks.map((b64) => ({ inlineData: { mimeType: cleanMime, data: b64 } })),
    ];
    const body = { contents: [{ role: 'user', parts }] };

    const candidates = buildModelFallbacks(MODEL);
    let lastError = null;
    let backoffDelay = 0;

    for (const candidate of candidates) {
      try {
        const result = await callGeminiModel({ model: candidate, body });
        if (candidate !== MODEL) {
          console.warn(`[Server] Fallback Gemini model used: ${candidate}`);
        }
        return res.json({ text: result.text, model: candidate, engine });
      } catch (err) {
        lastError = { err, model: candidate };
        if (err?.name === 'AbortError' && !err.httpStatus) {
          err.httpStatus = 504;
        }
        const retryable = isRetryableError(err);
        const message = String(err?.message || err);
        console.warn(`[Server] Model ${candidate} failed (${message}).${retryable ? ' Trying next fallback…' : ''}`);
        if (!retryable) {
          const status = err?.httpStatus || err?.status || (err?.name === 'AbortError' ? 504 : 500);
          return res.status(status).json({ error: message, details: err?.httpBody, model: candidate, engine });
        }

        if (backoffDelay <= 0) {
          backoffDelay = GEMINI_RETRY_BASE_MS;
        } else {
          backoffDelay = Math.min(backoffDelay * GEMINI_RETRY_BACKOFF, GEMINI_RETRY_MAX_MS);
        }
        if (backoffDelay > 0) {
          await WAIT(backoffDelay);
        }
      }
    }

    const fallbackMessage = lastError?.err?.message || 'No compatible Gemini model available';
    const status = lastError?.err?.httpStatus === 404
      ? 404
      : (lastError?.err?.httpStatus || (lastError?.err?.name === 'AbortError' ? 504 : 502));
    return res.status(status).json({
      error: fallbackMessage,
      triedModels: candidates,
      details: lastError?.err?.httpBody,
      engine
    });
  } catch (err) {
    console.error('[Server] /transcribe error:', err);
    const status = err?.name === 'AbortError' ? 504 : 500;
    return res.status(status).json({ error: String(err?.message || err), engine });
  }
});

const PORT = Number(process.env.PORT || 3001);

// Create an HTTP server so we can attach a WebSocket server for streaming sessions
const server = http.createServer(app);

// WebSocket endpoint: persistent transcription sessions
// Client protocol:
// - Connect to ws://host/ws/transcribe?engine=faster_whisper
// - First JSON message is optional; if provided can include { engine, mimeType }
// - Subsequent binary messages are audio container chunks (webm/ogg/wav/mp3)
// - Server converts each chunk to PCM16LE @ 16k and streams frames to the upstream Faster Whisper WS
// - Upstream partial/final transcript messages are forwarded to the client as JSON: { type: 'partial'|'final', text }
// - Send { event: 'end' } to flush and close the upstream session
const wss = new WebSocket.Server({ server, path: '/ws/transcribe' });

function buildWsUrl(base) {
  try {
    return new URL(base);
  } catch (_) {
    return null;
  }
}

// Simple FIFO to serialize async tasks
class AsyncQueue {
  constructor() { this.chain = Promise.resolve(); }
  push(task) {
    this.chain = this.chain.then(() => task()).catch(() => {});
    return this.chain;
  }
}

wss.on('connection', (client, req) => {
  const params = new URLSearchParams((req.url || '').split('?')[1] || '');
  const requestedEngine = normalizeEngineChoice(params.get('engine'));
  const engine = requestedEngine || ENGINES.FASTER_WHISPER;

  // Only Faster Whisper is supported via WS for now
  if (engine !== ENGINES.FASTER_WHISPER) {
    client.send(JSON.stringify({ type: 'error', error: 'Only faster_whisper engine is supported over WebSocket' }));
    client.close(1002, 'unsupported engine');
    return;
  }

  if (!FASTER_WHISPER_WS_URL) {
    client.send(JSON.stringify({ type: 'error', error: 'FASTER_WHISPER_WS_URL not configured' }));
    client.close(1011, 'server not configured');
    return;
  }

  let upstream;
  let closed = false;
  const sendQueue = new AsyncQueue();

  const finalize = (code = 1000, reason = 'done') => {
    if (closed) return;
    closed = true;
    try { client.close(code, reason); } catch (_) {}
    try { if (upstream && (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING)) upstream.terminate(); } catch (_) {}
  };

  // Connect upstream to Faster Whisper server
  try {
    upstream = new WebSocket(FASTER_WHISPER_WS_URL, { handshakeTimeout: Math.min(FASTER_WHISPER_TIMEOUT_MS, 10000) });
  } catch (err) {
    client.send(JSON.stringify({ type: 'error', error: String(err?.message || err) }));
    return finalize(1011, 'upstream connect failed');
  }

  upstream.on('open', () => {
    try { client.send(JSON.stringify({ type: 'ready' })); } catch (_) {}
  });

  upstream.on('message', (payload) => {
    const { text, isFinal } = parseFasterWhisperMessage(payload);
    if (!text) return;
    const msg = JSON.stringify({ type: isFinal ? 'final' : 'partial', text });
    try { client.send(msg); } catch (_) {}
  });

  upstream.once('error', (err) => {
    try { client.send(JSON.stringify({ type: 'error', error: String(err?.message || err) })); } catch (_) {}
    finalize(1011, 'upstream error');
  });

  upstream.on('close', () => {
    finalize(1000, 'upstream closed');
  });

  const sendPcmFrames = async (pcm) => {
    if (!pcm || !pcm.length) return;
    if (!upstream || upstream.readyState !== WebSocket.OPEN) return;
    for (let offset = 0; offset < pcm.length; offset += FASTER_WHISPER_FRAME_BYTES) {
      const slice = pcm.subarray(offset, Math.min(offset + FASTER_WHISPER_FRAME_BYTES, pcm.length));
      let frame = slice;
      if (slice.length < FASTER_WHISPER_FRAME_BYTES) {
        frame = Buffer.alloc(FASTER_WHISPER_FRAME_BYTES);
        slice.copy(frame);
      }
      await new Promise((resolveSend, rejectSend) => {
        upstream.send(frame, { binary: true }, (err) => (err ? rejectSend(err) : resolveSend()));
      });
    }
  };

  client.on('message', (data, isBinary) => {
    // Control messages
    if (!isBinary) {
      let parsed = null;
      try { parsed = JSON.parse(typeof data === 'string' ? data : data.toString('utf8')); } catch (_) {}
      const evt = parsed?.event;
      if (evt === 'end') {
        // Give ASR a brief moment to emit final results
        const closeLater = async () => {
          if (FASTER_WHISPER_POST_STREAM_DELAY_MS > 0) {
            await WAIT(FASTER_WHISPER_POST_STREAM_DELAY_MS);
          }
          try { upstream?.close(1000, 'end of audio'); } catch (_) {}
        };
        return void closeLater();
      }
      return; // ignore other JSON messages for now
    }

    // Binary audio container chunk -> convert to PCM and stream frames upstream in order
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    sendQueue.push(async () => {
      try {
        const pcm = await convertToPCM16LE(buffer, { sampleRate: FASTER_WHISPER_SAMPLE_RATE });
        await sendPcmFrames(pcm);
      } catch (err) {
        try { client.send(JSON.stringify({ type: 'error', error: String(err?.message || err) })); } catch (_) {}
      }
    });
  });

  client.once('error', () => finalize(1006, 'client error'));
  client.on('close', () => finalize(1000, 'client closed'));
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`[Server] listening on http://localhost:${PORT}`);
  });
}

module.exports = {
  app,
  server,
  normalizeModelName,
  buildModelFallbacks,
  normalizeEngineChoice,
  _internals: {
    isRetryableError,
    callGeminiModel,
    sanitizeMime,
    convertToPCM16LE,
    parseFasterWhisperMessage,
    transcribeWithFasterWhisper,
  },
};
