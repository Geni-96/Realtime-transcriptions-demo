require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '15mb' }));

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-flash';

if (!GEMINI_API_KEY) {
  console.warn('[Server] GEMINI_API_KEY not set. Set it in .env');
}

app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/transcribe', async (req, res) => {
  try {
    const { chunks, mimeType } = req.body || {};
    if (!Array.isArray(chunks) || chunks.length === 0) {
      return res.status(400).json({ error: 'Missing chunks' });
    }
    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: 'Server not configured: GEMINI_API_KEY missing' });
    }
    const parts = [
      { text: 'Transcribe the following audio into plain text. Respond with transcript only.' },
      ...chunks.map((b64) => ({ inline_data: { mime_type: mimeType || 'audio/webm', data: b64 } })),
    ];
    const body = { contents: [{ role: 'user', parts }] };

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), 30000);
    let resp;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(id);
    }
    if (!resp.ok) {
      const txt = await resp.text().catch(() => String(resp.status));
      return res.status(resp.status).type('text/plain').send(txt);
    }
    const data = await resp.json();
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join(' ').trim();
    if (!text) return res.status(502).json({ error: 'No transcript returned' });
    return res.json({ text });
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
