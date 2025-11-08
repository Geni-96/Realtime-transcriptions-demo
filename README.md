# Realtime Transcriptions Demo (Extension)

This Chrome extension captures tab audio and streams it to a minimal Node backend which proxies requests to Gemini for transcription.

## Faster Whisper Streaming (Persistent WebSocket)

You can choose `Faster Whisper` in the side panel to enable low‑latency streaming transcription.

### How streaming works now

1. The extension opens a single persistent WebSocket to the backend at `ws://<backend-host>/ws/transcribe?engine=faster_whisper`.
2. Each 3s recorded WebM/Opus blob is sent as binary over that same connection (no base64 wrapping needed).
3. The backend incrementally converts every blob to 16 kHz PCM using `ffmpeg`, slices it into 640‑byte frames, and forwards those frames over a second persistent WebSocket to the Faster Whisper server (`FASTER_WHISPER_WS_URL`).
4. Partial and final transcript messages from Faster Whisper are proxied back to the extension as JSON messages `{ type: 'partial'|'final', text }`.
5. Final messages are appended automatically to the transcript panel; partials are not shown (to keep UI simpler) but could be surfaced if desired.

### Why this fixes missing words

Previously every chunk opened a **new** Faster Whisper WS session, causing boundary resets and occasional loss of trailing or leading words. Maintaining a single session preserves decoding context across chunk boundaries and greatly reduces dropped words. If you still notice omissions, you can:

- Increase `CHUNK_MS` (e.g. 4000–5000) for fewer boundaries.
- Add a small overlap when recording (not yet implemented—possible future enhancement with AudioWorklet).
- Verify upstream model settings (e.g., temperature or beam parameters) if you control the Faster Whisper server.

### Environment variables (backend)

| Variable | Purpose | Default |
|----------|---------|---------|
| `FASTER_WHISPER_WS_URL` | Upstream Faster Whisper WebSocket endpoint | `ws://localhost:8000/ws` |
| `FASTER_WHISPER_TIMEOUT_MS` | Session timeout | `45000` |
| `FASTER_WHISPER_POST_STREAM_DELAY_MS` | Delay before closing upstream after end signal | `200` |

Gemini continues to work unchanged; switch engines via the dropdown anytime.

## Recording strategy (chunked standalone blobs)

To avoid `INVALID_ARGUMENT` from Gemini, the extension now ensures every audio chunk is a complete, standalone file with a valid container header.

- We no longer use `MediaRecorder.start(timeslice)`.
- Instead, the recorder is stopped and recreated about every 3 seconds.
- Each resulting Blob is a full WebM/Opus file with headers, suitable for Gemini.

You can adjust the chunk duration by editing `CHUNK_MS` in `src/sidepanel/sidepanel.js`.

### Trade-offs

- There may be tiny gaps between chunks during the stop/start cycle. In practice this is small (milliseconds) and near real-time behavior is preserved.
- If you need seamless audio, consider server-side remuxing/transcoding (e.g., via ffmpeg) and stream to Gemini as a single file.

## High-level flow (Gemini vs Faster Whisper)

| Step | Gemini path | Faster Whisper path |
|------|-------------|---------------------|
| Capture | `chrome.tabCapture` (+ optional mic) | Same |
| Recording | Restart `MediaRecorder` every `CHUNK_MS` | Same |
| Transport | HTTP POST `/transcribe` with base64 `inlineData` parts | Persistent WS `/ws/transcribe` sending raw WebM blobs |
| Backend action | Send all blobs in one request to Gemini | Convert each blob -> PCM frames -> stream upstream |
| Response parsing | Collect single final transcript | Stream partial/final messages; append finals |
| Session lifecycle | Stateless per chunk | One WS until user stops |

- The side panel captures active tab audio via `chrome.tabCapture`.
- Audio is recorded in sessions using `MediaRecorder` without timeslicing. Each session is ~3s.
- On each session stop, the final `Blob` is sent as base64 to the backend `/transcribe` endpoint.
- The backend forwards the audio as `inlineData` parts to Gemini and returns the transcript.

## Backend setup

- See `server/` for setup. Configure `GEMINI_API_KEY` in `.env`.
- Save the backend URL in the extension via DevTools console:

```js
chrome.storage.local.set({ backendUrl: 'http://localhost:3001' })
```

## Troubleshooting & Tips

- If you still see `INVALID_ARGUMENT`, confirm the server logs show each chunk size > 0 and that the MIME is `audio/webm`.
- Try increasing `CHUNK_MS` (e.g., 4000–6000) to reduce frequency of requests.
- Ensure Chrome permissions allow `tabCapture`.

## Testing

- Install dependencies with `npm install` in the repository root and `npm install --prefix server` (or `npm ci --prefix server`) for the backend helpers.
- Run unit tests locally with `npm test`. The suite exercises both tab/mic capture flows and verifies the engine selector logic.

## Continuous Integration

- GitHub Actions runs the same `npm test` suite on every push and pull request targeting `main` or `tester`.
- The workflow lives in `.github/workflows/ci.yml` and uses Node 20 with npm dependency caching for faster builds.
