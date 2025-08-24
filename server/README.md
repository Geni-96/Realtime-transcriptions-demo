# Minimal Transcription Backend

- Node/Express backend that proxies audio to Gemini. Secrets stay on server.

## Setup

1. Copy `.env.example` to `.env` and set:
   - `GEMINI_API_KEY` – your Gemini API key
   - `PORT` – optional (default 3001)

2. Install and run:

```bash
cd server
npm install
npm run start
```

3. Health check:

- GET http://localhost:3001/health -> `{ ok: true }`

## API

POST /transcribe
- Request JSON:
  - `chunks`: array of base64 strings (audio chunks)
  - `mimeType`: audio type; parameters like `;codecs=opus` are stripped
- Response JSON:
  - `{ text: string }`

## Client config

In the extension side panel DevTools console:

```js
chrome.storage.local.set({ backendUrl: 'http://localhost:3001' })
```

Then click Start in the side panel.

## Notes
- WebM/Opus chunks should be sent one at a time to avoid invalid container concatenation.
- The server strips MIME params and uses `inlineData` payload format required by Gemini.
- Increase express.json limit if you plan to send larger chunks.
