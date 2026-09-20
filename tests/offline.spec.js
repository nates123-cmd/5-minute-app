// Offline outbox tests — the shared suite-sync.js layer as wired into Break.
// Every test drives the REAL srsCreate / srsUpdate / sbFetch / sync from
// index.html; we only observe effects (return value, localStorage outbox, a
// recorded fetch-call log). The module's own edge cases live in
// suite-sync.unit.mjs; this file proves Break is wired to it.
import { test, expect } from '@playwright/test';
import { boot } from './helper.js';
import { BREAK_OUTBOX_KEY, OFFLINE_CARD_QUEUE_KEY } from './constants.js';

test.beforeEach(async ({ page }) => {
  await boot(page);
  await page.evaluate((k) => localStorage.removeItem(k), BREAK_OUTBOX_KEY);
});

const readOutbox = (page) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) || '[]'), BREAK_OUTBOX_KEY);

test.describe('srsCreate — offline queueing', () => {
  test('a card created while offline is queued with a client id and the network is NOT hit', async ({ page, context }) => {
    await context.setOffline(true); // navigator.onLine === false
    const r = await page.evaluate(async (k) => {
      let fetched = false;
      const real = window.fetch;
      window.fetch = async (...a) => { fetched = true; return real(...a); };
      const res = await srsCreate('Front side', 'Back side', 'manual');
      const queue = JSON.parse(localStorage.getItem(k) || '[]');
      window.fetch = real;
      return { fetched, res, qlen: queue.length, q0: queue[0] };
    }, BREAK_OUTBOX_KEY);
    await context.setOffline(false);
    expect(r.fetched).toBe(false);            // skipped the doomed POST
    expect(r.res.offline).toBe(true);         // caller told it was deferred
    expect(r.res.id).toMatch(/^[0-9a-f-]{36}$/); // client-minted uuid
    expect(r.qlen).toBe(1);
    expect(r.q0.method).toBe('POST');
    expect(r.q0.url).toContain('/rest/v1/flashcards');
    expect(r.q0.body.front).toBe('Front side');
    expect(r.q0.body.back).toBe('Back side');
    expect(r.q0.body.source).toBe('manual');
    expect(r.q0.body.id).toBe(r.res.id);
    expect(r.q0.headers.Authorization).toBeUndefined(); // bearer re-issued at replay
    expect(typeof r.q0.body.created_at).toBe('string');
  });

  test('multiple offline cards accumulate FIFO', async ({ page, context }) => {
    await context.setOffline(true);
    await page.evaluate(async () => {
      await srsCreate('one', 'a');
      await srsCreate('two', 'b');
      await srsCreate('three', 'c');
    });
    const fronts = (await readOutbox(page)).map((op) => op.body.front);
    await context.setOffline(false);
    expect(fronts).toEqual(['one', 'two', 'three']);
  });

  test('default source is "Break" when omitted', async ({ page, context }) => {
    await context.setOffline(true);
    await page.evaluate(async () => { await srsCreate('q', 'a'); });
    const src = (await readOutbox(page))[0].body.source;
    await context.setOffline(false);
    expect(src).toBe('Break');
  });
});

test.describe('srsUpdate — grades survive offline (the bug this replaces)', () => {
  test('an offline grade PATCH is queued instead of silently lost', async ({ page, context }) => {
    await context.setOffline(true);
    await page.evaluate(async () => { await srsUpdate('card-1', { interval: 3, ease_factor: 2.5 }); });
    const q = await readOutbox(page);
    await context.setOffline(false);
    expect(q.length).toBe(1);
    expect(q[0].method).toBe('PATCH');
    expect(q[0].url).toContain('flashcards?id=eq.card-1');
    expect(q[0].body).toEqual({ interval: 3, ease_factor: 2.5 });
  });

  test('two PATCHes to the same card merge into one op', async ({ page, context }) => {
    await context.setOffline(true);
    await page.evaluate(async () => {
      await srsUpdate('card-1', { interval: 3 });
      await srsUpdate('card-1', { next_review: '2026-10-01' });
    });
    const q = await readOutbox(page);
    await context.setOffline(false);
    expect(q.length).toBe(1);
    expect(q[0].body).toEqual({ interval: 3, next_review: '2026-10-01' });
  });
});

test.describe('replay on reconnect', () => {
  // Seed the outbox via the real API while "offline" (fetch stubbed to reject
  // like a dead network), then restore a fetch stub that answers per call and
  // records POST bodies, and flush.
  const seedOffline = async (page, fronts) => {
    await page.evaluate(async (fronts) => {
      const real = window.fetch;
      window.fetch = async () => { throw new TypeError('Failed to fetch'); };
      for (const f of fronts) await srsCreate(f, 'b', 'manual');
      window.fetch = real;
    }, fronts);
  };
  const installStub = async (page, statuses) => {
    await page.evaluate((statuses) => {
      window.__posts = [];
      let i = 0;
      window.fetch = async (url, opts = {}) => {
        const isPost = (opts.method || 'GET').toUpperCase() === 'POST';
        if (isPost) { window.__posts.push({ body: opts.body, prefer: opts.headers && opts.headers.Prefer }); }
        const status = isPost ? (statuses[i++] ?? 200) : 200;
        return new Response(status === 204 ? '' : '[]', {
          status,
          headers: { 'Content-Type': 'application/json', 'Content-Range': '0-0/0' },
        });
      };
    }, statuses);
  };

  test('drains the whole queue as idempotent upserts when every POST succeeds', async ({ page }) => {
    await seedOffline(page, ['a', 'b', 'c']);
    expect((await readOutbox(page)).length).toBe(3);
    await installStub(page, [201, 201, 201]);
    const r = await page.evaluate(async () => {
      await syncOfflineQueue();
      return { posts: window.__posts };
    });
    expect(r.posts.length).toBe(3);
    expect(r.posts.map((p) => JSON.parse(p.body).front)).toEqual(['a', 'b', 'c']);
    for (const p of r.posts) expect(p.prefer).toMatch(/resolution=merge-duplicates/);
    expect((await readOutbox(page)).length).toBe(0);
  });

  test('a 5xx stops the replay at that op and keeps the tail queued in order', async ({ page }) => {
    await seedOffline(page, ['a', 'b', 'c']);
    await installStub(page, [201, 500, 201]);
    await page.evaluate(async () => { await syncOfflineQueue(); });
    const q = await readOutbox(page);
    expect(q.map((op) => op.body.front)).toEqual(['b', 'c']);
    expect(q[0].attempts).toBe(1);
  });

  test('a 4xx is dead-lettered so the queue never wedges', async ({ page }) => {
    await seedOffline(page, ['a', 'b']);
    await installStub(page, [400, 201]);
    await page.evaluate(async () => { await syncOfflineQueue(); });
    expect((await readOutbox(page)).length).toBe(0);
    const dead = await page.evaluate(() => sync.dead());
    expect(dead.length).toBe(1);
    expect(dead[0].body.front).toBe('a');
    await page.evaluate(() => sync.clearDead());
  });

  test('empty queue is a no-op (no POSTs)', async ({ page }) => {
    await installStub(page, []);
    const posts = await page.evaluate(async () => { await syncOfflineQueue(); return window.__posts.length; });
    expect(posts).toBe(0);
  });
});

test.describe('legacy queue migration', () => {
  test('cards left in the old offline_card_queue are moved into the outbox on boot', async ({ page }) => {
    await page.evaluate((k) => {
      localStorage.setItem(k, JSON.stringify([{ front: 'old', back: 'b', source: 'manual', created_at: '2026-06-01T00:00:00Z' }]));
    }, OFFLINE_CARD_QUEUE_KEY);
    await page.reload();
    await page.waitForFunction(() => typeof window.sm2 === 'function');
    const legacy = await page.evaluate((k) => localStorage.getItem(k), OFFLINE_CARD_QUEUE_KEY);
    const q = await readOutbox(page);
    expect(legacy).toBeNull();
    expect(q.length).toBe(1);
    expect(q[0].method).toBe('POST');
    expect(q[0].body.front).toBe('old');
  });
});

test.describe('read snapshot', () => {
  test('a due-cards read that succeeds is served back offline, with an offline grade overlaid', async ({ page, context }) => {
    await page.evaluate(async () => {
      const real = window.fetch;
      window.fetch = async () => new Response(JSON.stringify([
        { id: 'c1', front: 'a', back: 'b', next_review: '2000-01-01', ladder_level: 0 },
        { id: 'c2', front: 'c', back: 'd', next_review: '2000-01-01', ladder_level: 0 },
      ]), { status: 200, headers: { 'Content-Type': 'application/json', 'Content-Range': '0-1/2' } });
      await srsGetDue();
      window.fetch = real;
    });
    await context.setOffline(true);
    const rows = await page.evaluate(async () => {
      await srsUpdate('c1', { next_review: '2999-01-01', interval: 30 });
      return srsGetDue();
    });
    await context.setOffline(false);
    // c1 was graded offline -> next_review moved out -> filtered; c2 still due
    expect(rows.map((r) => r.id)).toEqual(['c2']);
  });
});

test.describe('sync state banner', () => {
  test('offline shows the banner, back online with an empty outbox hides it', async ({ page, context }) => {
    await context.setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await expect(page.locator('#offline-banner')).toBeVisible();
    await expect(page.locator('#offline-banner')).toContainText('Offline');
    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(page.locator('#offline-banner')).toBeHidden();
  });
});
