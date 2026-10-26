// Every card can be flicked past (Nate, 2026-10-26: "I should always be able
// to flick past something"). Card bodies used to be `overscroll-behavior:
// contain`, which stopped a swipe at the card's edge: a long channel lesson
// scrolled to its end and stuck. These drive REAL touch scroll gestures
// (CDP synthesizeScrollGesture), not scrollTop pokes, so scroll chaining is
// what is actually under test.
import { test, expect } from '@playwright/test';
import { boot, seedSession } from './helper.js';

test.use({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true });

const LONG = Array.from({ length: 8 }, (_, i) => 'Paragraph ' + i + ' ' + 'lorem ipsum dolor sit amet consectetur '.repeat(8)).join('\n\n');

function stub(page) {
  return page.addInitScript((long) => {
    localStorage.removeItem('break_flow_order');
    const json = (v) => new Response(JSON.stringify(v), { status: 200, headers: { 'Content-Type': 'application/json', 'Content-Range': '0-0/0' } });
    const unit = (o) => ({ course_id: 'k1', kind: 'unit', state: 'ready', built_at: '2026-10-01',
      hook: { kind: 'choice', question: 'Q?', options: ['a', 'b'], answer: 'a' }, body: long, why: 'Why?',
      key_points: [{ text: 'k' }], cards: [], ...o });
    window.fetch = async (url, opts = {}) => {
      const u = String(url);
      if (!u.includes('/rest/v1/')) return json({ text: '[]' });
      const path = u.split('/rest/v1/')[1];
      if ((opts.method || 'GET') !== 'GET') return json([{ id: 'n' }]);
      if (path.startsWith('channels')) return json([{ id: 'c1', name: 'Japan', course_id: 'k1', weight: 1, status: 'following' }]);
      if (path.startsWith('courses')) return json([{ id: 'k1', title: 'J', new_per_day: 1 }]);
      if (path.startsWith('course_units')) return json([unit({ id: 'a1', position: 1, title: 'Manchukuo' }), unit({ id: 'a2', position: 2, title: 'Next' })]);
      if (path.startsWith('flashcards')) return json(Array.from({ length: 3 }, (_, i) => ({ id: 'f' + i, front: 'F' + i, back: 'B' + i, interval: 1, ease_factor: 2.5 })));
      return json([]);
    };
  }, LONG);
}

test.beforeEach(async ({ page }) => { await seedSession(page); });

// Swipe up until the active card changes. A long card may take several
// swipes to reach its end; it must never take forever.
async function flickPast(page, cdp, maxSwipes = 8) {
  // Compare the element, not the index: unmounting a spent card shifts indexes.
  await page.evaluate(() => { window.__from = feedActiveEl; });
  for (let i = 0; i < maxSwipes; i++) {
    await cdp.send('Input.synthesizeScrollGesture', { x: 195, y: 620, yDistance: -560, speed: 2000, gestureSourceType: 'touch' });
    await page.waitForTimeout(350);
    if (await page.evaluate(() => feedActiveEl !== window.__from)) return true;
  }
  return false;
}

test('a plain card flicks to the next one in a single swipe', async ({ page }) => {
  await stub(page);
  await boot(page);
  await page.evaluate(() => openFlow());
  await page.waitForFunction(() => feedItems().length >= 2);
  const cdp = await page.context().newCDPSession(page);
  expect(await flickPast(page, cdp, 1)).toBe(true);
});

test('a revealed long channel lesson can be flicked past', async ({ page }) => {
  await stub(page);
  await boot(page);
  await page.evaluate(() => openFlow());
  const cdp = await page.context().newCDPSession(page);
  // Flick until the picker is on screen, pick, then reveal the lesson.
  for (let i = 0; i < 10 && await page.evaluate(() => feedActiveEl?.dataset.slug !== 'chan-pick'); i++) {
    await page.waitForFunction(() => feedItems().length - 1 > feedActiveIdx, null, { timeout: 5000 });
    expect(await flickPast(page, cdp)).toBe(true);
  }
  expect(await page.evaluate(() => feedActiveEl.dataset.slug)).toBe('chan-pick');
  await page.evaluate(() => feedActiveEl.querySelector('[data-chan-go="0"]').click());
  await page.waitForFunction(() => feedActiveEl?.dataset.slug === 'chan-unit', null, { timeout: 5000 });
  await page.evaluate(() => feedActiveEl.querySelector('[data-chan-pick="0"]').click());
  const tall = await page.evaluate(() => { const b = feedActiveEl.querySelector('.feed-body'); return b.scrollHeight > b.clientHeight * 1.5; });
  expect(tall).toBe(true);   // really is a card you have to scroll through
  expect(await flickPast(page, cdp)).toBe(true);
  expect(await page.evaluate(() => feedActiveEl.dataset.slug)).toBe('chan-more');
  // And the end-of-run card itself never blocks: there is always one more card behind it.
  await page.waitForFunction(() => feedItems().length - 1 > feedActiveIdx, null, { timeout: 5000 });
  expect(await flickPast(page, cdp)).toBe(true);
});
