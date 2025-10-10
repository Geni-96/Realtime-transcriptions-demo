require('dotenv').config();
const express = require('express');
const cors = require('cors');

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

const WAIT = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (!GEMINI_API_KEY) {
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
    'gemini-2.0-flash-lite',
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

app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/transcribe', async (req, res) => {
  try {
    // console.log("Post request", req)
    const b64 = req.body?.chunks?.[0]; 
    const buf = Buffer.from(b64 || '', 'base64'); 
    console.log('[Diag] size:', buf.length, 'first bytes:', [...buf.subarray(0, 8)]);
    const { chunks, mimeType } = req.body || {};
    if (!Array.isArray(chunks) || chunks.length === 0) {
      return res.status(400).json({ error: 'Missing chunks' });
    }
    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: 'Server not configured: GEMINI_API_KEY missing' });
    }
    // Sanitize mime: Gemini expects mimeType without parameters
    const sanitizeMime = (m) => {
      if (!m) return 'audio/webm';
      const base = String(m).split(';')[0].trim();
      // Allow only known audio types; default to audio/webm
      const allowed = ['audio/webm', 'audio/ogg', 'audio/mp3', 'audio/mpeg', 'audio/wav'];
      return allowed.includes(base) ? base : 'audio/webm';
    };
    const cleanMime = sanitizeMime(mimeType);

    const parts = [
      { text: 'Transcribe the following audio into plain text. Respond with transcript only.' },
      ...chunks.map((b64) => ({ inlineData: { mimeType: cleanMime, data: b64 } })),
    ];
    const body = { contents: [{ role: 'user', parts }] };

    const candidates = buildModelFallbacks(MODEL);
    let lastError = null;
    let backoffDelay = 0;

    const isRetryableError = (status, message) => {
      if (!status && !message) return false;
      const normalizedStatus = Number(status) || undefined;
      const text = message || '';
      if (normalizedStatus && [404, 409, 425, 429, 500, 503].includes(normalizedStatus)) {
        return true;
      }
      return /not\s+found|not\s+supported|overload|try again later|temporarily unavailable|backend error/i.test(text);
    };

    for (const candidate of candidates) {
      try {
        const result = await callGeminiModel({ model: candidate, body });
        if (candidate !== MODEL) {
          console.warn(`[Server] Fallback Gemini model used: ${candidate}`);
        }
        return res.json({ text: result.text, model: candidate });
      } catch (err) {
        lastError = { err, model: candidate };
        const status = err?.httpStatus || err?.status;
        const message = String(err?.message || err);
        const retryable = isRetryableError(status, message);
        console.warn(`[Server] Model ${candidate} failed (${message}).${retryable ? ' Trying next fallback…' : ''}`);
        if (!retryable) {
          return res.status(status || 500).json({ error: message, details: err?.httpBody, model: candidate });
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
    const status = lastError?.err?.httpStatus === 404 ? 404 : (lastError?.err?.httpStatus || 502);
    return res.status(status).json({
      error: fallbackMessage,
      triedModels: candidates,
      details: lastError?.err?.httpBody,
    });
  } catch (err) {
    console.error('[Server] /transcribe error:', err);
    const status = err?.name === 'AbortError' ? 504 : 500;
    return res.status(status).json({ error: String(err?.message || err) });
  }
});

const PORT = Number(process.env.PORT || 3001);
app.listen(PORT, () => {
  console.log(`[Server] listening on http://localhost:${PORT}`);
});
