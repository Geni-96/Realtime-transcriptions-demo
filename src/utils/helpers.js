// Shared helper utilities (placeholder)

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function formatError(e) {
  if (!e) return 'Unknown error';
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  try { return JSON.stringify(e); } catch (_) { return String(e); }
}
