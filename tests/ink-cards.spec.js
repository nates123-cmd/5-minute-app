// Ink cards in the Scroll feed: a resurfaced thought, and an open-challenge nudge.
import { test, expect } from '@playwright/test';
import { boot, seedSession } from './helper.js';

function stubInk(page, { challengeDone = false, thoughts = true } = {}) {
  return page.addInitScript(({ done, withThoughts }) => {
    window.__sbCalls = [];
    const realFetch = window.fetch;
    window.fetch = async (url, opts = {}) => {
      const u = String(url);
      if (u.includes('/rest/v1/')) {
        const path = u.split('/rest/v1/')[1];
        window.__sbCalls.push({ path, method: opts.method || 'GET', body: opts.body || null });
        if (path.startsWith('collections')) return new Response(JSON.stringify([{ id: 'c1', name: 'Learning Habits' }]), { status: 200 });
        if (path.startsWith('thoughts')) return new Response(JSON.stringify(withThoughts ? [
          // Ink stores rich text now — the card must flatten it, not print tags.
          { id: 't1', text: '<div>a <b>bold</b> thought</div><ul><li>one</li></ul>', created_at: '2026-06-01T10:00:00Z', collection_id: 'c1' },
        ] : []), { status: 200 });
        if (path.startsWith('insights') || path.startsWith('mantras')) return new Response('[]', { status: 200 });
        if (path.startsWith('challenges_today')) return new Response(JSON.stringify([
          { id: 'ch1', title: '10 minute brain sesh', why: 'stop drifting', days: null, day_number: 7, streak: 3, done_today: done },
        ]), { status: 200 });
        if (path.startsWith('challenge_logs')) return new Response('[]', { status: 200 });
        return new Response('[]', { status: 200 });
      }
      return realFetch(url, opts);
    };
  }, { done: challengeDone, withThoughts: thoughts });
}

test.beforeEach(async ({ page }) => { await seedSession(page); });

test('a resurfaced Ink thought renders as plain text, never markup', async ({ page }) => {
  await stubInk(page);
  await boot(page);
  const card = await page.evaluate(async () => {
    const items = await CARD_SOURCES['ink-thought'](1);
    return { data: items[0], html: CARD_SPECS['ink-thought'].render(items[0]) };
  });
  expect(card.data.text).toBe('a bold thought\n• one');
  expect(card.data.kind).toBe('Thought');
  expect(card.data.collection).toBe('Learning Habits');
  expect(card.html).not.toContain('<b>');
  expect(card.html).toContain('a bold thought');
});

test('filed items still resurface — the archive is the point', async ({ page }) => {
  await stubInk(page);
  await boot(page);
  const path = await page.evaluate(async () => {
    await CARD_SOURCES['ink-thought'](1);
    return window.__sbCalls.find((c) => c.path.startsWith('thoughts')).path;
  });
  expect(path).not.toContain('status=');
});

test('the challenge nudge only appears while today is still open', async ({ page }) => {
  await stubInk(page, { challengeDone: false });
  await boot(page);
  const open = await page.evaluate(async () => {
    await inkRefreshChallenges();
    const items = await CARD_SOURCES['ink-challenge']();
    return { gated: CARD_GATES['ink-challenge'](), eligible: feedEligible().includes('ink-challenge'), title: items && items[0].title };
  });
  expect(open.gated).toBe(true);
  expect(open.eligible).toBe(true);
  expect(open.title).toBe('10 minute brain sesh');
});

test('once checked in, the nudge drops out of the pool', async ({ page }) => {
  await stubInk(page, { challengeDone: true });
  await boot(page);
  const shut = await page.evaluate(async () => {
    await inkRefreshChallenges();
    return { gated: CARD_GATES['ink-challenge'](), eligible: feedEligible().includes('ink-challenge'), items: await CARD_SOURCES['ink-challenge']() };
  });
  expect(shut.gated).toBe(false);
  expect(shut.eligible).toBe(false);
  expect(shut.items).toBeNull();
});

test('Ink cards are weighted down so they stay occasional', async ({ page }) => {
  await stubInk(page);
  await boot(page);
  const w = await page.evaluate(() => ({
    thought: feedWeight('ink-thought'),
    challenge: feedWeight('ink-challenge'),
    normal: feedWeight('fun-fact'),
  }));
  expect(w.thought).toBeLessThan(w.normal);
  expect(w.challenge).toBeLessThan(w.normal);
});

test('the card chip does not try to open a screen that does not exist', async ({ page }) => {
  await stubInk(page);
  await boot(page);
  const html = await page.evaluate(async () => {
    const items = await CARD_SOURCES['ink-thought'](1);
    return feedItemNode({ slug: 'ink-thought', data: items[0], key: 'k' }).outerHTML;
  });
  expect(html).toContain('feed-chip-static');
  expect(html).not.toContain('data-feed-open="ink-thought"');
  expect(html).toContain('From your Ink');
});

test('checking in from the feed writes one challenge_logs row', async ({ page }) => {
  await stubInk(page, { challengeDone: false });
  await boot(page);
  await page.evaluate(async () => {
    await inkRefreshChallenges();
    const items = await CARD_SOURCES['ink-challenge']();
    const node = feedItemNode({ slug: 'ink-challenge', data: items[0], key: 'k' });
    node.style.position = 'fixed'; node.style.inset = '0'; node.style.zIndex = '9999';
    document.body.appendChild(node);
  });
  await page.locator('[data-ink-check]').click();
  await expect(page.locator('[data-ink-check]')).toHaveText('Done today ✓');
  const post = await page.evaluate(() => window.__sbCalls.find((c) => c.path === 'challenge_logs' && c.method === 'POST'));
  expect(JSON.parse(post.body).active_challenge_id).toBe('ch1');
});
