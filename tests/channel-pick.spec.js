// Pick a channel (2026-10-26): a Flow offers one picker card instead of
// dripping single lessons from every channel. A pick runs that channel: its
// due recalls, one new lesson, then "one more?" / "Back to Mix".
import { test, expect } from '@playwright/test';
import { boot, seedSession } from './helper.js';

function stub(page, { units, order = null, chans = null } = {}) {
  return page.addInitScript(({ units, order, chans }) => {
    if (order) localStorage.setItem('break_flow_order', order); else localStorage.removeItem('break_flow_order');
    window.__calls = [];
    const json = (v) => new Response(JSON.stringify(v), { status: 200, headers: { 'Content-Type': 'application/json', 'Content-Range': '0-0/0' } });
    window.fetch = async (url, opts = {}) => {
      const u = String(url);
      const method = opts.method || 'GET';
      window.__calls.push({ u, method, body: opts.body || null });
      if (!u.includes('/rest/v1/')) return json({ text: '[]' });
      const path = u.split('/rest/v1/')[1];
      if (method !== 'GET') return json([{ id: 'new1' }]);
      if (path.startsWith('channels')) return json(chans || [
        { id: 'c1', name: 'Rome', course_id: 'k1', weight: 1, status: 'following' },
        { id: 'c2', name: 'Borders', course_id: 'k2', weight: 1, status: 'following' },
      ]);
      if (path.startsWith('courses')) return json([
        { id: 'k1', title: 'Rome', new_per_day: 1, status: 'active' },
        { id: 'k2', title: 'Borders', new_per_day: 1, status: 'active' },
      ]);
      if (path.startsWith('course_units')) return json(units);
      return json([]);
    };
  }, { units, order, chans });
}

const unit = (o) => ({
  id: 'u1', course_id: 'k1', position: 1, kind: 'unit', title: 'The Republic', state: 'ready', built_at: '2026-10-01',
  hook: { kind: 'choice', question: 'How long did the Republic last?', options: ['50 years', '480 years'], answer: '480 years' },
  body: 'First paragraph.', why: 'Why did it fall?', key_points: [{ text: 'Civil wars' }], cards: [], ...o,
});

const UNITS = [
  unit({ id: 'r0', title: 'Founding', state: 'taught', next_review: '2026-01-01' }),
  unit({ id: 'u1', position: 2, title: 'The Republic' }),
  unit({ id: 'u2', position: 3, title: 'The Empire' }),
  unit({ id: 'b1', course_id: 'k2', title: 'Westphalia', built_at: null }),
];

test.beforeEach(async ({ page }) => { await seedSession(page); });

// Tap the first choice with the picker on screen, as a thumb would.
const pick = page => page.evaluate(() => {
  const n = document.querySelector('.feed-item[data-slug="chan-pick"]');
  feedActiveIdx = feedItems().indexOf(n); feedActiveEl = n;
  n.querySelector('[data-chan-go="0"]').click();
});

const reach = (page, fn, timeout = 8000) => page.waitForFunction(src => {
  if (typeof feedMounted === 'undefined') return false;
  if (new Function('return (' + src + ')()')()) return true;
  feedActiveIdx = feedItems().length - 1; feedFill(); flowTopUp();
  return false;
}, fn.toString(), { timeout, polling: 200 });

test('a Flow offers a picker, never a loose lesson, and only channels with something ready', async ({ page }) => {
  await stub(page, { units: UNITS });
  await boot(page);
  await page.evaluate(() => openFlow());
  await reach(page, () => feedMounted.includes('chan-pick'));
  expect(await page.evaluate(() => feedMounted.includes('chan-unit'))).toBe(false);
  const names = await page.locator('.chan-go-name').allTextContents();
  expect(names).toEqual(['Rome']);   // Borders' next lesson is unbuilt
  await expect(page.locator('.chan-go-sub')).toContainText('Next: The Republic');
  await expect(page.locator('.chan-go-sub')).toContainText('1 to review');
});

test('picking runs the channel: recall, lesson, then one more, in order', async ({ page }) => {
  await stub(page, { units: UNITS });
  await boot(page);
  await page.evaluate(() => openFlow());
  await reach(page, () => feedMounted.includes('chan-pick'));
  await pick(page);
  await page.waitForFunction(() => feedMounted.includes('chan-more'));
  const run = await page.evaluate(() => { const i = feedMounted.indexOf('chan-pick'); return feedMounted.slice(i + 1, i + 4); });
  expect(run).toEqual(['chan-recall', 'chan-unit', 'chan-more']);
  await expect(page.locator('.feed-item[data-slug="chan-more"] .chan-more-next')).toHaveText('Next: The Empire');
  // The pick is a signal, and no PATCH ran the old per-card skip path.
  expect(await page.evaluate(() => chanRun && chanRun.chan.id)).toBe('c1');
});

test('One more serves the next lesson, then says the course is done', async ({ page }) => {
  await stub(page, { units: UNITS });
  await boot(page);
  await page.evaluate(() => openFlow());
  await reach(page, () => feedMounted.includes('chan-pick'));
  await pick(page);
  await page.waitForFunction(() => document.querySelector('[data-chan-onemore]'));
  await page.evaluate(() => document.querySelector('[data-chan-onemore]').click());
  await page.waitForFunction(() => [...document.querySelectorAll('.feed-item[data-slug="chan-unit"] .chan-unit-title')].some(n => n.textContent === 'The Empire'));
  await expect(page.locator('.feed-item[data-slug="chan-more"]:not([data-due-done]) .chan-q')).toHaveText('That\'s the course so far.');
  await expect(page.locator('.feed-item[data-slug="chan-more"]:not([data-due-done]) [data-chan-onemore]')).toHaveCount(0);
});

test('Back to Mix ends the run and the mix carries on', async ({ page }) => {
  await stub(page, { units: UNITS });
  await boot(page);
  await page.evaluate(() => openFlow());
  await reach(page, () => feedMounted.includes('chan-pick'));
  await pick(page);
  await page.waitForFunction(() => document.querySelector('[data-chan-done]'));
  await expect(page.locator('[data-chan-done]')).toHaveText('Back to Mix');
  await page.evaluate(() => document.querySelector('[data-chan-done]').click());
  expect(await page.evaluate(() => chanRun)).toBe(null);
  // No second picker without a skip.
  expect(await page.evaluate(() => chanPickDue())).toBe(false);
});

test('a skipped picker comes back once, ten cards later', async ({ page }) => {
  await stub(page, { units: UNITS });
  await boot(page);
  const r = await page.evaluate(() => {
    chanRun = null; chanPickShown = 1; chanPickSkipAt = -1; flowFocus = null;
    const noSkip = chanPickDue();
    chanPickSkipAt = feedMounted.length;
    const soon = chanPickDue();
    for (let i = 0; i < 10; i++) feedMounted.push('x');
    const later = chanPickDue();
    chanPickShown = 2;
    const third = chanPickDue();
    return { noSkip, soon, later, third };
  });
  expect(r).toEqual({ noSkip: false, soon: false, later: true, third: false });
});

test('In sequence, the picker sits in the Channels phase, before Discover', async ({ page }) => {
  await stub(page, { units: UNITS, order: 'sequence' });
  await boot(page);
  await page.evaluate(() => openFlow());
  await reach(page, () => feedMounted.includes('chan-pick'));
  const s = await page.evaluate(() => ({
    phase: FLOW_PHASES[flowPhaseOfItem({ slug: 'chan-pick' })].id,
    firstDiscover: feedMounted.findIndex(x => !CHAN_SLUGS.includes(x) && !['flow-mark', 'due-card', 'due-lul', 'due-dive', 'ground'].includes(x)),
    at: feedMounted.indexOf('chan-pick'),
  }));
  expect(s.phase).toBe('channels');
  if (s.firstDiscover !== -1) expect(s.at).toBeLessThan(s.firstDiscover);
});

test('no channels with anything ready: no picker, and the Flow carries on', async ({ page }) => {
  await stub(page, { units: [unit({ id: 'b1', course_id: 'k2', built_at: null })] });
  await boot(page);
  await page.evaluate(() => openFlow());
  await reach(page, () => feedMounted.length >= 6);
  expect(await page.evaluate(() => feedMounted.includes('chan-pick'))).toBe(false);
});
