// Webhook events, pushed over the event stream, are what refresh the Messages page. This fallback poll only
// covers what an event cannot: an event missed while the stream was down, and any change no event announces.
export const FALLBACK = {
  // Between polls while the event stream is connected. The poll is kept, slowly, because a connection can stall
  // without the browser noticing, and because the poll is what finds a change no event announces.
  liveMs: 60_000,
  // Between polls while the event stream is down and events are being missed.
  downMs: 30_000,
  // The interval doubles for each failed poll in a row and for each idleStepMs without a change, up to maxMs.
  idleStepMs: 10 * 60_000,
  maxMs: 5 * 60_000,
  // A tab shown again is refreshed at once, unless it was refreshed less than this long ago.
  visibleGapMs: 10_000,
};

// The wait before the next fallback poll.
export function fallbackDelay({ streamUp, failures, idleMs }, config = FALLBACK) {
  const base = streamUp ? config.liveMs : config.downMs;
  const doublings = failures + Math.floor(idleMs / config.idleStepMs);
  return Math.min(config.maxMs, base * 2 ** Math.min(doublings, 20));
}

// Runs `run` on the fallback schedule, and at once when `now()` is called. `run` resolves true when it found a change
// and throws when it failed. It runs only while the page is visible and never twice at the same time.
export function createFallback(run, { streamUp = () => false, config = FALLBACK, doc = globalThis.document, timers = globalThis, clock = Date.now } = {}) {
  let timer = null;
  let running = null;
  let again = false;
  let due = false;
  let stopped = false;
  let failures = 0;
  let quietSince = clock();
  let lastRun = 0;

  function schedule() {
    timers.clearTimeout(timer);
    timer = null;
    if (stopped || doc.hidden) return;
    const delay = fallbackDelay({ streamUp: streamUp(), failures, idleMs: clock() - quietSince }, config);
    timer = timers.setTimeout(fire, delay);
  }

  async function fire() {
    if (stopped) return;
    // A page in a hidden tab fetches nothing; what was asked for runs when the tab is shown again.
    if (doc.hidden) {
      due = true;
      return schedule();
    }
    // A request asked for during a run starts again after it, so a change that came in meanwhile is not lost.
    if (running) {
      again = true;
      return running;
    }
    due = false;
    timers.clearTimeout(timer);
    running = (async () => {
      lastRun = clock();
      try {
        if (await run()) quietSince = clock();
        failures = 0;
      } catch {
        failures += 1;
      }
    })();
    await running;
    running = null;
    if (again && !stopped) {
      again = false;
      return fire();
    }
    schedule();
  }

  function onVisibility() {
    if (doc.hidden) return schedule();
    if (due || clock() - lastRun >= config.visibleGapMs) fire();
    else schedule();
  }

  return {
    start() {
      lastRun = clock();
      doc.addEventListener('visibilitychange', onVisibility);
      schedule();
    },
    // Refreshes at once: called for a webhook event, after a send, and when the event stream reconnects.
    now: () => fire(),
    stop() {
      stopped = true;
      timers.clearTimeout(timer);
      doc.removeEventListener('visibilitychange', onVisibility);
    },
  };
}
