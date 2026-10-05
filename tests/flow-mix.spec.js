// Mixed Flow (2026-10-05): the default order deals one card at a time from
// every phase with something to give. The rail starts with Mix, each step is
// a tab you can narrow to, and the counter counts down ("27 left").
import { test, expect } from '@playwright/test';
import { boot, seedSession } from './helper.js';

function stubFlow(page, { lul = 3, cards = 6, mantras = 2, books = 1, dives = 0, order = null } = {}) {
  return page.addInitScript(({ lul, cards, mantras, books, dives, order }) => {
    if (order) localStorage.setItem('break_flow_order', order); else localStorage.removeItem('break_flow_order');
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
      // srsGetDueCount reads the total off Content-Range (count=exact).
      if (path.startsWith('flashcards')) return json(Array.from({ length: cards }, (_, i) => ({ id: 'f' + i, front: 'Front ' + i, back: 'Back ' + i, next_review: '2026-01-01', interval: 1, ease_factor: 2.5, review_count: 0 })), { 'Content-Range': '0-' + Math.max(0, cards - 1) + '/' + cards });
      if (path.startsWith('deep_dives')) return json(Array.from({ length: dives }, (_, i) => ({ id: 'd' + i, title: 'Dive ' + i, prompt: 'Explain ' + i, key_points: [{ text: 'k' }], status: 'active', next_review: null })));
      if (path.startsWith('mantras')) return json(Array.from({ length: mantras }, (_, i) => ({ id: 'm' + i, text: 'Relax into it ' + i, created_at: '2026-06-01T10:00:00Z', status: 'active' })));
      if (path.startsWith('insights')) return json([]);
      if (path.startsWith('reflections')) return json(Array.from({ length: books }, (_, i) => ({ id: 'r' + i, text: '# Let Them\n\n**Thesis.** Stop managing other people.\n\n- Let them', prompt_used: 'Book review: Let Them', tags: ['book-review'], date: '2026-09-01' })));
      return json([]);
    };
  }, { lul, cards, mantras, books, dives, order });
}

const FLOW_SLUGS = ['due-card', 'due-lul', 'due-dive', 'ground', 'chan-unit', 'chan-recall', 'flow-mark'];

// Swipe forward until the predicate holds, topping up as a thumb would.
const reach = (page, fn, timeout = 8000) => page.waitForFunction(src => {
  if (typeof feedMounted === 'undefined') return false;
  if (new Function('return (' + src + ')()')()) return true;
  feedActiveIdx = feedItems().length - 1; feedFill(); flowTopUp();
  return false;
}, fn.toString(), { timeout, polling: 200 });

test.beforeEach(async ({ page }) => { await seedSession(page); });

test('Mixed is the default: the rail starts with Mix and counts down', async ({ page }) => {
  await stubFlow(page);
  await boot(page);
  await page.evaluate(() => openFlow());
  await page.waitForFunction(() => typeof feedMounted !== 'undefined' && feedMounted.length >= 2 && Object.keys(flowCounts).length, null, { timeout: 8000 });
  const s = await page.evaluate(() => ({
    mixed: flowMixed(),
    rail: [...document.querySelectorAll('.flow-step')].map(b => b.textContent.trim()),
    on: document.querySelector('.flow-step.on')?.textContent.trim(),
  }));
  expect(s.mixed).toBe(true);
  expect(s.rail[0]).toBe('Mix');
  expect(s.on).toBe('Mix');
  expect(s.rail).toContain('Cards 6 left');
  expect(s.rail).toContain('Queue 3 left');
});

test('the deal interleaves phases instead of draining Cards first', async ({ page }) => {
  await stubFlow(page);
  await boot(page);
  await page.evaluate(() => openFlow());
  await reach(page, () => feedMounted.length >= 8);
  const mounted = await page.evaluate(() => feedMounted.slice(0, 8));
  const phases = new Set(mounted.filter(s => FLOW_SLUGS.includes(s) && s !== 'flow-mark'));
  // In sequence the first six would all be due-card; mixed, something else
  // turns up well before the cards are spent.
  expect(phases.size).toBeGreaterThanOrEqual(2);
  expect(mounted.filter(s => s === 'due-card').length).toBeLessThan(6);
  // Never the same phase twice running while another had a card ready.
  for (let i = 1; i < mounted.length; i++) {
    if (mounted[i] === 'due-card' && mounted[i - 1] === 'due-card') {
      // allowed only if nothing else was ready; with lul=3 and ground=3 that
      // should not happen in the first eight
      expect(mounted[i]).not.toBe(mounted[i - 1]);
    }
  }
});

test('tapping Cards narrows to flashcards until they run dry, then widens to Mix', async ({ page }) => {
  await stubFlow(page, { cards: 4 });
  await boot(page);
  await page.evaluate(() => openFlow());
  await page.waitForFunction(() => typeof feedMounted !== 'undefined' && feedMounted.length >= 2, null, { timeout: 8000 });
  const start = await page.evaluate(() => { const n = feedMounted.length; document.querySelector('[data-flow-focus="recall"]').click(); return { n, focus: flowFocus, active: feedActiveIdx }; });
  expect(start.focus).toBe('recall');
  const on = await page.evaluate(() => document.querySelector('.flow-step.on')?.textContent.trim());
  expect(on).toMatch(/^Cards/);
  // Cards ahead of the active one were handed back; only flashcards mount now.
  await reach(page, () => feedMounted.includes('flow-mark'));
  const s = await page.evaluate(a => ({ after: feedMounted.slice(a + 1), focus: flowFocus, mark: document.querySelector('.feed-item[data-slug="flow-mark"] .main-text')?.textContent, next: document.querySelector('.feed-item[data-slug="flow-mark"] .flow-next')?.textContent }), start.active);
  const mark = s.after.indexOf('flow-mark');
  expect(mark).toBeGreaterThan(0);
  expect(s.after.slice(0, mark).every(x => x === 'due-card')).toBe(true);
  expect(s.after.slice(0, mark).length).toBeGreaterThanOrEqual(3);
  expect(s.focus).toBe(null);
  expect(s.mark).toBe('Nothing else due.');
  expect(s.next).toBe('Next: Mix');
});

test('grading a card ticks the countdown on the rail and on the card', async ({ page }) => {
  await stubFlow(page, { cards: 3, lul: 0, mantras: 0, books: 0 });
  await boot(page);
  await page.evaluate(() => openFlow());
  await page.waitForFunction(() => document.querySelectorAll('.feed-item[data-slug="due-card"]').length >= 2 && flowCounts.recall === 3, null, { timeout: 8000 });
  const before = await page.evaluate(() => ({
    rail: document.querySelector('[data-flow-focus="recall"]').textContent.trim(),
    card: document.querySelector('.feed-item[data-slug="due-card"] .due-left').textContent,
  }));
  expect(before.rail).toBe('Cards 3 left');
  expect(before.card).toBe('3 left · ');
  await page.evaluate(() => {
    const it = document.querySelector('.feed-item[data-slug="due-card"]');
    feedToggleFlip(it);
    it.querySelector('[data-due-rate="2"]').click();
  });
  await page.waitForFunction(() => flowDone.recall === 1, null, { timeout: 5000 });
  const after = await page.evaluate(() => ({
    rail: document.querySelector('[data-flow-focus="recall"]').textContent.trim(),
    cards: [...document.querySelectorAll('.feed-item[data-slug="due-card"]:not([data-due-done]) .due-left')].map(e => e.textContent),
  }));
  expect(after.rail).toBe('Cards 2 left');
  expect(after.cards.every(t => t === '2 left · ')).toBe(true);
});

test('the In sequence setting brings back the old order and the old rail', async ({ page }) => {
  await stubFlow(page, { order: 'sequence' });
  await boot(page);
  await page.evaluate(() => openFlow());
  await page.waitForFunction(() => typeof feedMounted !== 'undefined' && feedMounted.length >= 3, null, { timeout: 8000 });
  const s = await page.evaluate(() => ({
    mixed: flowMixed(),
    rail: [...document.querySelectorAll('.flow-step')].map(b => b.textContent.trim()),
    mounted: feedMounted.slice(0, 6),
  }));
  expect(s.mixed).toBe(false);
  expect(s.rail[0]).toMatch(/^Cards/);
  expect(s.rail).not.toContain('Mix');
  expect(s.mounted.slice(0, 6).every(x => x === 'due-card')).toBe(true);
});

test('the home menu flips the order and the Flow sub-line follows', async ({ page }) => {
  await stubFlow(page);
  await boot(page);
  const a = await page.evaluate(() => ({ label: document.getElementById('flow-order-label').textContent, sub: document.getElementById('flow-sub').textContent }));
  expect(a.label).toBe('Mixed');
  expect(a.sub).toMatch(/mixed/);
  await page.evaluate(() => document.getElementById('btn-flow-order').click());
  const b = await page.evaluate(() => ({ label: document.getElementById('flow-order-label').textContent, sub: document.getElementById('flow-sub').textContent, stored: localStorage.getItem('break_flow_order') }));
  expect(b.label).toBe('In sequence');
  expect(b.stored).toBe('sequence');
  expect(b.sub).toMatch(/then/);
});

test('a channel lesson offers Make a flashcard on its back', async ({ page }) => {
  await stubFlow(page);
  await boot(page);
  const html = await page.evaluate(() => chanBack({ chan: { name: 'Roots' }, unit: { title: 'The root -spect-' } }));
  expect(html).toContain('data-feed-remember');
});
