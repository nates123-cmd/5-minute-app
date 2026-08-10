// Mastery-ladder tests. Same rule as logic.spec.js: every assertion calls the
// REAL global from index.html via page.evaluate, so a regression in the shipped
// code fails here rather than in a copy of it.
//
// The ladder decides HOW a card is asked (rung 0 Recognize → 4 Produce); sm2()
// still decides WHEN. These tests cover the transition table, the degradation
// ladder, and the cache fingerprint — all pure, no network, no session.
import { test, expect } from '@playwright/test';
import { boot } from './helper.js';

test.beforeEach(async ({ page }) => { await boot(page); });

// ── ladderNext (promotion / demotion) ───────────────────────────────────────
test.describe('ladderNext transitions', () => {
  const next = (page, level, streak, rating, shown) =>
    page.evaluate(([l, s, r, sh]) => ladderNext({ ladder_level: l, ladder_streak: s }, r, sh),
      [level, streak, rating, shown]);

  test('easy at streak 0 banks a streak, does not promote', async ({ page }) => {
    expect(await next(page, 0, 0, 2)).toEqual({ ladder_level: 0, ladder_streak: 1 });
  });

  test('second consecutive easy promotes and resets the streak', async ({ page }) => {
    expect(await next(page, 0, 1, 2)).toEqual({ ladder_level: 1, ladder_streak: 0 });
    expect(await next(page, 2, 1, 2)).toEqual({ ladder_level: 3, ladder_streak: 0 });
  });

  test('hard holds the rung and clears the streak', async ({ page }) => {
    expect(await next(page, 3, 1, 1)).toEqual({ ladder_level: 3, ladder_streak: 0 });
  });

  test('miss drops one rung and clears the streak', async ({ page }) => {
    expect(await next(page, 3, 1, 0)).toEqual({ ladder_level: 2, ladder_streak: 0 });
    expect(await next(page, 4, 0, 0)).toEqual({ ladder_level: 3, ladder_streak: 0 });
  });

  test('demotion floors at rung 0', async ({ page }) => {
    expect(await next(page, 0, 1, 0)).toEqual({ ladder_level: 0, ladder_streak: 0 });
  });

  test('promotion ceilings at rung 4, streak caps instead of overflowing', async ({ page }) => {
    expect(await next(page, 4, 1, 2)).toEqual({ ladder_level: 4, ladder_streak: 2 });
    expect(await next(page, 4, 2, 2)).toEqual({ ladder_level: 4, ladder_streak: 2 });
  });

  // This is what keeps the scroll feed's rung-2 cap honest: an Easy at a
  // framing easier than the card's rung must not buy a promotion.
  test('easy at a rung below the stored level earns nothing', async ({ page }) => {
    expect(await next(page, 3, 1, 2, 2)).toEqual({ ladder_level: 3, ladder_streak: 1 });
    expect(await next(page, 4, 1, 2, 2)).toEqual({ ladder_level: 4, ladder_streak: 1 });
  });

  test('easy AT the stored level still counts', async ({ page }) => {
    expect(await next(page, 2, 1, 2, 2)).toEqual({ ladder_level: 3, ladder_streak: 0 });
  });

  test('a miss at a capped framing still demotes', async ({ page }) => {
    expect(await next(page, 4, 0, 0, 2)).toEqual({ ladder_level: 3, ladder_streak: 0 });
  });

  test('missing/garbage level and streak read as 0', async ({ page }) => {
    const r = await page.evaluate(() => ladderNext({}, 2));
    expect(r).toEqual({ ladder_level: 0, ladder_streak: 1 });
    expect(await page.evaluate(() => ladderLevel({ ladder_level: 'x' }))).toBe(0);
    expect(await page.evaluate(() => ladderLevel({ ladder_level: 99 }))).toBe(4);
    expect(await page.evaluate(() => ladderStreak({ ladder_streak: -3 }))).toBe(0);
  });
});

// ── ladderApply (ladder + sm2 + mastery multiplier) ─────────────────────────
test.describe('ladderApply', () => {
  const apply = (page, card, rating, shown) =>
    page.evaluate(([c, r, s]) => ladderApply(c, r, s), [card, rating, shown]);

  test('leaves sm2 alone below the top rung', async ({ page }) => {
    const r = await apply(page, { interval: 10, ease_factor: 2.5, ladder_level: 0, ladder_streak: 0 }, 2, 0);
    expect(r.interval).toBe(25);              // 10 * 2.5, no multiplier
    expect(r.ladder_level).toBe(0);
    expect(r.ladder_streak).toBe(1);
  });

  test('applies the mastery multiplier on the easy that reaches rung 4', async ({ page }) => {
    const r = await apply(page, { interval: 10, ease_factor: 2.5, ladder_level: 3, ladder_streak: 1 }, 2, 3);
    expect(r.ladder_level).toBe(4);
    expect(r.interval).toBe(33);              // round(round(10 * 2.5) * 1.3)
    expect(r.mastered_at).toBeTruthy();
  });

  test('mastered_at is a high-water mark, not re-stamped', async ({ page }) => {
    const r = await apply(page,
      { interval: 10, ease_factor: 2.5, ladder_level: 4, ladder_streak: 0, mastered_at: '2020-01-01T00:00:00Z' }, 2, 4);
    expect(r.mastered_at).toBeUndefined();    // already set, not overwritten
  });

  test('clamps the interval so the multiplier cannot retire a card', async ({ page }) => {
    const r = await apply(page, { interval: 400, ease_factor: 2.5, ladder_level: 4, ladder_streak: 0 }, 2, 4);
    expect(r.interval).toBe(365);
  });

  test('next_review is recomputed from the clamped interval', async ({ page }) => {
    const { review, expected } = await page.evaluate(() => {
      const r = ladderApply({ interval: 400, ease_factor: 2.5, ladder_level: 4, ladder_streak: 0 }, 2, 4);
      const d = new Date(); d.setDate(d.getDate() + 365);
      return { review: r.next_review, expected: localDateStr(d) };
    });
    expect(review).toBe(expected);            // not the unclamped 1300-day date
  });

  test('a miss stamps last_missed_at for cluster ripeness', async ({ page }) => {
    const r = await apply(page, { interval: 40, ease_factor: 2.3, ladder_level: 2, ladder_streak: 1 }, 0, 2);
    expect(r.interval).toBe(1);
    expect(r.ladder_level).toBe(1);
    expect(r.last_missed_at).toBeTruthy();
  });

  test('a non-miss does not stamp last_missed_at', async ({ page }) => {
    const r = await apply(page, { interval: 10, ease_factor: 2.5, ladder_level: 1, ladder_streak: 0 }, 1, 1);
    expect(r.last_missed_at).toBeUndefined();
  });
});

// ── ladderRung (degradation) ────────────────────────────────────────────────
test.describe('ladderRung degradation', () => {
  // Build a card with a pack whose fingerprint actually matches its text.
  const packed = (level, parts) => ({ level, parts });

  const rung = (page, level, parts, cap) => page.evaluate(([l, p, c]) => {
    const card = { front: 'tendentious', back: 'expressing a strong opinion', ladder_level: l };
    if (p) {
      const src = ladderFingerprint(card.front, card.back);
      card.variants = Object.assign({ v: 1, src }, p);
      card.variants_src = src;
    }
    return ladderRung(card, c);
  }, [level, parts, cap]);

  const FULL = {
    reworded: { kind: 'cloze', prompt: 'His ____ history reads like a brief.' },
    discriminate: { stem: 'Which is right?', options: [
      { text: 'a', correct: true }, { text: 'b', correct: false }, { text: 'c', correct: false }] },
    produce: { prompt: 'Use it in a sentence.', criteria: [] },
  };

  test('no pack: anything above Reversed falls to Reversed', async ({ page }) => {
    expect(await rung(page, 3, null)).toBe(1);
    expect(await rung(page, 2, null)).toBe(1);
  });

  test('no back either: falls all the way to Recognize', async ({ page }) => {
    const r = await page.evaluate(() => ladderRung({ front: 'a', back: '', ladder_level: 3 }));
    expect(r).toBe(0);
  });

  test('rung 0 and 1 need nothing generated', async ({ page }) => {
    expect(await rung(page, 0, null)).toBe(0);
    expect(await rung(page, 1, null)).toBe(1);
  });

  test('a pack with only reworded supports rung 2 but not 3', async ({ page }) => {
    expect(await rung(page, 2, { reworded: FULL.reworded })).toBe(2);
    expect(await rung(page, 3, { reworded: FULL.reworded })).toBe(2);
  });

  test('discriminate with no correct option is rejected, falls to 2', async ({ page }) => {
    const bad = { reworded: FULL.reworded, discriminate: { stem: 's', options: [
      { text: 'a', correct: false }, { text: 'b', correct: false }, { text: 'c', correct: false }] } };
    expect(await rung(page, 3, bad)).toBe(2);
  });

  test('discriminate with too few options is rejected, falls to 2', async ({ page }) => {
    const bad = { reworded: FULL.reworded, discriminate: { stem: 's', options: [
      { text: 'a', correct: true }, { text: 'b', correct: false }] } };
    expect(await rung(page, 3, bad)).toBe(2);
  });

  test('a full pack supports rung 3', async ({ page }) => {
    expect(await rung(page, 3, FULL)).toBe(3);
  });

  // Rung 4 additionally needs a live session; boot() has none, so it must
  // degrade to 3 rather than rendering a Produce surface that cannot grade.
  test('rung 4 signed out degrades to 3', async ({ page }) => {
    expect(await rung(page, 4, FULL)).toBe(3);
  });

  test('the cap ceiling applies before any degradation', async ({ page }) => {
    expect(await rung(page, 4, FULL, 2)).toBe(2);   // FEED_LADDER_CAP
    expect(await rung(page, 3, FULL, 2)).toBe(2);
    expect(await rung(page, 1, FULL, 2)).toBe(1);
  });

  test('a capped card with no pack still degrades to Reversed, never errors', async ({ page }) => {
    expect(await rung(page, 4, null, 2)).toBe(1);
  });
});

// ── ladderPack (cache validity) ─────────────────────────────────────────────
test.describe('ladderPack cache validity', () => {
  test('an edit to the front invalidates the pack via the fingerprint', async ({ page }) => {
    const { before, after } = await page.evaluate(() => {
      const card = { front: 'tendentious', back: 'a strong slant', ladder_level: 2 };
      const src = ladderFingerprint(card.front, card.back);
      card.variants = { v: 1, src, reworded: { kind: 'cloze', prompt: 'p' } };
      card.variants_src = src;
      const before = ladderRung(card);
      card.front = 'something else';           // as if edited elsewhere
      return { before, after: ladderRung(card) };
    });
    expect(before).toBe(2);
    expect(after).toBe(1);   // pack no longer matches the text, rung degrades
  });

  test('a pack from an older schema version is ignored', async ({ page }) => {
    const p = await page.evaluate(() => {
      const card = { front: 'a', back: 'b' };
      const src = ladderFingerprint('a', 'b');
      card.variants = { v: 0, src, reworded: { prompt: 'p' } };
      card.variants_src = src;
      return ladderPack(card);
    });
    expect(p).toBeNull();
  });

  test('null / absent variants is null, not a crash', async ({ page }) => {
    expect(await page.evaluate(() => ladderPack({ front: 'a', back: 'b' }))).toBeNull();
    expect(await page.evaluate(() => ladderPack(null))).toBeNull();
  });

  test('a JSON-string pack (localStorage round-trip) still parses', async ({ page }) => {
    const kind = await page.evaluate(() => {
      const card = { front: 'a', back: 'b' };
      const src = ladderFingerprint('a', 'b');
      card.variants = JSON.stringify({ v: 1, src, reworded: { kind: 'cloze', prompt: 'p' } });
      card.variants_src = src;
      const p = ladderPack(card);
      return p && p.reworded.kind;
    });
    expect(kind).toBe('cloze');
  });

  test('fingerprint is stable and order-sensitive', async ({ page }) => {
    const { same, differs } = await page.evaluate(() => ({
      same: ladderFingerprint('a', 'b') === ladderFingerprint('a', 'b'),
      differs: ladderFingerprint('a', 'b') !== ladderFingerprint('b', 'a'),
    }));
    expect(same).toBe(true);
    expect(differs).toBe(true);
  });
});

// ── ladderNormalizePack (validator) ─────────────────────────────────────────
test.describe('ladderNormalizePack validation', () => {
  const norm = (page, raw) => page.evaluate((r) =>
    ladderNormalizePack(r, { front: 'tendentious', back: 'a strong slant' }), raw);

  test('drops a reworded prompt that leaks the answer', async ({ page }) => {
    const p = await norm(page, { reworded: { kind: 'paraphrase', prompt: 'What means a strong slant?' } });
    expect(p).toBeNull();   // nothing else valid, so the whole pack is null
  });

  test('keeps a reworded prompt that does not leak', async ({ page }) => {
    const p = await norm(page, { reworded: { kind: 'cloze', prompt: 'His ____ account of it.' } });
    expect(p.reworded.prompt).toBe('His ____ account of it.');
    expect(p.reworded.kind).toBe('cloze');
  });

  test('an unknown kind falls back to paraphrase', async ({ page }) => {
    const p = await norm(page, { reworded: { kind: 'nonsense', prompt: 'Say what it means.' } });
    expect(p.reworded.kind).toBe('paraphrase');
  });

  test('drops discriminate with two correct options', async ({ page }) => {
    const p = await norm(page, {
      reworded: { prompt: 'x' },
      discriminate: { stem: 's', options: [
        { text: 'a', correct: true }, { text: 'b', correct: true }, { text: 'c', correct: false }] },
    });
    expect(p.discriminate).toBeUndefined();
    expect(p.reworded).toBeTruthy();   // the good half survives
  });

  test('drops a distractor equal to the back, which would make two right answers', async ({ page }) => {
    const p = await norm(page, { mc_distractors: ['A Strong Slant', 'wrong two', 'wrong three'] });
    expect(p).toBeNull();   // only 2 usable distractors, so no mc block, so no pack
  });

  test('keeps three genuinely distinct distractors', async ({ page }) => {
    const p = await norm(page, { mc_distractors: ['one', 'two', 'three', 'four'] });
    expect(p.mc.distractors).toEqual(['one', 'two', 'three']);   // capped at 3
  });

  test('stamps the current schema version and a matching fingerprint', async ({ page }) => {
    const ok = await page.evaluate(() => {
      const card = { front: 'tendentious', back: 'a strong slant' };
      const p = ladderNormalizePack({ produce: { prompt: 'Use it.' } }, card);
      return p.v === 1 && p.src === ladderFingerprint(card.front, card.back);
    });
    expect(ok).toBe(true);
  });

  test('garbage in is null out, never a throw', async ({ page }) => {
    expect(await norm(page, null)).toBeNull();
    expect(await norm(page, 'not an object')).toBeNull();
    expect(await norm(page, {})).toBeNull();
  });

  test('caps produce criteria at four', async ({ page }) => {
    const p = await norm(page, { produce: { prompt: 'Use it.', criteria: ['a','b','c','d','e','f'] } });
    expect(p.produce.criteria).toHaveLength(4);
  });
});
