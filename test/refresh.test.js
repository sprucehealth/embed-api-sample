import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FALLBACK, createFallback, fallbackDelay } from '../public/refresh.js';

const MIN = 60_000;

test('fallback polls slowly while the event stream is up, faster while it is down', () => {
  assert.equal(fallbackDelay({ streamUp: true, failures: 0, idleMs: 0 }), 60_000);
  assert.equal(fallbackDelay({ streamUp: false, failures: 0, idleMs: 0 }), 30_000);
});

test('fallback backs off on failures and on long quiet periods, up to the cap', () => {
  assert.equal(fallbackDelay({ streamUp: true, failures: 1, idleMs: 0 }), 2 * MIN);
  assert.equal(fallbackDelay({ streamUp: false, failures: 0, idleMs: 10 * MIN }), MIN);
  assert.equal(fallbackDelay({ streamUp: false, failures: 1, idleMs: 20 * MIN }), 4 * MIN);
  assert.equal(fallbackDelay({ streamUp: true, failures: 50, idleMs: 0 }), FALLBACK.maxMs);
  assert.equal(fallbackDelay({ streamUp: true, failures: 0, idleMs: 1e12 }), FALLBACK.maxMs);
});

// A fake clock, timer queue and document, so the schedule can be stepped through without waiting.
function harness() {
  let now = 0;
  let nextId = 1;
  const pending = new Map();
  const listeners = new Set();
  const doc = {
    hidden: false,
    addEventListener: (type, fn) => listeners.add(fn),
    removeEventListener: (type, fn) => listeners.delete(fn),
  };
  const timers = {
    setTimeout(fn, ms) {
      const id = nextId++;
      pending.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimeout: (id) => pending.delete(id),
  };
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return {
    doc,
    timers,
    clock: () => now,
    // The time until the one scheduled poll, or null when none is scheduled.
    nextIn() {
      assert.ok(pending.size <= 1, 'at most one poll is scheduled');
      const [entry] = pending.values();
      return entry ? entry.at - now : null;
    },
    async advance() {
      const [[id, entry]] = pending.entries();
      pending.delete(id);
      now = entry.at;
      entry.fn();
      await settle();
    },
    async setHidden(hidden, elapsed = 0) {
      now += elapsed;
      doc.hidden = hidden;
      for (const fn of listeners) fn();
      await settle();
    },
    listenerCount: () => listeners.size,
    settle,
  };
}

test('fallback runs on its schedule and backs off after failures', async () => {
  const t = harness();
  let fail = true;
  let runs = 0;
  const fallback = createFallback(
    async () => {
      runs += 1;
      if (fail) throw new Error('down');
      return true;
    },
    { streamUp: () => true, doc: t.doc, timers: t.timers, clock: t.clock },
  );
  fallback.start();
  assert.equal(t.nextIn(), MIN);
  await t.advance();
  assert.equal(runs, 1);
  assert.equal(t.nextIn(), 2 * MIN);
  await t.advance();
  assert.equal(t.nextIn(), 4 * MIN);
  fail = false;
  await t.advance();
  assert.equal(t.nextIn(), MIN, 'a success resets the backoff');
  fallback.stop();
  assert.equal(t.nextIn(), null);
  assert.equal(t.listenerCount(), 0);
});

test('fallback slows down when nothing changes for a long time', async () => {
  const t = harness();
  let changed = false;
  const fallback = createFallback(async () => changed, { streamUp: () => true, doc: t.doc, timers: t.timers, clock: t.clock });
  fallback.start();
  for (let i = 0; i < 10; i++) await t.advance();
  assert.equal(t.nextIn(), 2 * MIN, 'ten quiet minutes double the interval');
  changed = true;
  await t.advance();
  assert.equal(t.nextIn(), MIN, 'a change restores it');
  fallback.stop();
});

test('fallback stops while hidden and refreshes when shown again', async () => {
  const t = harness();
  let runs = 0;
  const fallback = createFallback(
    async () => {
      runs += 1;
      return false;
    },
    { doc: t.doc, timers: t.timers, clock: t.clock },
  );
  fallback.start();
  await t.setHidden(true);
  assert.equal(t.nextIn(), null, 'nothing is scheduled in a hidden tab');
  await t.setHidden(false, 5 * MIN);
  assert.equal(runs, 1, 'a tab shown after a while is refreshed at once');
  assert.equal(t.nextIn(), 30_000);
  await t.setHidden(true, 1000);
  await t.setHidden(false, 1000);
  assert.equal(runs, 1, 'a tab shown again moments after a refresh is not refreshed again');
  assert.equal(t.nextIn(), 30_000);
  fallback.stop();
});

test('an event while hidden is fetched when the tab is shown, however soon', async () => {
  const t = harness();
  let runs = 0;
  const fallback = createFallback(
    async () => {
      runs += 1;
      return true;
    },
    { doc: t.doc, timers: t.timers, clock: t.clock },
  );
  fallback.start();
  await t.setHidden(true);
  await fallback.now();
  assert.equal(runs, 0);
  await t.setHidden(false, 1000);
  assert.equal(runs, 1);
  fallback.stop();
});

test('a refresh asked for during a run starts again after it, never alongside it', async () => {
  const t = harness();
  let active = 0;
  let most = 0;
  let runs = 0;
  let release;
  const fallback = createFallback(
    async () => {
      runs += 1;
      active += 1;
      most = Math.max(most, active);
      await new Promise((resolve) => (release = resolve));
      active -= 1;
      return false;
    },
    { doc: t.doc, timers: t.timers, clock: t.clock },
  );
  fallback.start();
  const first = fallback.now();
  await t.settle();
  fallback.now();
  fallback.now();
  release();
  await t.settle();
  assert.equal(runs, 2, 'requests made during a run collapse into one more run');
  release();
  await first;
  assert.equal(most, 1);
  assert.equal(t.nextIn(), 30_000);
  fallback.stop();
});
