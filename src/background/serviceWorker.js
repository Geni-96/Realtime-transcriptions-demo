chrome.runtime.onInstalled.addListener(() => {
  console.log('[SW] extension installed');
});

const Youtube_ORIGIN = 'https://www.youtube.com';

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (!tab.url) return;
  const url = new URL(tab.url);
  // Enables the side panel on youtube.com
  if (url.origin === Youtube_ORIGIN) {
    try {
      console.debug('[SW] Enabling side panel on YouTube for tab', tabId, url.href);
      await chrome.sidePanel.setOptions({
        tabId,
        // Path should be relative to the extension root, not this file
        path: 'src/sidepanel/sidepanel.html',
        enabled: true
      });
    } catch (e) {
      console.error('[SW] Failed to enable side panel', e);
    }
  } else {
    // Disables the side panel on all other sites
    try {
      console.debug('[SW] Disabling side panel for tab', tabId, url.href);
      await chrome.sidePanel.setOptions({
        tabId,
        enabled: false
      });
    } catch (e) {
      console.error('[SW] Failed to disable side panel', e);
    }
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.debug('[SW] onMessage', message);
  if (message.action === 'startTranscription') {
    console.log('[SW] Transcription started');
    try{
        const options = { audio: true, video: false };
        chrome.tabCapture.capture(options, (stream) => {
        if (chrome.runtime.lastError || !stream) {
            console.error('[SW] tabCapture error:', chrome.runtime.lastError);
            sendResponse({ status: 'Error starting transcription', error: chrome.runtime.lastError });
            return;
        }
        console.log('[SW] tabCapture stream obtained', stream);
        const output = new AudioContext();
        const source = output.createMediaStreamSource(stream);
        source.connect(output.destination);
        console.log('[SW] Transcription audio routed to output', output);
        sendResponse({ status: 'Transcription started' });
        });
    } catch (error) {
        console.error('[SW] Error starting transcription:', error);
        sendResponse({ status: 'Error starting transcription', error });
    }
  }
  // Return true in case we handle the response asynchronously
  return true;
});