// Activity-grid + hide/show toggle filtering. Drives the REAL renderActivityGrid
// / getHiddenActivities / setHiddenActivities against the live DOM. We observe
// rendered cards + localStorage; we never re-implement the filter.
import { test, expect } from '@playwright/test';
import { boot } from './helper.js';
import { HIDDEN_KEY } from './constants.js';

test.beforeEach(async ({ page }) => {
  await boot(page);
  await page.evaluate((k) => localStorage.removeItem(k), HIDDEN_KEY);
});

test('renders one card per registry entry when nothing is hidden', async ({ page }) => {
  const r = await page.evaluate(() => {
    setHiddenActivities(new Set());
    renderActivityGrid();
    return {
      cards: document.querySelectorAll('#activity-grid .activity-card').length,
      registry: ACTIVITY_REGISTRY.length,
    };
  });
  expect(r.cards).toBe(r.registry);
});

test('activity cards carry data-activity, quiz cards carry data-quiz', async ({ page }) => {
  const r = await page.evaluate(() => {
    renderActivityGrid();
    return {
      activities: document.querySelectorAll('#activity-grid [data-activity]').length,
      quizzes: document.querySelectorAll('#activity-grid [data-quiz]').length,
      quizInRegistry: ACTIVITY_REGISTRY.filter((a) => a.quiz).length,
    };
  });
  expect(r.quizzes).toBe(r.quizInRegistry);
  expect(r.activities).toBe(r.activities); // sanity (non-zero checked below)
  expect(r.activities).toBeGreaterThan(0);
});

test('hiding an activity removes exactly that card', async ({ page }) => {
  const r = await page.evaluate(() => {
    setHiddenActivities(new Set(['fun-fact']));
    renderActivityGrid();
    const slugs = [...document.querySelectorAll('#activity-grid [data-activity]')]
      .map((el) => el.dataset.activity);
    return { count: document.querySelectorAll('#activity-grid .activity-card').length,
             total: ACTIVITY_REGISTRY.length, hasFunFact: slugs.includes('fun-fact') };
  });
  expect(r.hasFunFact).toBe(false);
  expect(r.count).toBe(r.total - 1);
});

test('hiding the History QUIZ does NOT hide the History activity (regKey discipline)', async ({ page }) => {
  // This is the collision the regKey namespace exists to prevent.
  const r = await page.evaluate(() => {
    setHiddenActivities(new Set(['quiz-history'])); // hide only the quiz
    renderActivityGrid();
    return {
      historyActivity: document.querySelectorAll('#activity-grid [data-activity="history"]').length,
      historyQuiz: document.querySelectorAll('#activity-grid [data-quiz="history"]').length,
    };
  });
  expect(r.historyActivity).toBe(1); // activity still shown
  expect(r.historyQuiz).toBe(0);     // quiz hidden
});

test('getHiddenActivities returns empty Set on corrupt storage (no throw)', async ({ page }) => {
  const r = await page.evaluate((k) => {
    localStorage.setItem(k, 'not json{{');
    const s = getHiddenActivities();
    return { isSet: s instanceof Set, size: s.size };
  }, HIDDEN_KEY);
  expect(r.isSet).toBe(true);
  expect(r.size).toBe(0);
});

test('setHiddenActivities round-trips through localStorage as a regKey array', async ({ page }) => {
  const r = await page.evaluate((k) => {
    setHiddenActivities(new Set(['quiz-cooking', 'stoic']));
    const raw = JSON.parse(localStorage.getItem(k));
    const back = [...getHiddenActivities()].sort();
    return { raw: raw.sort(), back };
  }, HIDDEN_KEY);
  expect(r.raw).toEqual(['quiz-cooking', 'stoic']);
  expect(r.back).toEqual(['quiz-cooking', 'stoic']);
});

test('re-rendering after hide/unhide is idempotent (no duplicate wiring/cards)', async ({ page }) => {
  const r = await page.evaluate(() => {
    setHiddenActivities(new Set(['fun-fact']));
    renderActivityGrid();
    renderActivityGrid(); // run twice
    setHiddenActivities(new Set());
    renderActivityGrid();
    return { count: document.querySelectorAll('#activity-grid .activity-card').length,
             total: ACTIVITY_REGISTRY.length };
  });
  expect(r.count).toBe(r.total);
});
