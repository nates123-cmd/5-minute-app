// Variant-pack generation: caching, the Haiku-first / Sonnet-retry model
// policy, and the one-card-ahead prefetch. Every model call is intercepted at
// the network layer, so these assert real spend behaviour without spending.
import { test, expect } from '@playwright/test';
import { boot, seedSession } from './helper.js';

const FRONT = 'tendentious';
const BACK = 'expressing a strong opinion';

const GOOD_PACK = {
  reworded: { kind: 'cloze', prompt: 'His ____ history reads like a brief.' },
  discriminate: { stem: 'Which is right?', options: [
    { text: 'A tendentious account.', correct: true },
    { text: 'A tendentious hallway.', correct: false },
    { text: 'Tendentious after the flu.', correct: false },
  ], why: 'It describes an argument.' },
  produce: { prompt: 'Use it in a sentence.', criteria: ['names a slant'] },
  mc_distractors: ['careless with facts', 'long-winded', 'written in haste'],
};

// A pack the validator will reject the hard half of: two correct options.
const WEAK_PACK = Object.assign({}, GOOD_PACK, {
  discriminate: { stem: 's', options: [
    { text: 'a', correct: true }, { text: 'b', correct: true }, { text: 'c', correct: false },
  ] },
});

// Route both the Claude proxy and PostgREST. Returns a live log of the models
// each Claude call asked for, in order.
async function interceptClaude(page, bodies) {
  const models = [];
  let n = 0;
  await page.route('**/functions/v1/claude', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    models.push(body.model);
    const payload = bodies[Math.min(n++, bodies.length - 1)];
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(payload) }] }),
    });
  });
  // Any Supabase table write (the pack PATCH, badge counts) succeeds silently.
  await page.route('**/rest/v1/**', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: '[]', headers: { 'Content-Range': '0-0/0' },
  }));
  return () => models;
}

const CARD = () => ({ id: 'card-1', front: FRONT, back: BACK, interval: 1, ease_factor: 2.5, ladder_level: 2 });

test.beforeEach(async ({ page }) => { await seedSession(page); });

test('a good Haiku pack is accepted with no Sonnet retry', async ({ page }) => {
  const models = await interceptClaude(page, [GOOD_PACK]);
  await boot(page);
  const pack = await page.evaluate((c) => ladderEnsurePack(c), CARD());
  expect(pack.reworded.prompt).toContain('His ____ history');
  expect(pack.discriminate.options).toHaveLength(3);
  expect(models()).toEqual(['claude-haiku-4-5']);   // exactly one call, cheap model
});

test('a weak discriminate block triggers exactly one Sonnet retry', async ({ page }) => {
  const models = await interceptClaude(page, [WEAK_PACK, GOOD_PACK]);
  await boot(page);
  const pack = await page.evaluate((c) => ladderEnsurePack(c), CARD());
  expect(models()).toEqual(['claude-haiku-4-5', 'claude-sonnet-4-6']);
  expect(pack.discriminate.options).toHaveLength(3);   // the retry's good block won
});

test('if the retry is also weak, the salvageable half is still kept', async ({ page }) => {
  const models = await interceptClaude(page, [WEAK_PACK, WEAK_PACK]);
  await boot(page);
  const pack = await page.evaluate((c) => ladderEnsurePack(c), CARD());
  expect(models()).toHaveLength(2);                  // never more than two calls
  expect(pack.discriminate).toBeUndefined();         // dropped by the validator
  expect(pack.reworded).toBeTruthy();                // rung 2 still works
});

test('the pack is generated once, then served from the row', async ({ page }) => {
  const models = await interceptClaude(page, [GOOD_PACK]);
  await boot(page);
  const same = await page.evaluate(async (c) => {
    const a = await ladderEnsurePack(c);
    const b = await ladderEnsurePack(c);   // c now carries variants + variants_src
    return a.src === b.src;
  }, CARD());
  expect(same).toBe(true);
  expect(models()).toHaveLength(1);        // the second call never hit the wire
});

test('concurrent requests for the same card share one in-flight call', async ({ page }) => {
  const models = await interceptClaude(page, [GOOD_PACK]);
  await boot(page);
  await page.evaluate(async (c) => {
    await Promise.all([ladderEnsurePack(c), ladderEnsurePack(c), ladderEnsurePack(c)]);
  }, CARD());
  expect(models()).toHaveLength(1);        // deduped through ladderPending
});

test('the persisted pack carries the fingerprint of the card it was built from', async ({ page }) => {
  await interceptClaude(page, [GOOD_PACK]);
  await boot(page);
  const ok = await page.evaluate(async (c) => {
    const p = await ladderEnsurePack(c);
    return p.src === ladderFingerprint(c.front, c.back) && c.variants_src === p.src;
  }, CARD());
  expect(ok).toBe(true);
});

test('prefetch warms exactly one card ahead, not the whole queue', async ({ page }) => {
  const models = await interceptClaude(page, [GOOD_PACK]);
  await boot(page);
  await page.evaluate(async ([front, back]) => {
    srsMode = 'ladder';
    srsQueue = [1, 2, 3, 4, 5].map(i => ({
      id: 'c' + i, front, back, interval: 1, ease_factor: 2.5, ladder_level: 2,
    }));
    srsCurrent = 0;
    ladderPrefetchNext();
    await new Promise(r => setTimeout(r, 300));
  }, [FRONT, BACK]);
  expect(models()).toHaveLength(1);   // card 2 only — never queue.length
});

test('prefetch does nothing in the manual modes', async ({ page }) => {
  const models = await interceptClaude(page, [GOOD_PACK]);
  await boot(page);
  await page.evaluate(async ([front, back]) => {
    srsMode = 'flip';
    srsQueue = [{ id: 'a', front, back, ladder_level: 2 }, { id: 'b', front, back, ladder_level: 2 }];
    srsCurrent = 0;
    ladderPrefetchNext();
    await new Promise(r => setTimeout(r, 200));
  }, [FRONT, BACK]);
  expect(models()).toHaveLength(0);
});

test('a proxy failure resolves to null so the caller can degrade', async ({ page }) => {
  await page.route('**/functions/v1/claude', (route) => route.fulfill({ status: 500, body: 'boom' }));
  await page.route('**/rest/v1/**', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: '[]', headers: { 'Content-Range': '0-0/0' } }));
  await boot(page);
  const pack = await page.evaluate((c) => ladderEnsurePack(c), CARD());
  expect(pack).toBeNull();   // resolved, not thrown
});

test('rendering an ungenerated rung-2 card generates the pack, then shows it', async ({ page }) => {
  const models = await interceptClaude(page, [GOOD_PACK]);
  await boot(page);
  await page.evaluate(([front, back]) => {
    srsMode = 'ladder';
    srsQueue = [{ id: 'solo', front, back, interval: 1, ease_factor: 2.5, ladder_level: 2 }];
    srsCurrent = 0;
    srsStats = { easy: 0, hard: 0, miss: 0, promoted: 0, mastered: 0 };
    showScreen('srs-review');
    return renderSrsCard();
  }, [FRONT, BACK]);
  await expect(page.locator('#srs-flip-card .srs-card-face').first()).toContainText('His ____ history');
  await expect(page.locator('#srs-rung')).toContainText('Reworded');
  expect(models()).toHaveLength(1);
});

test('MC mode reuses the cached distractors instead of paying per render', async ({ page }) => {
  const models = await interceptClaude(page, [GOOD_PACK]);
  await boot(page);
  await page.evaluate(([front, back]) => {
    srsMode = 'mc';
    srsQueue = [{ id: 'mc1', front, back, interval: 1, ease_factor: 2.5, ladder_level: 0 }];
    srsCurrent = 0;
    showScreen('srs-review');
    return renderSrsCard();
  }, [FRONT, BACK]);
  await expect(page.locator('.srs-mc-btn')).toHaveCount(4);
  // Re-render the same card: the old code called Claude again here.
  await page.evaluate(() => renderSrsCard());
  await expect(page.locator('.srs-mc-btn')).toHaveCount(4);
  expect(models()).toHaveLength(1);
});
