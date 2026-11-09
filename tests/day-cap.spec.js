// Daily cap (Nate, 2026-11-09): a day deals at most SRS_DAY_CAP flashcard
// grades across the Review screen and the Flow; the backlog past the cap
// stays due in the table and is named, never dealt, until "Do 50 more".
import { test, expect } from '@playwright/test';
import { boot, seedSession } from './helper.js';

// Supabase stub with `due` flashcards owed, kept live in window.__due: a
// grade (PATCH) takes one off, and a test that pre-spends the budget sets
// it directly. Count requests answer with an honest Content-Range; list
// requests honour `limit=`.
function stubCards(page, { due = 200 } = {}) {
  return page.addInitScript(({ due }) => {
    window.__sbCalls = [];
    window.__due = due;
    const json = (v, extra = {}) => new Response(JSON.stringify(v), {
      status: 200, headers: { 'Content-Type': 'application/json', 'Content-Range': '0-0/0', ...extra },
    });
    window.fetch = async (url, opts = {}) => {
      const u = String(url);
      if (!u.includes('/rest/v1/')) return json([]);
      const path = u.split('/rest/v1/')[1];
      window.__sbCalls.push({ path, method: opts.method || 'GET', body: opts.body || null });
      if (path.startsWith('flashcards')) {
        if (opts.method === 'PATCH') { window.__due = Math.max(0, window.__due - 1); return json(null); }
        const hdr = (opts.headers || {});
        if (hdr['Prefer'] === 'count=exact') return json([], { 'Content-Range': '0-0/' + window.__due });
        if (path.includes('source=eq.')) return json([]);
        const m = path.match(/limit=(\d+)/);
        const n = Math.min(window.__due, m ? parseInt(m[1], 10) : window.__due);
        return json(Array.from({ length: n }, (_, i) => ({ id: 'f' + i, front: 'Front ' + i, back: 'Back ' + i, next_review: '2026-01-01', interval: 1, ease_factor: 2.5, ladder_level: 0, ladder_streak: 0 })));
      }
      return json([]);
    };
  }, { due });
}

test('budget math: cap, spend, extend, and a new day resets', async ({ page }) => {
  await seedSession(page);
  await stubCards(page, { due: 200 });
  await boot(page);
  const r = await page.evaluate(() => {
    const out = {};
    out.cap = SRS_DAY_CAP;
    out.fresh = srsBudgetLeft();
    out.split = srsDaySplit(200);
    for (let i = 0; i < 10; i++) srsBudgetSpend();
    out.afterTen = srsBudgetLeft();
    out.splitTen = srsDaySplit(190);
    srsBudgetExtend();
    out.extended = srsBudgetLeft();
    // Yesterday's row is ignored: a new day starts clean.
    localStorage.setItem('break_srs_day', JSON.stringify({ d: '2000-01-01', graded: 49, extra: 100 }));
    out.newDay = srsBudgetLeft();
    return out;
  });
  expect(r.cap).toBe(50);
  expect(r.fresh).toBe(50);
  expect(r.split).toEqual({ today: 50, behind: 150, left: 50 });
  expect(r.afterTen).toBe(40);
  expect(r.splitTen).toEqual({ today: 40, behind: 150, left: 40 });
  expect(r.extended).toBe(90);
  expect(r.newDay).toBe(50);
});

test('srsGetDue asks for and returns only the budget; none when spent', async ({ page }) => {
  await seedSession(page);
  await stubCards(page, { due: 200 });
  await boot(page);
  const r = await page.evaluate(async () => {
    const a = await srsGetDue();
    const call = window.__sbCalls.filter(c => c.path.startsWith('flashcards?next_review')).pop();
    for (let i = 0; i < 50; i++) srsBudgetSpend();
    const before = window.__sbCalls.length;
    const b = await srsGetDue();
    return { aLen: a.length, limit: call && call.path.match(/limit=(\d+)/)[1], bLen: b.length, fetchedWhenSpent: window.__sbCalls.length - before };
  });
  expect(r.aLen).toBe(50);
  expect(r.limit).toBe('50');
  expect(r.bLen).toBe(0);
  expect(r.fetchedWhenSpent).toBe(0);
});

test('home pillar shows today\'s count and names the backlog', async ({ page }) => {
  await seedSession(page);
  await stubCards(page, { due: 200 });
  await boot(page);
  await page.evaluate(() => updateDueBadge());
  await expect(page.locator('#srs-due-count')).toHaveText('50');
  await expect(page.locator('#srs-due-sub')).toHaveText('cards today · 150 more waiting');
  await page.evaluate(async () => { for (let i = 0; i < 50; i++) srsBudgetSpend(); window.__due = 150; await updateDueBadge(); });
  await expect(page.locator('#srs-due-count')).toHaveText('0');
  await expect(page.locator('#srs-due-sub')).toHaveText('done for today · 150 waiting');
});

test('under the cap the pillar reads as before', async ({ page }) => {
  await seedSession(page);
  await stubCards(page, { due: 12 });
  await boot(page);
  await page.evaluate(() => updateDueBadge());
  await expect(page.locator('#srs-due-count')).toHaveText('12');
  await expect(page.locator('#srs-due-sub')).toHaveText('cards due');
});

test('Review screen: a capped day ends with the backlog and a "Do 50 more" that deals again', async ({ page }) => {
  await seedSession(page);
  await stubCards(page, { due: 200 });
  await boot(page);
  // Spend the day down to 2 so the session is short, then run it out.
  await page.evaluate(async () => {
    for (let i = 0; i < 48; i++) srsBudgetSpend();
    window.__due = 152;
    showScreen('srs-review');
    await loadSrsReview();
  });
  expect(await page.evaluate(() => srsQueue.length)).toBe(2);
  await page.evaluate(async () => { await rateSrsCard(2); await rateSrsCard(2); });
  await expect(page.locator('.srs-done-title')).toHaveText('That\'s 2 for today');
  await expect(page.locator('.srs-done-sub').first()).toContainText('150 more waiting');
  await expect(page.locator('#srs-more-btn')).toHaveText('Do 50 more');
  expect(await page.evaluate(() => srsBudgetLeft())).toBe(0);
  await page.click('#srs-more-btn');
  await page.waitForFunction(() => typeof srsQueue !== 'undefined' && srsQueue.length === 50);
  expect(await page.evaluate(() => srsBudgetLeft())).toBe(50);
  await expect(page.locator('.srs-done-title')).toHaveCount(0);
});

test('Review screen: a clean finish still says "Session complete"', async ({ page }) => {
  await seedSession(page);
  await stubCards(page, { due: 1 });
  await boot(page);
  await page.evaluate(async () => { showScreen('srs-review'); await loadSrsReview(); await rateSrsCard(2); });
  await expect(page.locator('.srs-done-title')).toHaveText('Session complete');
  await expect(page.locator('#srs-more-btn')).toHaveCount(0);
});

test('Flow: the Cards rail counts today\'s share, and the mark offers more', async ({ page }) => {
  await seedSession(page);
  await stubCards(page, { due: 200 });
  await page.addInitScript(() => localStorage.setItem('break_flow_order', 'sequence'));
  await boot(page);
  await page.evaluate(async () => { for (let i = 0; i < 49; i++) srsBudgetSpend(); window.__due = 151; await openFlow(); });
  await page.waitForFunction(() => flowCounts && flowCounts.recall === 1);
  expect(await page.evaluate(() => flowBehind)).toBe(150);
  const mark = await page.evaluate(() => flowMarkData(FLOW_PHASES[0], 'Channels'));
  expect(mark.text).toBe('That\'s 1 for today. 150 more waiting.');
  expect(mark.more).toBe('Do 50 more');
  const html = await page.evaluate(d => CARD_SPECS['flow-mark'].render(d), mark);
  expect(html).toContain('data-srs-more="1"');
  expect(html).toContain('Do 50 more');
  // Another phase's mark is untouched.
  const other = await page.evaluate(() => flowMarkData(FLOW_PHASES[2], 'Dive'));
  expect(other.more).toBeUndefined();
  expect(other.text).toBe('Queue clear.');
});

test('Flow: "Do 50 more" lifts the cap and un-dries Cards', async ({ page }) => {
  await seedSession(page);
  await stubCards(page, { due: 200 });
  await page.addInitScript(() => localStorage.setItem('break_flow_order', 'sequence'));
  await boot(page);
  await page.evaluate(async () => { for (let i = 0; i < 50; i++) srsBudgetSpend(); window.__due = 150; await openFlow(); });
  await page.waitForFunction(() => flowCounts && flowCounts.recall === 0);
  await page.evaluate(async () => { flowDry.recall = true; flowPhase = 2; await flowMoreCards(); });
  const r = await page.evaluate(() => ({ left: srsBudgetLeft(), dry: !!flowDry.recall, phase: flowPhase, recall: flowCounts.recall, behind: flowBehind }));
  expect(r.left).toBe(50);
  expect(r.dry).toBe(false);
  expect(r.phase).toBe(0);
  expect(r.recall).toBe(50);
  expect(r.behind).toBe(100);
});
