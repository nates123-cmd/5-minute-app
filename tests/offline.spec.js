// Offline card-queue tests — the subsystem that protects user-authored
// flashcards when the network is down. Every test drives the REAL srsCreate /
// syncOfflineQueue / get/setOfflineQueue from index.html; we only observe their
// effects (return value, localStorage, a recorded fetch-call log).
import { test, expect } from '@playwright/test';
import { boot } from './helper.js';
import { OFFLINE_CARD_QUEUE_KEY } from './constants.js';

test.beforeEach(async ({ page }) => {
  await boot(page);
  await page.evaluate((k) => localStorage.removeItem(k), OFFLINE_CARD_QUEUE_KEY);
});

test.describe('srsCreate — offline queueing', () => {
  test('a card created while offline is queued and the network is NOT hit', async ({ page, context }) => {
    await context.setOffline(true); // navigator.onLine === false
    const r = await page.evaluate(async (k) => {
      let fetched = false;
      const real = window.fetch;
      window.fetch = async (...a) => { fetched = true; return real(...a); };
      const res = await srsCreate('Front side', 'Back side', 'manual');
      const queue = JSON.parse(localStorage.getItem(k) || '[]');
      window.fetch = real;
      return { fetched, res, qlen: queue.length, q0: queue[0] };
    }, OFFLINE_CARD_QUEUE_KEY);
    await context.setOffline(false);
    expect(r.fetched).toBe(false);            // skipped the doomed POST
    expect(r.res).toEqual({ offline: true }); // caller told it was deferred
    expect(r.qlen).toBe(1);
    expect(r.q0.front).toBe('Front side');
    expect(r.q0.back).toBe('Back side');
    expect(r.q0.source).toBe('manual');
    expect(typeof r.q0.created_at).toBe('string'); // timestamp stamped at queue time
  });

  test('multiple offline cards accumulate FIFO', async ({ page, context }) => {
    await context.setOffline(true);
    const fronts = await page.evaluate(async (k) => {
      await srsCreate('one', 'a');
      await srsCreate('two', 'b');
      await srsCreate('three', 'c');
      return JSON.parse(localStorage.getItem(k)).map((c) => c.front);
    }, OFFLINE_CARD_QUEUE_KEY);
    await context.setOffline(false);
    expect(fronts).toEqual(['one', 'two', 'three']);
  });

  test('default source is "Break" when omitted', async ({ page, context }) => {
    await context.setOffline(true);
    const src = await page.evaluate(async (k) => {
      await srsCreate('q', 'a'); // no source arg
      return JSON.parse(localStorage.getItem(k))[0].source;
    }, OFFLINE_CARD_QUEUE_KEY);
    await context.setOffline(false);
    expect(src).toBe('Break');
  });
});

test.describe('syncOfflineQueue — replay on reconnect', () => {
  // Seed the queue and install a fetch stub that returns a status per call (in
  // order) and records the POST bodies. updateDueBadge() also calls fetch at the
  // end of sync; the stub answers everything, and we only inspect /flashcards
  // POSTs via the recorded body log.
  const installStub = async (page, cards, statuses) => {
    await page.evaluate(({ k, cards, statuses }) => {
      localStorage.setItem(k, JSON.stringify(cards));
      window.__posts = [];
      let i = 0;
      window.fetch = async (url, opts = {}) => {
        const isPost = (opts.method || 'GET').toUpperCase() === 'POST';
        if (isPost) { window.__posts.push(opts.body); }
        const status = isPost ? (statuses[i++] ?? 200) : 200;
        return new Response(status === 204 ? '' : '{}', {
          status,
          headers: { 'Content-Type': 'application/json', 'Content-Range': '0-0/0' },
        });
      };
    }, { k: OFFLINE_CARD_QUEUE_KEY, cards, statuses });
  };
  const card = (front) => ({ front, back: 'b', source: 'manual', created_at: '2026-06-01T00:00:00Z' });

  test('drains the whole queue when every POST succeeds', async ({ page }) => {
    await installStub(page, [card('a'), card('b'), card('c')], [201, 201, 201]);
    const r = await page.evaluate(async (k) => {
      await syncOfflineQueue();
      return { remaining: JSON.parse(localStorage.getItem(k)).length, posts: window.__posts.length };
    }, OFFLINE_CARD_QUEUE_KEY);
    expect(r.posts).toBe(3);
    expect(r.remaining).toBe(0);
  });

  test('keeps only the FAILED cards; successes are dropped from the queue', async ({ page }) => {
    // middle card fails (500) -> it must remain queued, the other two clear.
    await installStub(page, [card('a'), card('b'), card('c')], [201, 500, 201]);
    const r = await page.evaluate(async (k) => {
      await syncOfflineQueue();
      const q = JSON.parse(localStorage.getItem(k));
      return { remaining: q.length, fronts: q.map((c) => c.front) };
    }, OFFLINE_CARD_QUEUE_KEY);
    expect(r.remaining).toBe(1);
    expect(r.fronts).toEqual(['b']);
  });

  test('empty queue is a no-op (no POSTs)', async ({ page }) => {
    await installStub(page, [], []);
    const posts = await page.evaluate(async () => {
      await syncOfflineQueue();
      return window.__posts.length;
    });
    expect(posts).toBe(0);
  });
});

test.describe('queue accessors', () => {
  test('getOfflineQueue returns [] on corrupt storage (no throw)', async ({ page }) => {
    const r = await page.evaluate((k) => {
      localStorage.setItem(k, '{broken');
      return getOfflineQueue();
    }, OFFLINE_CARD_QUEUE_KEY);
    expect(r).toEqual([]);
  });
  test('setOfflineQueue round-trips through getOfflineQueue', async ({ page }) => {
    const r = await page.evaluate(() => {
      setOfflineQueue([{ front: 'x', back: 'y' }]);
      return getOfflineQueue();
    });
    expect(r).toEqual([{ front: 'x', back: 'y' }]);
  });
});
