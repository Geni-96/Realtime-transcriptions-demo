# Chrome Extension: Real-Time Audio Transcription

## Project Overview
A Chrome extension that captures audio from browser tabs and provides real-time transcription via a user-friendly sidepanel interface.

## Core Features
### 1. Sidepanel Interface
- **Primary Controls:** Start/stop recording buttons with clear visual states
- **Live Transcription Display:** Transcript updates with auto-scroll
- **Status Indicators:** Recording state, connection status, error notifications
- **Meeting Timer:** Session duration display
- **Export Functionality:** Copy transcript to clipboard or download as text/JSON

### 2. Audio Capture System
- **Tab Audio Capture:** Capture audio from the active browser tab
- **Multi-source Support (Bonus):**
  - Capture audio from inactive tabs
  - Optional microphone input capture
  - Channel labeling (Tab Audio vs Microphone)
- **Processing Options:**
  - Chunked Mode: Transcribe audio segments every 30 seconds
  - Bonus: 3-second overlap between chunks to avoid word loss

### 3. Transcription Integration
- **API Selection (in order of preference):**
  - Google Gemini 2.5 Flash (multi-modal LLM, free credits available)
  - OpenAI Whisper API
  - Deepgram API
  - Fireworks API

### 4. Reliability & Performance
- **Error Handling:**
  - Automatic retry logic with exponential backoff
  - Graceful degradation when APIs are unavailable
  - User-friendly error messages
- **Offline Capabilities (Bonus):**
  - Local audio buffering during connection loss
  - Automatic sync when connection restored
  - Queue management for failed requests
- **Performance Optimization:**
  - Minimal CPU usage
  - Memory management for long sessions
  - Background processing to avoid UI blocking

## Technical Requirements
- **Browser Compatibility:** Chrome 88+ (getDisplayMedia API)
- **Permissions:**
  - Required: tabCapture, activeTab, sidePanel, storage
  - Optional: microphone, background
- **Architecture:**
  - Manifest V3
  - Service Worker for background/API calls
  - Minimal content scripts
  - Sidepanel as main UI

## User Experience
- **Interface Design:** Clean, minimal layout (see TwinMind Chrome extension for reference)
- **Real-time Updates:** Streaming or refresh every 30 seconds
- **Timestamp Integration:** Configurable time markers
- **Visual Feedback:** Clear indicators for recording, processing, errors
- **Accessibility:** Keyboard navigation, screen reader support

## Workflow
1. User opens sidepanel
2. Grants permissions
3. Clicks start recording
4. Transcription appears with timestamps
5. Pause/resume/stop controls
6. Export options available

## Development Guidelines
- **Error Handling:**
  - User-friendly messages
  - Automatic retry (max 3)
  - Fallback options
  - Comprehensive logging
- **API Integration:**
  - Recommended: Google Gemini 2.5 Flash

## Submission Requirements
1. **Code Repository:**
   - Public GitHub repo
   - Setup instructions, API key config
   - ESLint, proper comments
   - Demo video (2-3 min)
2. **Backend Services (if applicable):**
   - Live backend (Heroku, Vercel, etc.)
   - Environment variable docs
   - Health endpoints
3. **Chrome Extension Package:**
   - Zip file for Chrome Web Store
   - Distribution via Drive, Dropbox, or GitHub
   - Installation guide
4. **Additional Deliverables:**
   - Architecture diagram
   - Performance report
   - Known limitations

## Success Criteria
### Minimum Viable Product (MVP)
- Captures audio from active tab
- Updates transcript every 30 seconds
- Start/stop controls
- Basic error handling
- Export/copy transcript

### Excellent Implementation
- All MVP features plus:
- Multi-tab audio capture
- Channel labeling
- Offline buffering
- Performance optimization
- Comprehensive error handling
- Good UI/UX for tab audio capture
- 3-second overlap between chunks

---

## License
MIT
