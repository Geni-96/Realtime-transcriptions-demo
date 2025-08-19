// Background service worker (MV3) placeholder
// Using ESM modules is allowed for MV3 service workers

console.log('[serviceWorker] loaded');

chrome.runtime.onInstalled.addListener(() => {
  console.log('[serviceWorker] onInstalled');
});
