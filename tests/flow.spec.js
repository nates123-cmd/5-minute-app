// Flow: the guided sitting. Queue → Recall → Dive → Ground → Discover, each
// phase drained before the next, with a marker card between phases that did
// work. The Scroll's weighted draw must never see Flow-only cards.
import { test, expect } from '@playwright/test';
import { boot, seedSession } from './helper.js';

function stubFlow(page, { lul = 1, cards = 1, mantras = 1, books = 1 } = {}) {
  return page.addInitScript(({ lul, cards, mantras, books }) => {
    window.__sbCalls = [];
    const json = (v, extra = {}) => new Response(JSON.stringify(v), {
      status: 200, headers: { 'Content-Type': 'application/json', 'Content-Range': '0-0/0', ...extra },
    });
    window.fetch = async (url, opts = {}) => {
      const u = String(url);
      if (!u.includes('/rest/v1/')) return json([]);
      const path = u.split('/rest/v1/')[1];
      window.__sbCalls.push({ path, method: opts.method || 'GET', body: opts.body || null });
      if (path.startsWith('look_up_later')) return json(Array.from({ length: lul }, (_, i) => ({ id: 'l' + i, question: 'Parked question ' + i, status: 'pending', created_at: '2026-09-01T10:00:00Z' })));
      if (path.startsWith('flashcards')) return json(Array.from({ length: cards }, (_, i) => ({ id: 'f' + i, front: 'Front ' + i, back: 'Back ' + i, next_review: '2026-01-01', interval: 1, ease_factor: 2.5, review_count: 0 })));
      if (path.startsWith('deep_dives')) return json([]);
      if (path.startsWith('mantras')) return json(Array.from({ length: mantras }, (_, i) => ({ id: 'm' + i, text: 'Relax into it ' + i, created_at: '2026-06-01T10:00:00Z', status: 'active' })));
      if (path.startsWith('insights')) return json([]);
      if (path.startsWith('reflections')) return json(Array.from({ length: books }, (_, i) => ({ id: 'r' + i, text: '# Let Them\n\n**Thesis.** Stop managing other people.\n\n- Let them\n- Let me', prompt_used: 'Book review: Let Them', tags: ['book-review'], date: '2026-09-01' })));
      return json([]);
    };
  }, { lul, cards, mantras, books });
}

test.beforeEach(async ({ page }) => { await seedSession(page); });

test('Flow mounts the queue first, then a marker, then due cards', async ({ page }) => {
  await stubFlow(page);
  await boot(page);
  await page.evaluate(() => openFlow());
  await page.waitForFunction(() => typeof feedMounted !== "undefined" && feedMounted.length >= 3, null, { timeout: 8000 });
  const state = await page.evaluate(() => ({
    mounted: feedMounted.slice(),
    mode: feedMode,
    phase: FLOW_PHASES[flowPhase].id,
    rail: [...document.querySelectorAll('.flow-step')].map(b => b.className.replace('flow-step', '').trim()),
  }));
  expect(state.mode).toBe('flow');
  expect(state.mounted.slice(0, 3)).toEqual(['due-lul', 'flow-mark', 'due-card']);
  // Recall may already have drained into Dive by the time we look; either way
  // the Queue is behind us and nothing past Dive has started.
  expect(['recall', 'dive']).toContain(state.phase);
  // The rail follows the card on screen (the first queue item), not the
  // prefetch cursor, so Queue is still lit.
  expect(state.rail[0]).toBe('on');
  expect(state.rail.slice(1)).toEqual(['', '', '', '']);
});

test('phases with nothing to give are skipped silently; Ground serves a book before a mantra', async ({ page }) => {
  await stubFlow(page, { lul: 0, cards: 0 });
  await boot(page);
  await page.evaluate(() => openFlow());
  await page.waitForFunction(() => typeof feedMounted !== "undefined" && feedMounted.length >= 2, null, { timeout: 8000 });
  const state = await page.evaluate(() => ({
    mounted: feedMounted.slice(),
    kinds: [...document.querySelectorAll('.feed-item[data-slug="ground"] .ink-meta')].map(e => e.textContent),
    seen: Object.keys(JSON.parse(localStorage.getItem('flow_ground_seen') || '{}')).sort(),
  }));
  // No marker for the empty Queue / Recall / Dive phases — straight to Ground.
  expect(state.mounted[0]).toBe('ground');
  expect(state.kinds[0]).toMatch(/^From a book/);
  expect(state.kinds[1]).toMatch(/^Mantra/);
  expect(state.seen).toEqual(['book:r0', 'mantra:m0']);
});

test('Ground drains into Discover, and the rail follows', async ({ page }) => {
  await stubFlow(page, { lul: 0, cards: 0 });
  await boot(page);
  await page.evaluate(() => openFlow());
  await page.waitForFunction(() => typeof feedMounted !== "undefined" && feedMounted.length >= 2, null, { timeout: 8000 });
  // Pretend the user swiped to the last mounted card, then ask for more.
  await page.evaluate(async () => { feedActiveIdx = feedItems().length - 1; await flowTopUp(); });
  // Swipe to the last card (the Ground marker) so the rail reflects it.
  await page.evaluate(() => { feedActiveIdx = -1; feedSetActive(feedItems()[feedItems().length - 1]); });
  const state = await page.evaluate(() => ({
    mounted: feedMounted.slice(),
    phase: FLOW_PHASES[flowPhase].id,
    active: flowActive(),
    on: document.querySelector('.flow-step.on')?.textContent,
  }));
  expect(state.phase).toBe('discover');
  expect(state.active).toBe(false);
  // The Ground marker was mounted, and the wander began right behind it.
  const mark = state.mounted.lastIndexOf('flow-mark');
  expect(mark).toBeGreaterThan(0);
  expect(state.mounted.slice(mark + 1).every(s => !['ground', 'due-card', 'due-lul', 'due-dive'].includes(s))).toBe(true);
  expect(state.on).toBe('Discover');
});

test('the Scroll never draws Flow-only cards, and closing a Flow resets the mode', async ({ page }) => {
  await stubFlow(page);
  await boot(page);
  const pool = await page.evaluate(() => { feedBucket = 'random'; return feedEligible(); });
  expect(pool).not.toContain('ground');
  expect(pool).not.toContain('flow-mark');
  await page.evaluate(() => openFlow());
  await page.waitForFunction(() => typeof feedMounted !== "undefined" && feedMounted.length >= 1, null, { timeout: 8000 });
  await page.evaluate(() => showScreen('home'));
  const mode = await page.evaluate(() => feedMode);
  expect(mode).toBe('scroll');
});

test('"Let it go" writes the same dismissed status Ink would', async ({ page }) => {
  await stubFlow(page, { lul: 0, cards: 0, books: 0 });
  await boot(page);
  await page.evaluate(() => openFlow());
  await page.waitForFunction(() => document.querySelector('.feed-item[data-slug="ground"]'), null, { timeout: 8000 });
  await page.evaluate(() => document.querySelector('.feed-item[data-slug="ground"] [data-ground-dismiss]').click());
  await page.waitForFunction(() => window.__sbCalls.some(c => c.method === 'PATCH'), null, { timeout: 5000 });
  const patch = await page.evaluate(() => window.__sbCalls.find(c => c.method === 'PATCH'));
  expect(patch.path).toBe('mantras?id=eq.m0');
  expect(JSON.parse(patch.body)).toEqual({ status: 'dismissed' });
  const retired = await page.evaluate(() => document.querySelector('.feed-item[data-slug="ground"]').dataset.dueDone);
  expect(retired).toBe('1');
});
