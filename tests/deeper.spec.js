// Go deeper (break-feed-spec.md phase 1): a sheet over any feed card with a
// "learn more", follow-up chips, an ask box, and a persisted thread.
import { test, expect } from '@playwright/test';
import { boot, seedSession } from './helper.js';

function stub(page, { saved = null } = {}) {
  return page.addInitScript(({ saved }) => {
    window.__calls = [];
    const json = (v) => new Response(JSON.stringify(v), { status: 200, headers: { 'Content-Type': 'application/json', 'Content-Range': '0-0/0' } });
    window.fetch = async (url, opts = {}) => {
      const u = String(url);
      const method = opts.method || 'GET';
      window.__calls.push({ u, method, body: opts.body || null });
      if (u.includes('/functions/v1/claude')) {
        const b = JSON.parse(opts.body || '{}');
        if (JSON.stringify(b.messages).includes('one level deeper'))
          return json({ text: JSON.stringify({ more: 'Deeper text.', questions: ['Why so?', 'Which case?', 'How does it connect?'] }) });
        return json({ text: 'An answer.' });
      }
      if (u.includes('/rest/v1/card_threads') && method === 'GET') return json(saved ? [saved] : []);
      if (u.includes('/rest/v1/flashcards')) return json([{ id: 'f0', front: 'sonder', back: 'Everyone has a vivid inner life.', next_review: '2026-01-01', interval: 1, ease_factor: 2.5 }]);
      return json([]);
    };
  }, { saved });
}

test.beforeEach(async ({ page }) => { await seedSession(page); });

test('opening loads learn-more and three chips, and saves a thread', async ({ page }) => {
  await stub(page);
  await boot(page);
  await page.evaluate(() => openFlow());
  await page.waitForFunction(() => document.querySelector('.feed-item[data-slug="due-card"]'), null, { timeout: 8000 });
  await page.evaluate(() => deeperOpen(document.querySelector('.feed-item[data-slug="due-card"]')));
  await expect(page.locator('#deeper-more')).toContainText('Deeper text.');
  await expect(page.locator('.deeper-chip')).toHaveCount(3);
  // The flashcard's thread is grounded in both sides, not just the prompt.
  const sent = await page.evaluate(() => window.__calls.find(c => c.u.includes('/functions/v1/claude') && (c.body || '').includes('one level deeper')).body);
  expect(sent).toContain('Everyone has a vivid inner life.');
  await page.waitForFunction(() => window.__calls.some(c => c.u.includes('/rest/v1/card_threads') && c.method === 'POST'));
});

test('a chip asks, the answer lands in the thread, and the row is patched', async ({ page }) => {
  await stub(page);
  await boot(page);
  await page.evaluate(() => openFlow());
  await page.waitForFunction(() => document.querySelector('.feed-item[data-slug="due-card"]'), null, { timeout: 8000 });
  await page.evaluate(() => deeperOpen(document.querySelector('.feed-item[data-slug="due-card"]')));
  await page.locator('.deeper-chip').first().click();
  await expect(page.locator('.deeper-msg.is-a')).toHaveText('An answer.');
  await expect(page.locator('.deeper-chip')).toHaveCount(2);
  await page.waitForFunction(() => window.__calls.some(c => c.u.includes('/rest/v1/card_threads?id=eq.') && c.method === 'PATCH'));
});

test('a saved thread is reused without calling the model', async ({ page }) => {
  await stub(page, { saved: { id: 't1', learn_more: 'Saved text.', questions: ['Q1?'], messages: [{ role: 'user', content: 'Earlier?' }, { role: 'assistant', content: 'Earlier answer.' }] } });
  await boot(page);
  await page.evaluate(() => openFlow());
  await page.waitForFunction(() => document.querySelector('.feed-item[data-slug="due-card"]'), null, { timeout: 8000 });
  await page.evaluate(() => deeperOpen(document.querySelector('.feed-item[data-slug="due-card"]')));
  await expect(page.locator('#deeper-more')).toContainText('Saved text.');
  await expect(page.locator('.deeper-msg.is-a')).toHaveText('Earlier answer.');
  // The feed's own background generation also calls the model; only the
  // sheet's opening call matters here.
  expect(await page.evaluate(() => window.__calls.filter(c => (c.body || '').includes('one level deeper')).length)).toBe(0);
});

test('Done closes the sheet and the feed is where it was', async ({ page }) => {
  await stub(page);
  await boot(page);
  await page.evaluate(() => openFlow());
  await page.waitForFunction(() => document.querySelector('.feed-item[data-slug="due-card"]'), null, { timeout: 8000 });
  await page.evaluate(() => deeperOpen(document.querySelector('.feed-item[data-slug="due-card"]')));
  await page.locator('.deeper-done').click();
  await expect(page.locator('#deeper')).toBeHidden();
  await expect(page.locator('#screen-feed')).toHaveClass(/active/);
});
