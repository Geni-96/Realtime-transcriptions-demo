# Realtime Transcriptions Chrome Extension (Scaffold)

This project is a JavaScript-only Chrome Extension for real-time audio transcription. It captures audio, sends 30s segments to Gemini, and renders transcripts in the Side Panel.

## Structure

- `src/sidepanel/` — UI HTML/CSS/JS for the Side Panel
- `src/background/` — Service worker (MV3)
- `src/audio/` — Audio capture and processing modules
- `src/utils/` — Shared helper utilities
- `assets/` — Extension icons
- `docs/` — Documentation

## Development

1. Open Chrome and go to `chrome://extensions`.
2. Enable Developer mode.
3. Click "Load unpacked" and select this project folder.
4. Verify the extension loads with no errors in the Extensions page.

## Transcript display and export

- Real-time updates: transcript chunks arrive roughly every 30 seconds (with a 3s overlap for accuracy).
- Each chunk is rendered with a timestamp (local time) and auto-scrolls the view to the latest entry.
- Export: click "Export (.txt)" to download the entire transcript with timestamps.
- Copy: click "Copy" to copy the transcript to the clipboard (screen reader friendly with an SR-only alert).
- Accessibility: transcript area uses role="log" and aria-live="polite"; controls have accessible labels and are keyboard friendly.

## Notes

- JavaScript only (no TypeScript).
- ESLint is configured with recommended rules for ES2021 and browser env.
