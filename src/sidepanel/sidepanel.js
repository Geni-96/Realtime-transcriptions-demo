// Side panel UI logic placeholder
// JavaScript only (no TypeScript)

const log = (msg) => {
  const el = document.getElementById('log');
  if (el) el.textContent += `${msg}\n`;
};

window.addEventListener('DOMContentLoaded', () => {
  const startBtn = document.getElementById('start-btn');
  const stopBtn = document.getElementById('stop-btn');

  startBtn?.addEventListener('click', () => {
    log('Start clicked (placeholder)');
  });

  stopBtn?.addEventListener('click', () => {
    log('Stop clicked (placeholder)');
  });
});
