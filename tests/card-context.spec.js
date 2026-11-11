// Card context (Nate, 2026-11-11): once a flashcard's answer is showing, a
// quiet row offers ways to more: Go deeper, Ask Claude, Google it, and for a
// vocab word, "Use it in a sentence" (three sentences, written once, cached).
import { test, expect } from '@playwright/test';
import { boot, seedSession } from './helper.js';

// Counts Claude proxy calls and answers them with three sentences.
function stubClaude(page) {
  return page.addInitScript(() => {
    window.__claude = 0;
    window.__opened = [];
    window.open = (u) => { window.__opened.push(String(u)); return null; };
    window.fetch = async (url) => {
      const u = String(url);
      const json = v => new Response(JSON.stringify(v), { status: 200, headers: { 'Content-Type': 'application/json', 'Content-Range': '0-0/0' } });
      if (u.includes('/functions/v1/claude')) {
        window.__claude++;
        return json({ text: JSON.stringify({ sentences: [
          'The *histrionic* toast ran nine minutes.', 'Her *histrionic* sigh fooled nobody.', 'A *histrionic* exit, cape and all.' ] }) });
      }
      return json([]);
    };
  });
}

test.beforeEach(async ({ page }) => { await seedSession(page); await stubClaude(page); await boot(page); });

test('the word is found on whichever side it was saved', async ({ page }) => {
  const r = await page.evaluate(() => [
    cardVocabWord({ id: 1, kind: 'vocab', front: 'simian', back: 'adjective, relating to apes.' }),
    cardVocabWord({ id: 2, kind: 'vocab', front: 'Overly theatrical behavior.', back: 'What does "histrionic" mean?' }),
    cardVocabWord({ id: 3, kind: 'vocab', front: 'What does "anodyne" mean?', back: 'Inoffensive, bland.' }),
    cardVocabWord({ id: 4, kind: 'fact', front: 'Medium-rare steak', back: '130 F' }),
    cardVocabWord({ id: 5, kind: 'concept', front: 'Why did the capital of Kazakhstan move?', back: 'Long answer here.' }),
  ]);
  expect(r).toEqual(['simian', 'Histrionic', 'Anodyne', '', '']);
});

test('Flow back: a word gets the sentence action, a fact does not; both get the ways out', async ({ page }) => {
  const r = await page.evaluate(() => ({
    word: CARD_SPECS['due-card'].renderBack({ id: 's', kind: 'vocab', front: 'simian', back: 'relating to apes.', _rung: 0 }),
    fact: CARD_SPECS['due-card'].renderBack({ id: 'f', kind: 'fact', front: 'Medium-rare steak', back: '130 F', _rung: 0 }),
  }));
  expect(r.word).toContain('data-card-ctx="sentence"');
  expect(r.fact).not.toContain('data-card-ctx="sentence"');
  for (const html of [r.word, r.fact]) {
    expect(html).toContain('data-feed-deeper="1"');
    expect(html).toContain('data-card-ctx="claude"');
    expect(html).toContain('data-card-ctx="google"');
  }
});

test('Cards screen: context appears with the answer; sentences are written once and cycle', async ({ page }) => {
  await page.evaluate(() => {
    srsMode = 'flip';
    srsQueue = [{ id: 'h', kind: 'vocab', front: 'Overly theatrical.', back: 'What does "histrionic" mean?', interval: 1, ease_factor: 2.5 }];
    srsCurrent = 0; showScreen('srs-review'); return renderSrsCard();
  });
  await expect(page.locator('#srs-ctx')).toBeHidden();
  await page.locator('#srs-flip-wrap').click();
  await expect(page.locator('#srs-ctx')).toBeVisible();
  const btn = page.locator('#srs-ctx [data-card-ctx="sentence"]');
  await btn.click();
  const sent = page.locator('#srs-ctx [data-card-sent]');
  await expect(sent).toHaveText('The histrionic toast ran nine minutes.');
  await expect(sent.locator('strong')).toHaveText('histrionic');
  await expect(btn).toHaveText('Another sentence');
  await btn.click();
  await expect(sent).toHaveText('Her histrionic sigh fooled nobody.');
  expect(await page.evaluate(() => window.__claude)).toBe(1);
  // Using the context row never grades the card.
  expect(await page.evaluate(() => srsCurrent)).toBe(0);
});

test('Ask Claude and Google it open seeded with the word', async ({ page }) => {
  await page.evaluate(() => {
    srsMode = 'flip';
    srsQueue = [{ id: 's', kind: 'vocab', front: 'simian', back: 'relating to apes.', interval: 1, ease_factor: 2.5 }];
    srsCurrent = 0; showScreen('srs-review'); return renderSrsCard();
  });
  await page.locator('#srs-flip-wrap').click();
  await page.locator('#srs-ctx [data-card-ctx="claude"]').click();
  await page.locator('#srs-ctx [data-card-ctx="google"]').click();
  const opened = await page.evaluate(() => window.__opened);
  expect(opened[0]).toMatch(/^https:\/\/claude\.ai\/new\?q=.*simian.*relating%20to%20apes/);
  expect(opened[1]).toBe('https://www.google.com/search?q=define%20simian');
});
