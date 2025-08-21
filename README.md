
# Real-Time Audio Transcription Chrome Extension

Capture and transcribe audio from any browser tab in real time, with a simple and powerful sidepanel interface.

---

## Table of Contents
- [Features](#features)
- [Installation](#installation)
- [Usage](#usage)
- [FAQ](#faq)
- [Support](#support)
- [License](#license)

---

## Features
- **Sidepanel Interface:**
  - Start/stop recording with clear visual feedback
  - Live transcription display with auto-scroll and per-chunk timestamps
  - Status indicators for recording, connection, and errors
  - Meeting/session timer
  - Export transcript (download .txt) and Copy to Clipboard
- **Audio Capture:**
  - Capture audio from the active browser tab
  - (Bonus) Multi-tab and microphone support, with channel labeling
  - Chunked transcription every 30 seconds, with 3-second overlap for accuracy
- **Transcription APIs:**
  - Google Gemini 2.5 Flash (recommended)
  - OpenAI Whisper, Deepgram, Fireworks (fallbacks)
- **Reliability & Performance:**
  - Automatic retry logic, user-friendly error messages
  - Offline buffering and sync (bonus)
  - Efficient CPU/memory usage for long sessions

---

## Installation

### From Chrome Web Store
1. Visit the Chrome Web Store and search for "Real-Time Audio Transcription".
2. Click "Add to Chrome" and confirm installation.

### Manual Installation
1. Download or clone this repository.
2. Open `chrome://extensions` in your browser.
3. Enable "Developer mode" (top right).
4. Click "Load unpacked" and select the extension folder.

---

## Usage
1. Click the extension icon in your Chrome toolbar.
2. Grant required permissions (audio capture, tab access, etc.) if prompted.
3. Open the sidepanel and click "Start Recording".
4. Watch live transcription update every ~30 seconds as chunks (each line prefixed with a timestamp).
5. Pause, resume, or stop recording as needed.
6. Export (.txt) or copy the transcript at any time. The transcript auto-scrolls to the latest entry.

---

## FAQ

**Q: What tabs can I transcribe?**
A: Any tab playing audio (e.g., Google Meet, YouTube, etc.).

**Q: Is my data private?**
A: Transcripts are processed securely and stored locally unless exported.

**Q: What if my internet disconnects?**
A: The extension buffers audio locally and syncs when connection is restored (if enabled).

**Q: Which transcription API is used?**
A: Google Gemini 2.5 Flash. Configure your API key and model in `src/background/config.js` (use `config.example.js` as a guide; do not commit secrets).

---

## Support
- For issues or feature requests, open a GitHub issue in this repository.
- For help, contact the maintainer via GitHub.

---

## License
MIT
