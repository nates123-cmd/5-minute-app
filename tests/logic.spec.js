// Pure-logic tests. Every assertion calls the REAL global function from
// index.html via page.evaluate — no re-implementation, so a regression in the
// shipped code fails the test.
import { test, expect } from '@playwright/test';
import { boot } from './helper.js';

test.beforeEach(async ({ page }) => { await boot(page); });

// ── esc (XSS escaping) ──────────────────────────────────────────────────────
test.describe('esc (XSS escaping)', () => {
  test('escapes the dangerous five', async ({ page }) => {
    const out = await page.evaluate(() => esc('<img src=x onerror="alert(1)">&\'"'));
    expect(out).toBe('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;&#39;&quot;');
    expect(out).not.toContain('<');
    expect(out).not.toContain('>');
  });
  test('ampersand escaped first (no double-escape of entities)', async ({ page }) => {
    expect(await page.evaluate(() => esc('&lt;'))).toBe('&amp;lt;');
  });
  test('numbers and other scalars are stringified', async ({ page }) => {
    expect(await page.evaluate(() => esc(42))).toBe('42');
  });
});

// ── localDateStr (local-time YYYY-MM-DD, no UTC drift) ───────────────────────
test.describe('localDateStr', () => {
  test('zero-pads month and day (local-time constructor)', async ({ page }) => {
    const out = await page.evaluate(() => localDateStr(new Date(2026, 0, 5))); // Jan 5
    expect(out).toBe('2026-01-05');
  });
  test('handles double-digit month/day', async ({ page }) => {
    const out = await page.evaluate(() => localDateStr(new Date(2026, 11, 25))); // Dec 25
    expect(out).toBe('2026-12-25');
  });
  test('default arg = now, matches YYYY-MM-DD and equals localDateStr(new Date())', async ({ page }) => {
    const { t, same } = await page.evaluate(() => ({
      t: localDateStr(), same: localDateStr() === localDateStr(new Date()),
    }));
    expect(t).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(same).toBe(true);
  });
});

// ── sm2 (SM-2 spaced repetition) ─────────────────────────────────────────────
test.describe('sm2 scheduling math', () => {
  const card = (interval, ease) => ({ interval, ease_factor: ease });

  test('miss (rating 0) resets interval to 1, ease unchanged', async ({ page }) => {
    const r = await page.evaluate((c) => sm2(c, 0), card(40, 2.3));
    expect(r.interval).toBe(1);
    expect(r.ease_factor).toBe(2.3); // miss does not touch ease
    expect(r.status).toBe('review');
  });

  test('hard (rating 1): interval x1.2 rounded, ease -0.15', async ({ page }) => {
    const r = await page.evaluate((c) => sm2(c, 1), card(10, 2.0));
    expect(r.interval).toBe(12);            // round(10 * 1.2)
    expect(r.ease_factor).toBeCloseTo(1.85, 5);
  });

  test('hard interval floored at 1 (never 0)', async ({ page }) => {
    const r = await page.evaluate((c) => sm2(c, 1), card(1, 2.0));
    expect(r.interval).toBe(1);             // max(1, round(1 * 1.2)=1)
  });

  test('hard ease floored at 1.3', async ({ page }) => {
    const r = await page.evaluate((c) => sm2(c, 1), card(5, 1.35));
    expect(r.ease_factor).toBe(1.3);        // max(1.3, 1.35-0.15)
  });

  test('easy (rating 2): interval x ease rounded, ease +0.1', async ({ page }) => {
    const r = await page.evaluate((c) => sm2(c, 2), card(10, 2.0));
    expect(r.interval).toBe(20);            // round(10 * 2.0)
    expect(r.ease_factor).toBeCloseTo(2.1, 5);
  });

  test('easy ease capped at 2.5', async ({ page }) => {
    const r = await page.evaluate((c) => sm2(c, 2), card(4, 2.45));
    expect(r.ease_factor).toBe(2.5);        // min(2.5, 2.45+0.1)
  });

  test('next_review = today + interval, formatted via localDateStr', async ({ page }) => {
    const r = await page.evaluate(() => {
      const out = sm2({ interval: 4, ease_factor: 2.0 }, 0); // miss -> interval 1
      const exp = new Date(); exp.setDate(exp.getDate() + 1);
      return { next: out.next_review, expected: localDateStr(exp), interval: out.interval };
    });
    expect(r.interval).toBe(1);
    expect(r.next).toBe(r.expected);
    expect(r.next).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ── regKey (quiz-slug namespacing) ───────────────────────────────────────────
test.describe('regKey', () => {
  test('non-quiz entry key = slug', async ({ page }) => {
    expect(await page.evaluate(() => regKey({ slug: 'history' }))).toBe('history');
  });
  test('quiz entry key = "quiz-" + slug', async ({ page }) => {
    expect(await page.evaluate(() => regKey({ slug: 'history', quiz: true }))).toBe('quiz-history');
  });
  test('disambiguates the history activity from the history quiz', async ({ page }) => {
    const r = await page.evaluate(() => ({
      act: regKey({ slug: 'history' }),
      quiz: regKey({ slug: 'history', quiz: true }),
    }));
    expect(r.act).not.toBe(r.quiz);
  });
});

// ── ACTIVITY_REGISTRY + DURATION_ACTIVITIES integrity ────────────────────────
test.describe('registry integrity', () => {
  test('every regKey is unique (no slug collisions survive namespacing)', async ({ page }) => {
    const r = await page.evaluate(() => {
      const keys = ACTIVITY_REGISTRY.map(regKey);
      return { total: keys.length, unique: new Set(keys).size };
    });
    expect(r.unique).toBe(r.total);
  });

  test('history & cooking appear as BOTH an activity and a quiz (collision is intentional)', async ({ page }) => {
    const r = await page.evaluate(() => {
      const slugs = ACTIVITY_REGISTRY.map((a) => a.slug);
      const count = (s) => slugs.filter((x) => x === s).length;
      return { history: count('history'), cooking: count('cooking') };
    });
    expect(r.history).toBe(2);
    expect(r.cooking).toBe(2);
  });

  test('every registry entry has slug, name, desc', async ({ page }) => {
    const bad = await page.evaluate(() =>
      ACTIVITY_REGISTRY.filter((a) => !a.slug || !a.name || !a.desc).map((a) => a.slug || '?'));
    expect(bad).toEqual([]);
  });

  test('every DURATION_ACTIVITIES slug resolves to a real registry entry (via regKey)', async ({ page }) => {
    // Buckets reference plain slugs for activities and "quiz-<slug>" for quizzes.
    // Each must map to some entry's regKey, or that bucket renders a dead row.
    const orphans = await page.evaluate(() => {
      const keys = new Set(ACTIVITY_REGISTRY.map(regKey));
      const out = {};
      for (const [bucket, list] of Object.entries(DURATION_ACTIVITIES)) {
        const missing = list.filter((s) => !keys.has(s));
        if (missing.length) out[bucket] = missing;
      }
      return out;
    });
    expect(orphans).toEqual({});
  });

  test('DURATION_ACTIVITIES has no duplicate slugs within a bucket', async ({ page }) => {
    const dupes = await page.evaluate(() => {
      const out = {};
      for (const [bucket, list] of Object.entries(DURATION_ACTIVITIES)) {
        if (new Set(list).size !== list.length) {
          out[bucket] = list.filter((s, i) => list.indexOf(s) !== i);
        }
      }
      return out;
    });
    expect(dupes).toEqual({});
  });
});
