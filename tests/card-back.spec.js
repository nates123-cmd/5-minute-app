// The back of a flashcard in the feed follows the Cards screen (Nate,
// 2026-10-26): the answer leads in bold, the prompt sits under it smaller.
// Jeopardy-style answers ('What does "histrionic" mean?') show as the term.
import { test, expect } from '@playwright/test';
import { boot, stubFetchEmpty } from './helper.js';

test.beforeEach(async ({ page }) => { await stubFetchEmpty(page); await boot(page); });

test('a question-shaped answer displays as just the term', async ({ page }) => {
  const r = await page.evaluate(() => [
    cardAnswerText('What does "histrionic" mean?'),
    cardAnswerText('What is a Divan?'),
    cardAnswerText('What does “anodyne” mean'),
    cardAnswerText('Appeal to Novelty'),
    cardAnswerText('What is the capital city of Kazakhstan, and why did it move from Almaty in 1997?'),
  ]);
  expect(r).toEqual(['Histrionic', 'Divan', 'Anodyne', 'Appeal to Novelty',
    'What is the capital city of Kazakhstan, and why did it move from Almaty in 1997?']);
});

test('feed back: the answer leads, the prompt follows smaller', async ({ page }) => {
  const html = await page.evaluate(() => CARD_SPECS['due-card'].renderBack({
    id: 'h', front: 'Overly theatrical, dramatic, or attention-seeking behavior.', back: 'What does "histrionic" mean?', _rung: 0,
  }));
  expect(html).toMatch(/<div class="due-q">Histrionic<\/div><div class="due-a">Overly theatrical/);
});

test('feed back on a harder rung leads with the front, the thing you produced', async ({ page }) => {
  const html = await page.evaluate(() => CARD_SPECS['due-card'].renderBack({
    id: 's', front: 'simian', back: 'adjective, relating to apes.', _rung: 1,
  }));
  expect(html).toMatch(/<div class="due-q">simian<\/div><div class="due-a">adjective, relating to apes\.<\/div>/);
});

test('a long answer steps down in size and weight', async ({ page }) => {
  const cls = await page.evaluate(() => [dueAnswerSize('short'), dueAnswerSize('x'.repeat(100)), dueAnswerSize('x'.repeat(200))]);
  expect(cls).toEqual(['', ' due-q-mid', ' due-q-long']);
});

test('the Cards screen back shows the term, not the question', async ({ page }) => {
  await page.evaluate(() => {
    srsMode = 'flip';
    srsQueue = [{ id: 'h', front: 'Overly theatrical.', back: 'What does "histrionic" mean?', interval: 1, ease_factor: 2.5 }];
    srsCurrent = 0; showScreen('srs-review'); return renderSrsCard();
  });
  await expect(page.locator('.srs-card-back .srs-card-text')).toHaveText('Histrionic');
});
