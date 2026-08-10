// Mastery-ladder rendering. Drives the REAL renderSrsCard / srsRenderRung
// against the live DOM with a hand-built queue, so every rung is exercised
// without waiting days for an SM-2 interval or spending a model call.
//
// No session and a stubbed fetch throughout: rung 4 needs a live session, so
// these also prove the offline/signed-out degradation actually degrades
// instead of erroring.
import { test, expect } from '@playwright/test';
import { boot, stubFetchEmpty } from './helper.js';

const FRONT = 'tendentious';
const BACK = 'expressing a strong opinion, especially a controversial one';

// Seed one card at `level` with a full, fingerprint-matching pack, put the
// review screen up, and render it. Returns nothing — assert against the DOM.
async function showCardAt(page, level, opts = {}) {
  await page.evaluate(([lvl, front, back, mode, withPack]) => {
    const card = {
      id: 'test-card', front, back,
      interval: 1, ease_factor: 2.5, ladder_level: lvl, ladder_streak: 0,
    };
    if (withPack) {
      const src = ladderFingerprint(front, back);
      card.variants = {
        v: 1, src,
        reworded: { kind: 'cloze', prompt: 'His ____ history of the war reads like a brief.' },
        discriminate: {
          stem: 'Which sentence uses it correctly?',
          options: [
            { text: 'A tendentious account of the strike.', correct: true },
            { text: 'A tendentious hallway, poorly lit.', correct: false },
            { text: 'She felt tendentious after the flu.', correct: false },
            { text: 'The tendentious ran for three hours.', correct: false },
          ],
          why: 'It describes an argument, not a place, a mood, or an event.',
        },
        produce: { prompt: 'Use it in a sentence about a news story.', criteria: ['names a slant'] },
        mc: { distractors: ['careless with facts', 'unusually long-winded', 'written in haste'] },
      };
      card.variants_src = src;
    }
    srsMode = mode;
    srsQueue = [card]; srsCurrent = 0;
    srsStats = { easy: 0, hard: 0, miss: 0, promoted: 0, mastered: 0 };
    showScreen('srs-review');
    return renderSrsCard();
  }, [level, FRONT, BACK, opts.mode || 'ladder', opts.withPack !== false]);
}

test.beforeEach(async ({ page }) => {
  await stubFetchEmpty(page);
  await boot(page);
});

test('rung 0 shows the front and the original hint', async ({ page }) => {
  await showCardAt(page, 0);
  await expect(page.locator('#srs-flip-card .srs-card-face').first()).toContainText(FRONT);
  await expect(page.locator('#srs-flip-card .srs-card-face').first()).toContainText('Tap to reveal');
  await expect(page.locator('#srs-rung')).toContainText('Recognize');
});

test('rung 1 reverses the faces: the definition is the prompt', async ({ page }) => {
  await showCardAt(page, 1);
  const front = page.locator('#srs-flip-card .srs-card-face').first();
  await expect(front).toContainText(BACK);
  await expect(front).not.toContainText(FRONT);
  await expect(front).toContainText('Name it, then tap to check');
  await expect(page.locator('#srs-rung')).toContainText('Reversed');
});

test('rung 2 shows the cloze prompt, and the reveal carries BOTH sides', async ({ page }) => {
  await showCardAt(page, 2);
  const faces = page.locator('#srs-flip-card .srs-card-face');
  await expect(faces.first()).toContainText('His ____ history of the war');
  await expect(faces.first()).toContainText('Fill the blank, then tap');
  // Both sides on the back, so a cloze answer and a paraphrase answer are
  // never ambiguous about what was being asked for.
  await expect(faces.nth(1)).toContainText(FRONT);
  await expect(faces.nth(1)).toContainText(BACK);
  await expect(page.locator('#srs-rung')).toContainText('Reworded');
});

test('rung 3 renders four options and no flip surface', async ({ page }) => {
  await showCardAt(page, 3);
  await expect(page.locator('.srs-mc-btn')).toHaveCount(4);
  await expect(page.locator('#srs-flip-card')).toHaveCount(0);
  await expect(page.locator('#srs-rung')).toContainText('Discriminate');
  // Rate buttons only appear after an answer.
  await expect(page.locator('[data-rate]')).toHaveCount(0);
});

test('rung 3 grades by index, reveals the right option and suggests a rating', async ({ page }) => {
  await showCardAt(page, 3);
  await page.getByRole('button', { name: 'A tendentious account of the strike.' }).click();
  await expect(page.locator('.srs-mc-correct')).toHaveCount(1);
  await expect(page.locator('#srs-disc-why')).toContainText('It describes an argument');
  // Correct pick pre-selects Easy, not Miss.
  await expect(page.locator('.srs-btn-easy')).toHaveClass(/srs-rate-suggest/);
  await expect(page.locator('.srs-btn-miss')).not.toHaveClass(/srs-rate-suggest/);
});

test('a wrong pick still reveals the correct option and suggests Miss', async ({ page }) => {
  await showCardAt(page, 3);
  await page.getByRole('button', { name: 'A tendentious hallway, poorly lit.' }).click();
  await expect(page.locator('.srs-mc-wrong')).toHaveCount(1);
  await expect(page.locator('.srs-mc-reveal')).toHaveCount(1);
  await expect(page.locator('.srs-btn-miss')).toHaveClass(/srs-rate-suggest/);
});

// Rung 4 needs hasSession(), which these tests deliberately lack.
test('rung 4 signed out degrades to Discriminate, but still reads Mastered', async ({ page }) => {
  await showCardAt(page, 4);
  await expect(page.locator('.srs-mc-btn')).toHaveCount(4);       // rung 3 surface
  await expect(page.locator('#srs-prod-input')).toHaveCount(0);   // no keyboard
  // The dots show what you're being asked; the label reflects the card itself.
  await expect(page.locator('#srs-rung')).toContainText('Mastered');
  await expect(page.locator('#srs-rung')).toHaveClass(/mastered/);
});

test('an ungenerated high rung degrades to Reversed and never errors', async ({ page }) => {
  await showCardAt(page, 3, { withPack: false });
  await expect(page.locator('#srs-flip-card .srs-card-face').first()).toContainText(BACK);
  await expect(page.locator('#srs-rung')).toContainText('Reversed');
});

test('Flip mode pins to rung 0 regardless of the stored level', async ({ page }) => {
  await showCardAt(page, 3, { mode: 'flip' });
  await expect(page.locator('#srs-flip-card .srs-card-face').first()).toContainText(FRONT);
  const shown = await page.evaluate(() => srsShownLevel);
  expect(shown).toBe(0);   // so it earns no promotion
});

test('the keyboard path works on the reversed rung, not just rung 0', async ({ page }) => {
  await showCardAt(page, 1);
  await expect(page.locator('#srs-rate-btns')).toBeHidden();
  await page.keyboard.press('Space');
  await expect(page.locator('#srs-flip-card')).toHaveClass(/flipped/);
  await expect(page.locator('#srs-rate-btns')).toBeVisible();
});

test('the keyboard path is inert on rungs with no flip surface', async ({ page }) => {
  await showCardAt(page, 3);
  await page.keyboard.press('Space');
  await expect(page.locator('.srs-mc-btn')).toHaveCount(4);   // nothing changed, nothing threw
});

test('grading a card advances the ladder and counts the promotion', async ({ page }) => {
  await showCardAt(page, 2);
  await page.evaluate(() => { srsQueue[0].ladder_streak = 1; });   // one easy already banked
  await page.locator('#srs-flip-wrap').click();
  await page.locator('.srs-btn-easy').click();
  const s = await page.evaluate(() => ({ promoted: srsStats.promoted, easy: srsStats.easy }));
  expect(s.easy).toBe(1);
  expect(s.promoted).toBe(1);
  await expect(page.locator('.srs-done-title')).toContainText('Session complete');
  await expect(page.locator('.srs-done')).toContainText('1 card moved up a rung.');
});

test('the scroll feed caps a rung-4 card at the reworded prompt', async ({ page }) => {
  const html = await page.evaluate(([front, back]) => {
    const src = ladderFingerprint(front, back);
    const card = {
      id: 'x', front, back, ladder_level: 4,
      variants: { v: 1, src,
        reworded: { kind: 'cloze', prompt: 'His ____ history of the war reads like a brief.' },
        discriminate: { stem: 's', options: [
          { text: 'a', correct: true }, { text: 'b', correct: false }, { text: 'c', correct: false }] },
        produce: { prompt: 'Use it.', criteria: [] } },
      variants_src: src,
    };
    return { front: CARD_SPECS['due-card'].render(card), back: CARD_SPECS['due-card'].renderBack(card) };
  }, [FRONT, BACK]);
  expect(html.front).toContain('His ____ history of the war');
  expect(html.front).not.toContain('<textarea');
  expect(html.front).not.toContain('srs-mc-btn');
  // The back always carries both sides so the reveal is unambiguous.
  expect(html.back).toContain(FRONT);
  expect(html.back).toContain(BACK);
  expect(html.back).toContain('reworded');
});
