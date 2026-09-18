// Best-effort client error reporting so production problems show up in the
// server logs. Bounded and de-duplicated; never blocks the UI.

const MAX_REPORTS = 8;
let sent = 0;
const seen = new Set();

const scrub = (value) => String(value ?? '').replace(/\/report\/[A-Za-z0-9_-]+/g, '/report/:id');

export function reportError(error, context = 'unknown') {
  if (sent >= MAX_REPORTS) return;
  const message = scrub(error && error.message ? error.message : error).slice(0, 500);
  if (!message) return;
  const key = `${context}:${message}`;
  if (seen.has(key)) return;
  seen.add(key);
  sent += 1;

  const body = JSON.stringify({
    message,
    stack: scrub(error && error.stack).slice(0, 4000),
    source: scrub(location.pathname),
    context
  });
  try {
    const blob = new Blob([body], { type: 'application/json' });
    if (!navigator.sendBeacon || !navigator.sendBeacon('/api/client-errors', blob)) {
      fetch('/api/client-errors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true
      }).catch(() => {});
    }
  } catch {
    /* reporting must never throw */
  }
}

export function installErrorReporting() {
  window.addEventListener('error', (event) => reportError(event.error || event.message, 'window-error'));
  window.addEventListener('unhandledrejection', (event) => reportError(event.reason, 'unhandled-rejection'));
}
