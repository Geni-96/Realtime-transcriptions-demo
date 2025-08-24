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
      // Try to parse JSON error to pass through
      try {
        const asJson = JSON.parse(txt);
        return res.status(resp.status).json(asJson);
      } catch {
        return res.status(resp.status).type('text/plain').send(txt);
      }
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
