// Card kinds + ceilings, the Cold grade, the review log, retired cards, and
// passage cards (Nate, 2026-11-09). Every assertion calls the real global.
import { test, expect } from '@playwright/test';
import { boot, seedSession, stubFetchEmpty } from './helper.js';

// Supabase stub that records calls and answers flashcards reads with `cards`.
function stubCards(page, cards) {
  return page.addInitScript((cards) => {
    window.__sbCalls = [];
    const json = (v, extra = {}) => new Response(JSON.stringify(v), {
      status: 200, headers: { 'Content-Type': 'application/json', 'Content-Range': '0-0/' + cards.length, ...extra },
    });
    window.fetch = async (url, opts = {}) => {
      const u = String(url);
      if (u.includes('/functions/v1/claude')) {
        const body = JSON.parse(opts.body || '{}');
        const prompt = (body.messages && body.messages[0] && body.messages[0].content) || '';
        window.__claudeCalls = (window.__claudeCalls || []).concat([prompt]);
        if (prompt.startsWith('Write ONE short paragraph')) {
          const words = [...prompt.matchAll(/^- (\S+) \(/gm)].map(m => m[1]);
          return json({ text: JSON.stringify({ passage: 'A ' + words.map(w => '«' + w + '»').join(' and a ') + ' walked in.' }) });
        }
        if (prompt.startsWith('This is a personal flashcard deck')) {
          return json({ text: JSON.stringify([{ i: 1, why: 'archaic, unlikely to recur' }]) });
        }
        return json({ text: '{}' });
      }
      if (!u.includes('/rest/v1/')) return json([]);
      const path = u.split('/rest/v1/')[1];
      window.__sbCalls.push({ path, method: opts.method || 'GET', body: opts.body || null, headers: opts.headers || {} });
      if (opts.method === 'PATCH' || opts.method === 'POST') return json(null);
      if (path.startsWith('flashcards')) {
        if (path.includes('kind=is.null')) return json([]);
        if (path.includes('status=eq.retired')) return json([]);
        return json(cards);
      }
      return json([]);
    };
  }, cards);
}

const WORDS = Array.from({ length: 7 }, (_, i) => ({
  id: 'w' + i, front: ['meritorious', 'bifurcate', 'incipient', 'pernicious', 'tarried', 'obeisance', 'perfunctory'][i],
  back: 'definition ' + i, kind: 'vocab', source: 'Kindle Vocabulary Builder', next_review: '2026-01-01', interval: 1, ease_factor: 2.5, ladder_level: 0, ladder_streak: 0,
}));
const CONCEPT = { id: 'c1', front: 'What was Louis de Broglie\'s big idea?', back: 'Matter has wave-like properties.', kind: 'concept', source: 'book: x', next_review: '2026-01-01', interval: 1, ease_factor: 2.5, ladder_level: 0, ladder_streak: 0 };

test.describe('kinds and ceilings', () => {
  test.beforeEach(async ({ page }) => { await stubFetchEmpty(page); await boot(page); });

  test('kindGuess files by source, then by shape', async ({ page }) => {
    const r = await page.evaluate(() => [
      kindGuess({ source: 'Kindle Vocabulary Builder', front: 'caroming', back: 'bouncing off' }),
      kindGuess({ source: 'KOReader Vocabulary Builder', front: 'tarried', back: 'stayed longer' }),
      kindGuess({ source: 'Kitchen conversions', front: '4 fl oz = ? cup', back: '1/2 cup' }),
      kindGuess({ source: 'Cooking temps', front: 'Chicken safe temp', back: '165°F' }),
      kindGuess({ source: 'Course: US presidents in order', front: 'Presidents #11-#15', back: 'Polk, Taylor, Fillmore, Pierce, Buchanan' }),
      kindGuess({ source: 'manual', front: 'crocuses', back: 'spring flowers' }),
      kindGuess({ source: 'Break', front: 'What does "histrionic" mean?', back: 'Overly theatrical' }),
      kindGuess({ source: 'Break', front: 'A trend in subgroups reverses when combined', back: 'Simpson\'s Paradox' }),
      kindGuess({ source: 'manual', front: 'Wet brine salt %?', back: '5-6%' }),
      kindGuess({ source: 'book: When We Cease', front: 'In Labatut\'s telling, how does an old lemon tree die?', back: 'Overabundance: one massive final crop that breaks its own branches' }),
      kindGuess({ source: 'Deep Dive', front: 'Who were the Reconstruction presidents?', back: 'Lincoln, Johnson, Grant, Hayes' }),
    ]);
    expect(r).toEqual(['vocab', 'vocab', 'fact', 'fact', 'fact', 'vocab', 'vocab', 'concept', 'fact', 'concept', 'fact']);
  });

  test('ladderCap follows kind; unsorted = concept', async ({ page }) => {
    const r = await page.evaluate(() => [
      ladderCap({ kind: 'vocab' }), ladderCap({ kind: 'fact' }), ladderCap({ kind: 'concept' }), ladderCap({}), ladderCap({ kind: 'garbage' }),
    ]);
    expect(r).toEqual([2, 1, 4, 4, 4]);
  });

  test('a word stops climbing at Reworded and counts as mastered there', async ({ page }) => {
    const r = await page.evaluate(() => {
      const card = { kind: 'vocab', ladder_level: 2, ladder_streak: 0, interval: 10, ease_factor: 2.5 };
      return { next: ladderNext(card, 2, 2), apply: ladderApply(card, 2, 2), mastered: ladderMastered(card), rung: ladderRung({ kind: 'vocab', ladder_level: 4, back: 'a definition' }) };
    });
    expect(r.next).toEqual({ ladder_level: 2, ladder_streak: 1 });
    expect(r.apply.ladder_level).toBe(2);
    expect(r.apply.mastered_at).toBeTruthy();
    // Mastery multiplier applied, climb cap lifted: 10 * 2.5 * 1.3 = 32 > 14.
    expect(r.apply.interval).toBe(33);
    expect(r.mastered).toBe(true);
    // A word stored above its ceiling is still only ASKED at the ceiling.
    expect(r.rung).toBe(1);   // level 2 needs a reworded pack; none, so it degrades to Reversed
  });

  test('a concept still climbs all five rungs under the 14-day climb cap', async ({ page }) => {
    const r = await page.evaluate(() => ladderApply({ kind: 'concept', ladder_level: 1, ladder_streak: 0, interval: 30, ease_factor: 2.5 }, 2, 1));
    expect(r.ladder_level).toBe(2);
    expect(r.interval).toBe(14);
    expect(r.mastered_at).toBeUndefined();
  });

  test('Cold jumps to the ceiling and rests at least 60 days', async ({ page }) => {
    const r = await page.evaluate(() => ({
      word: ladderApply({ kind: 'vocab', ladder_level: 0, ladder_streak: 0, interval: 1, ease_factor: 2.5 }, 3, 0),
      concept: ladderApply({ kind: 'concept', ladder_level: 1, ladder_streak: 0, interval: 1, ease_factor: 2.5 }, 3, 1),
      mature: ladderApply({ kind: 'fact', ladder_level: 1, ladder_streak: 0, interval: 120, ease_factor: 2.5 }, 3, 1),
    }));
    expect(r.word.ladder_level).toBe(2);
    expect(r.word.interval).toBe(60);
    expect(r.word.mastered_at).toBeTruthy();
    expect(r.concept.ladder_level).toBe(4);
    expect(r.concept.interval).toBe(60);
    // Already longer than the floor: an Easy's own schedule wins (120*2.5*1.3 = 390 -> clamped 365).
    expect(r.mature.interval).toBe(365);
    // Ease moves as an Easy would, never more.
    expect(r.word.ease_factor).toBe(2.5);
  });

  test('both rate rows carry Cold', async ({ page }) => {
    const r = await page.evaluate(() => ({ review: srsRateBtnsHtml(false), feed: dueRateRow() }));
    expect(r.review).toContain('data-rate="3"');
    expect(r.review).toContain('>Cold<');
    expect(r.feed).toContain('data-due-rate="3"');
    expect(r.feed).toContain('due-cold');
  });

  test('passage helpers: words qualify, markers render as marks', async ({ page }) => {
    const r = await page.evaluate(() => ({
      word: passageIsWord({ kind: 'vocab', front: 'tarried' }),
      twoWord: passageIsWord({ kind: 'vocab', front: 'Appeal to Novelty' }),
      fact: passageIsWord({ kind: 'fact', front: 'crocuses' }),
      unsorted: passageIsWord({ front: 'bifurcate', source: 'Kindle Vocabulary Builder' }),
      html: passageHtml('She «tarried» by the <door>.'),
      ok: passageMentionsAll('They tarried and bifurcated', [{ front: 'tarried' }, { front: 'bifurcate' }]),
      bad: passageMentionsAll('Nothing here', [{ front: 'tarried' }]),
    }));
    expect(r.word).toBe(true);
    expect(r.twoWord).toBe(false);
    expect(r.fact).toBe(false);
    expect(r.unsorted).toBe(true);
    expect(r.html).toBe('She <mark>tarried</mark> by the &lt;door&gt;.');
    expect(r.ok).toBe(true);
    expect(r.bad).toBe(false);
  });
});

test.describe('with a stubbed deck', () => {
  test('due queries exclude retired cards and a grade logs a review row', async ({ page }) => {
    await seedSession(page);
    await stubCards(page, WORDS.concat([CONCEPT]));
    await boot(page);
    const r = await page.evaluate(async () => {
      await srsGetDue();
      await srsGetDueCount();
      const due = window.__sbCalls.filter(c => c.path.startsWith('flashcards?') && c.path.includes('next_review=lte'));
      const card = { id: 'c1', kind: 'concept', ladder_level: 0, ladder_streak: 0, interval: 1, ease_factor: 2.5 };
      const upd = ladderApply(card, 2, 0);
      srsLogReview(card, 2, 0, upd, 'review');
      await new Promise(r => setTimeout(r, 50));
      const log = window.__sbCalls.find(c => c.path === 'review_log');
      return { dueFilters: due.map(c => c.path.includes('status.neq.retired')), log: log && JSON.parse(log.body) };
    });
    expect(r.dueFilters.length).toBeGreaterThanOrEqual(3);
    expect(r.dueFilters.every(Boolean)).toBe(true);
    expect(r.log).toMatchObject({ card_id: 'c1', rating: 2, shown_rung: 0, level_before: 0, interval_before: 1, ease_before: 2.5, surface: 'review' });
    expect(r.log.interval_after).toBeGreaterThan(1);
  });

  test('the dealer reserves five words for a passage and never deals them singly', async ({ page }) => {
    await seedSession(page);
    await stubCards(page, WORDS.concat([CONCEPT]));
    await boot(page);
    const r = await page.evaluate(async () => {
      feedMode = 'flow'; passageReset();
      // First deal: the paragraph is still being written, so only the
      // leftovers go out; the five reserved words do not.
      const first = (await CARD_SOURCES['due-card'](10)).map(d => d._passage ? 'passage' : d.id);
      const reserved = [...passageReserved].sort();
      await passageBuilding;
      const second = (await CARD_SOURCES['due-card'](10)).map(d => d._passage ? 'passage' : d.id);
      const calls = (window.__claudeCalls || []).filter(p => p.startsWith('Write ONE short paragraph')).length;
      return { first, reserved, second, text: passagePool[0].text, calls };
    });
    expect(r.reserved).toEqual(['w0', 'w1', 'w2', 'w3', 'w4']);
    expect(r.first).toEqual(['w5', 'w6', 'c1']);
    expect(r.second).toEqual(['passage', 'w5', 'w6', 'c1']);
    expect(r.text).toContain('«meritorious»');
    expect(r.calls).toBe(1);
  });

  test('Flow mounts a passage and Done grades all five cards', async ({ page }) => {
    await seedSession(page);
    await stubCards(page, WORDS.slice(0, 5));   // nothing single left, so the deal waits for the paragraph
    await page.addInitScript(() => localStorage.setItem('break_flow_order', 'sequence'));
    await boot(page);
    await page.evaluate(() => openFlow());
    await page.waitForFunction(() => {
      const item = document.querySelector('.feed-item[data-slug="due-card"]');
      return !!(item && item._due && item._due._passage);
    }, null, { timeout: 10000 });
    const r = await page.evaluate(() => {
      const item = document.querySelector('.feed-item[data-slug="due-card"]');
      return { front: item.querySelector('.feed-body').innerHTML, back: item.querySelector('.feed-back-inner').innerHTML, seen: [...feedDueSeen] };
    });
    expect(r.front).toContain('<mark>meritorious</mark>');
    expect(r.front).toContain('5 words · tap to check');
    expect(r.back).toContain('data-passage-done="1"');
    expect((r.back.match(/data-pass-row=/g) || []).length).toBe(5);
    expect(r.seen.some(k => k.startsWith('due-card:p:'))).toBe(true);
    expect(r.seen).not.toContain('due-card:w0');
    // Flip, mark one missed, Done.
    await page.evaluate(() => document.querySelector('.feed-item[data-slug="due-card"]').classList.add('flipped'));
    await page.click('.feed-item[data-slug="due-card"] [data-pass-row="2"]');
    const budgetBefore = await page.evaluate(() => srsBudgetLeft());
    await page.click('.feed-item[data-slug="due-card"] [data-passage-done]');
    await page.waitForFunction(() => window.__sbCalls.filter(c => c.method === 'PATCH' && c.path.startsWith('flashcards?id=eq.')).length === 5);
    const after = await page.evaluate(() => {
      const patches = window.__sbCalls.filter(c => c.method === 'PATCH' && c.path.startsWith('flashcards?id=eq.')).map(c => ({ id: c.path.split('eq.')[1], ...JSON.parse(c.body) }));
      const logs = window.__sbCalls.filter(c => c.path === 'review_log').map(c => JSON.parse(c.body));
      return { patches, logs, budget: srsBudgetLeft(), done: flowDone.recall };
    });
    expect(budgetBefore - after.budget).toBe(5);
    expect(after.done).toBe(5);
    const missed = after.patches.find(p => p.id === 'w2');
    expect(missed.interval).toBe(1);
    expect(missed.ladder_level).toBe(0);
    const got = after.patches.find(p => p.id === 'w0');
    expect(got.ladder_level).toBe(1);
    expect(after.logs.length).toBe(5);
    expect(after.logs.every(l => l.surface === 'passage')).toBe(true);
  });

  test('Tidy sorts, proposes with reasons, retires the ticked, restores', async ({ page }) => {
    await seedSession(page);
    await stubCards(page, WORDS.concat([CONCEPT]));
    await boot(page);
    await page.evaluate(() => tidyOpen());
    await expect(page.locator('#tidy-body .tidy-stats').first()).toContainText('8 cards: 7 words, 0 facts, 1 concepts');
    await page.click('#tidy-propose');
    await expect(page.locator('#tidy-body .tidy-row')).toHaveCount(1);
    await expect(page.locator('#tidy-body .tidy-front')).toContainText('bifurcate');
    await expect(page.locator('#tidy-body .tidy-why')).toHaveText('archaic, unlikely to recur');
    const prompt = await page.evaluate(() => (window.__claudeCalls || []).find(p => p.startsWith('This is a personal flashcard deck')));
    expect(prompt).toContain('1 | Word | bifurcate => definition 1');
    await page.click('#tidy-apply');
    await page.waitForFunction(() => window.__sbCalls.some(c => c.method === 'PATCH' && c.path.includes('id=in.(w1)')));
    const patch = await page.evaluate(() => window.__sbCalls.find(c => c.method === 'PATCH' && c.path.includes('id=in.(w1)')));
    expect(JSON.parse(patch.body)).toEqual({ status: 'retired' });
    await expect(page.locator('#tidy-body [data-tidy-restore="w1"]')).toHaveCount(1);
    await page.click('#tidy-body [data-tidy-restore="w1"]');
    await page.waitForFunction(() => window.__sbCalls.some(c => c.method === 'PATCH' && c.path === 'flashcards?id=eq.w1' && c.body.includes('review')));
    await expect(page.locator('#tidy-body [data-tidy-restore]')).toHaveCount(0);
  });

  test('a new card is born with a kind', async ({ page }) => {
    await seedSession(page);
    await stubCards(page, []);
    await boot(page);
    const body = await page.evaluate(async () => {
      await srsCreate('ineluctable', 'unable to be avoided', 'manual');
      const c = window.__sbCalls.find(c => c.method === 'POST' && c.path === 'flashcards');
      return c && JSON.parse(c.body);
    });
    expect(body.kind).toBe('vocab');
  });
});
