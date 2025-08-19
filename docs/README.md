# Realtime Transcriptions Chrome Extension (Scaffold)

This project is a JavaScript-only Chrome Extension scaffold for real-time audio transcription. It contains no business logic yet—just the structure and configuration.

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

## Notes

- JavaScript only (no TypeScript).
- ESLint is configured with recommended rules for ES2021 and browser env.
