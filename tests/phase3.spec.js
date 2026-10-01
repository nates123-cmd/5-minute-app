// Phase 3 (break-feed-spec.md): guess-first on bundled cards, interests by
// topic steering the AI cards, and "Follow this?" after a real thread.
import { test, expect } from '@playwright/test';
import { boot, seedSession } from './helper.js';

function stub(page) {
  return page.addInitScript(() => {
    window.__calls = [];
    const json = (v) => new Response(JSON.stringify(v), { status: 200, headers: { 'Content-Type': 'application/json', 'Content-Range': '0-0/0' } });
    window.fetch = async (url, opts = {}) => {
      const u = String(url);
      window.__calls.push({ u, method: opts.method || 'GET', body: opts.body || null });
      if (u.includes('/functions/v1/claude')) return json({ text: '[]' });
      return json([]);
    };
  });
}

test.beforeEach(async ({ page }) => { await seedSession(page); await stub(page); });

test('a bundled bias can open as a three-way guess with the right answer in it', async ({ page }) => {
  await boot(page);
  const q = await page.evaluate(() => CARD_QUIZ['cognitive-bias'](DATA_BIASES[0]));
  expect(q.options).toHaveLength(3);
  expect(q.options).toContain(q.answer);
  expect(q.answer).toBe(await page.evaluate(() => DATA_BIASES[0].name));
  expect(q.stem.length).toBeGreaterThan(10);
  // An AI-made card that isn't in the bundled list gets no quiz.
  expect(await page.evaluate(() => CARD_QUIZ['cognitive-bias']({ name: 'Made Up Bias', example: 'x' }))).toBeNull();
});

test('a wrong guess reveals the card and offers it as a flashcard; Keep saves it', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    Math.random = () => 0.1;                     // quiz always on
    openFeed();
    const node = feedItemNode({ slug: 'cognitive-bias', key: DATA_BIASES[0].name, data: DATA_BIASES[0] });
    node.id = 'mine';
    document.getElementById('feed-track').prepend(node);
  });
  const wrong = await page.evaluate(() => {
    const it = document.getElementById('mine');
    const i = it._quiz.options.findIndex(o => o !== it._quiz.answer);
    it.querySelector('[data-cq-pick="' + i + '"]').click();
    return it._quiz.answer;
  });
  await expect(page.locator('#mine .cq-reveal')).toBeVisible();
  await expect(page.locator('#mine .cq-verdict')).toContainText("It's " + wrong);
  // Nothing saved yet.
  expect(await page.evaluate(() => window.__calls.some(c => c.method === 'POST' && c.u.includes('/flashcards')))).toBe(false);
  await page.locator('#mine [data-cq-keep]').click();
  await page.waitForFunction(() => window.__calls.some(c => c.method === 'POST' && c.u.includes('/flashcards')));
  const posted = await page.evaluate(() => JSON.parse(window.__calls.find(c => c.method === 'POST' && c.u.includes('/flashcards')).body));
  expect(posted.front).toBe(wrong);
});

test('interests decay-weighted by topic steer the AI prompt', async ({ page }) => {
  await boot(page);
  const ctx = await page.evaluate(() => {
    localStorage.removeItem('interest_topics');
    interestBump('Byzantine Empire', 3);
    interestBump('Coral reefs', 2);
    interestBump('Dull thing', 0.3);             // below the floor
    return interestPromptCtx();
  });
  expect(ctx).toContain('Byzantine Empire; Coral reefs');
  expect(ctx).not.toContain('Dull thing');
  // A two-week-old bump counts for half.
  const s = await page.evaluate(() => interestScore({ w: 2, at: Date.now() - 14 * 86400000 }, Date.now()));
  expect(s).toBeCloseTo(1, 1);
});

test('two questions on a Discover card queue a "Follow this?" card', async ({ page }) => {
  await boot(page);
  const offered = await page.evaluate(() => {
    deeperMaybeOfferFollow({ topic: 'Nirvana Fallacy', slug: 'logical-fallacy', item: {},
      messages: [{ role: 'user', content: 'a?' }, { role: 'assistant', content: 'x' }, { role: 'user', content: 'b?' }] });
    return chanBuffer.filter(x => x.slug === 'chan-offer').map(x => x.data.name);
  });
  expect(offered).toEqual(['Nirvana Fallacy']);
  // One question is not enough.
  const one = await page.evaluate(() => {
    chanBuffer = [];
    deeperMaybeOfferFollow({ topic: 'Other', slug: 'fun-fact', item: {}, messages: [{ role: 'user', content: 'a?' }] });
    return chanBuffer.length;
  });
  expect(one).toBe(0);
});
