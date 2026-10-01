// Channels (break-feed-spec.md phase 2): followed topics whose course units
// come through the feed, offered flashcards, and the 70/30 composer.
import { test, expect } from '@playwright/test';
import { boot, seedSession } from './helper.js';

function stub(page, { units } = {}) {
  return page.addInitScript(({ units }) => {
    Math.random = () => 0.1;   // the 70/30 roll always lands on channels
    window.__calls = [];
    const json = (v) => new Response(JSON.stringify(v), { status: 200, headers: { 'Content-Type': 'application/json', 'Content-Range': '0-0/0' } });
    window.fetch = async (url, opts = {}) => {
      const u = String(url);
      const method = opts.method || 'GET';
      window.__calls.push({ u, method, body: opts.body || null });
      if (!u.includes('/rest/v1/')) return json({ text: '[]' });
      const path = u.split('/rest/v1/')[1];
      if (method !== 'GET') return json([{ id: 'new1' }]);
      if (path.startsWith('channels')) return json([{ id: 'c1', name: 'Rome', course_id: 'k1', weight: 1, status: 'following' }]);
      if (path.startsWith('courses')) return json([{ id: 'k1', title: 'Rome', new_per_day: 2, status: 'active' }]);
      if (path.startsWith('course_units')) return json(units);
      return json([]);
    };
  }, { units });
}

const unit = (o) => ({
  id: 'u1', course_id: 'k1', position: 1, kind: 'unit', title: 'The Republic', state: 'ready', built_at: '2026-10-01',
  hook: { kind: 'choice', question: 'How long did the Republic last?', options: ['50 years', '480 years', '1000 years'], answer: '480 years' },
  body: 'First paragraph.\n\nSecond paragraph.', why: 'Why did it fall?', key_points: [{ text: 'Civil wars' }],
  cards: [{ front: 'Roman Republic dates', back: '509 to 27 BC' }], ...o,
});

test.beforeEach(async ({ page }) => { await seedSession(page); });

// The feed only mounts a few cards ahead of the one on screen, so "scroll"
// forward while waiting for a slug to show up.
const reach = (page, slug) => page.waitForFunction(s => {
  if (document.querySelector('.feed-item[data-slug="' + s + '"]')) return true;
  feedActiveIdx = feedItems().length - 1;
  feedFill();
  return false;
}, slug, { timeout: 8000, polling: 200 });

test('a followed channel puts its next built unit in the feed', async ({ page }) => {
  await stub(page, { units: [unit()] });
  await boot(page);
  await page.evaluate(() => openFeed());
  await reach(page, 'chan-unit');
  await expect(page.locator('.feed-item[data-slug="chan-unit"] .feed-chip')).toContainText('Rome · 1 of 1');
  // The teach is hidden until you guess.
  await expect(page.locator('.feed-item[data-slug="chan-unit"] .chan-teach')).toBeHidden();
});

test('guessing reveals the teach, marks it taught, and offers its flashcards', async ({ page }) => {
  await stub(page, { units: [unit()] });
  await boot(page);
  await page.evaluate(() => openFeed());
  await reach(page, 'chan-unit');
  await page.evaluate(() => document.querySelector('[data-chan-pick="0"]').click());
  await expect(page.locator('.feed-item[data-slug="chan-unit"] .chan-teach')).toBeVisible();
  await expect(page.locator('.chan-opt.is-correct')).toHaveText('480 years');
  await expect(page.locator('.chan-opt.is-wrong')).toHaveText('50 years');
  const patch = await page.evaluate(() => window.__calls.find(c => c.method === 'PATCH' && c.u.includes('course_units?id=eq.u1')));
  expect(JSON.parse(patch.body).state).toBe('taught');
  // An offer card is queued, and nothing is written to flashcards yet.
  expect(await page.evaluate(() => chanBuffer.some(x => x.slug === 'card-offer'))).toBe(true);
  expect(await page.evaluate(() => window.__calls.some(c => c.method === 'POST' && c.u.includes('/flashcards')))).toBe(false);
});

test('offer card: Keep saves, Skip does not', async ({ page }) => {
  await stub(page, { units: [unit()] });
  await boot(page);
  await page.evaluate(() => {
    openFeed();
    const node = feedItemNode({ slug: 'card-offer', key: 'card-offer:u1',
      data: { from: 'Rome', cards: [{ front: 'A', back: 'a' }, { front: 'B', back: 'b' }], unit: { id: 'u1' } } });
    document.getElementById('feed-track').prepend(node);
  });
  await page.evaluate(() => document.querySelector('[data-offer-skip="1"]').click());
  await expect(page.locator('.offer-row[data-offer-row="1"]')).toBeHidden();
  await page.evaluate(() => document.querySelector('[data-offer-keep="0"]').click());
  await page.waitForFunction(() => window.__calls.some(c => c.method === 'POST' && c.u.includes('/flashcards')));
  const posts = await page.evaluate(() => window.__calls.filter(c => c.method === 'POST' && c.u.includes('/flashcards')).map(c => JSON.parse(c.body).front));
  expect(posts).toEqual(['A']);
});

test('a due unit comes back as a recall card and grading schedules it', async ({ page }) => {
  await stub(page, { units: [unit({ state: 'taught', next_review: '2026-01-01' })] });
  await boot(page);
  await page.evaluate(() => openFeed());
  await reach(page, 'chan-recall');
  await page.evaluate(() => document.querySelector('[data-chan-rate="easy"]').click());
  await page.waitForFunction(() => window.__calls.some(c => c.method === 'PATCH' && c.u.includes('course_units?id=eq.u1')));
  const body = await page.evaluate(() => JSON.parse(window.__calls.find(c => c.method === 'PATCH' && c.u.includes('course_units?id=eq.u1')).body));
  expect(body.state).toBe('recalled');
  expect(body.interval).toBe(7);
});

test('"all the presidents" uses the canonical list; other countries do not', async ({ page }) => {
  await stub(page, { units: [] });
  await boot(page);
  const r = await page.evaluate(() => ({
    all: !!coDetectCanon('all the presidents', ''),
    us: !!coDetectCanon('US presidents', ''),
    fr: !!coDetectCanon('presidents of France', ''),
  }));
  expect(r).toEqual({ all: true, us: true, fr: false });
});

test('channel cards never enter the generic weighted draw', async ({ page }) => {
  await stub(page, { units: [] });
  await boot(page);
  const pool = await page.evaluate(() => { feedBucket = 'random'; return feedEligible(); });
  for (const s of ['chan-unit', 'chan-recall', 'card-offer', 'chan-offer']) expect(pool).not.toContain(s);
});

test('Add menu has a Topic option that opens Channels', async ({ page }) => {
  await stub(page, { units: [] });
  await boot(page);
  await page.evaluate(() => document.querySelector('[data-add="topic"]').click());
  await expect(page.locator('#screen-channels')).toHaveClass(/active/);
  await expect(page.locator('#ch-following')).toContainText('Rome');
});
