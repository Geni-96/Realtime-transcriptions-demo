# Realtime Transcriptions Demo (Extension)

This Chrome extension captures tab audio and streams it to a minimal Node backend which proxies requests to Gemini for transcription.

## Update: Standalone audio chunks per request

To avoid `INVALID_ARGUMENT` from Gemini, the extension now ensures every audio chunk is a complete, standalone file with a valid container header.

- We no longer use `MediaRecorder.start(timeslice)`.
- Instead, the recorder is stopped and recreated about every 3 seconds.
- Each resulting Blob is a full WebM/Opus file with headers, suitable for Gemini.

You can adjust the chunk duration by editing `CHUNK_MS` in `src/sidepanel/sidepanel.js`.

## Trade-offs

- There may be tiny gaps between chunks during the stop/start cycle. In practice this is small (milliseconds) and near real-time behavior is preserved.
- If you need seamless audio, consider server-side remuxing/transcoding (e.g., via ffmpeg) and stream to Gemini as a single file.

## How it works

- The side panel captures active tab audio via `chrome.tabCapture`.
- Audio is recorded in sessions using `MediaRecorder` without timeslicing. Each session is ~3s.
- On each session stop, the final `Blob` is sent as base64 to the backend `/transcribe` endpoint.
- The backend forwards the audio as `inlineData` parts to Gemini and returns the transcript.

## Backend

- See `server/` for setup. Configure `GEMINI_API_KEY` in `.env`.
- Save the backend URL in the extension via DevTools console:

```js
chrome.storage.local.set({ backendUrl: 'http://localhost:3001' })
```

## Troubleshooting

- If you still see `INVALID_ARGUMENT`, confirm the server logs show each chunk size > 0 and that the MIME is `audio/webm`.
- Try increasing `CHUNK_MS` (e.g., 4000–6000) to reduce frequency of requests.
- Ensure Chrome permissions allow `tabCapture`.
