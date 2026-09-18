// Drives the background-effects frame loop from a worker: timers here are not
// throttled when the tab is in the background, so a blurred or replaced
// background keeps updating for everyone else while you look at another tab.

let timer = null;

self.onmessage = (event) => {
  const { cmd, fps = 30 } = event.data || {};
  clearInterval(timer);
  timer = null;
  if (cmd === 'start') {
    timer = setInterval(() => self.postMessage(performance.now()), Math.max(20, Math.round(1000 / fps)));
  }
};
