# Minimal Transcription Backend

- Node/Express backend that proxies audio to Gemini. Secrets stay on server.

## Setup

1. Copy `.env.example` to `.env` and set:
  - `GEMINI_API_KEY` – your Gemini API key
  - `GEMINI_MODEL` – optional (defaults to `gemini-2.0-flash-lite`; falls back to `gemini-2.0-flash-lite-001`, `gemini-2.0-flash`, `gemini-2.5-flash-lite`, `gemini-2.5-flash`, `gemini-flash-latest`)
  - `GEMINI_API_VERSION` – optional (defaults to `v1beta`)
  - `GEMINI_TIMEOUT_MS` – optional (defaults to `30000` ms request timeout)
  - `GEMINI_RETRY_BASE_MS` – optional initial retry delay (default `1000`)
  - `GEMINI_RETRY_BACKOFF` – optional multiplier applied each retry (default `2`)
  - `GEMINI_RETRY_MAX_MS` – optional cap for retry delay (default `8000`)
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
