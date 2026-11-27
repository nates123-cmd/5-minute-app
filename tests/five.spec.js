// Today's Five, the shelf, journeys with doors, and the library home
// (2026-11-27). A sitting is a fixed plan of five that ends; a card overdue
// by more than a week is shelved rather than owed; a journey step ends on
// doors; home is what you saved.
import { test, expect } from '@playwright/test';
import { boot, seedSession } from './helper.js';
import { stubFive, reachEnd } from './five-stub.js';

test.beforeEach(async ({ page }) => { await seedSession(page); });

test('a sitting is five items in a fixed order, then an ending and nothing after it', async ({ page }) => {
  await stubFive(page);
  await boot(page, '/');
  await reachEnd(page);
  const s = await page.evaluate(() => ({
    mounted: feedMounted.slice(),
    fronts: feedItems().map(n => n._due ? n._due.front : (n._chan ? 'step' : 'end')),
    prov: feedItems().map(n => (n.querySelector('.due-prov') || {}).textContent || ''),
    sentinel: !!document.querySelector('.feed-loading'),
    end: document.querySelector('.five-end .main-text').textContent,
    buffer: feedDueBuffer.length,
    total: five.total,
  }));
  expect(s.mounted).toEqual(['due-card', 'due-card', 'due-card', 'chan-unit', 'due-card', 'flow-mark']);
  expect(s.fronts).toEqual(['Front d0', 'Front d1', 'sinecure', 'step', 'apostasy', 'end']);
  expect(s.prov[2]).toContain('Re-meet');
  expect(s.prov[4]).toMatch(/^New · Kindle lookup/);
  expect(s.prov[0]).toBe('Added by hand · Aug 14');
  expect(s.total).toBe(5);
  expect(s.end).toBe('That\'s five.');
  expect(s.sentinel).toBe(false);
  expect(s.buffer).toBe(0);
  // Nothing restocks: a top-up after the plan adds no card.
  await page.evaluate(() => { feedDueTopUp(); feedFill(); });
  expect(await page.evaluate(() => feedMounted.length)).toBe(6);
});

test('the rail shows position as five ticks and never a count of what is owed', async ({ page }) => {
  await stubFive(page);
  await boot(page, '/');
  await page.waitForFunction(() => typeof five !== 'undefined' && five && five.planned && feedItems().length > 0);
  const rail = page.locator('#feed-filters');
  await expect(rail.locator('.five-rail i')).toHaveCount(5);
  await expect(rail.locator('.five-rail i.on')).toHaveCount(1);
  await expect(rail.locator('.five-n')).toHaveText('1 of 5');
  await expect(rail).not.toContainText('left');
  await expect(page.locator('.feed-item[data-slug="due-card"] .due-left').first()).toHaveText('');
});

test('cards overdue by more than a week are shelved once a day, and due queries skip the shelf', async ({ page }) => {
  await stubFive(page);
  await boot(page, '/');
  await page.waitForFunction(() => typeof five !== 'undefined' && five && five.planned);
  const calls = await page.evaluate(() => window.__sb);
  const sweeps = calls.filter(c => c.method === 'PATCH' && c.path.startsWith('flashcards') && c.path.includes('next_review=lt.'));
  expect(sweeps.length).toBe(1);
  expect(sweeps[0].path).toContain('shelved_at=is.null');
  expect(JSON.parse(sweeps[0].body).shelved_at).toBeTruthy();
  const dueReads = calls.filter(c => c.method === 'GET' && c.path.includes('next_review=lte'));
  expect(dueReads.length).toBeGreaterThan(0);
  dueReads.forEach(c => expect(c.path).toContain('shelved_at=is.null'));
  // A second sitting the same day does not sweep again.
  await page.evaluate(() => { window.__sb.length = 0; return openFlow(); });
  await page.waitForFunction(() => five && five.planned);
  const again = await page.evaluate(() => window.__sb.filter(c => c.method === 'PATCH' && c.path.includes('next_review=lt.')).length);
  expect(again).toBe(0);
});

test('grading a Re-meet takes the card off the shelf', async ({ page }) => {
  await stubFive(page);
  await boot(page, '/');
  await page.waitForFunction(() => feedItems().some(n => n._due && n._due.id === 's0'));
  await page.evaluate(() => {
    const item = feedItems().find(n => n._due && n._due.id === 's0');
    feedToggleFlip(item);
    item.querySelector('[data-due-rate="2"]').click();
  });
  await page.waitForFunction(() => window.__sb.some(c => c.method === 'PATCH' && c.path.includes('id=eq.s0')));
  const body = await page.evaluate(() => JSON.parse(window.__sb.find(c => c.method === 'PATCH' && c.path.includes('id=eq.s0')).body));
  expect(body.shelved_at).toBeNull();
  expect(body.next_review).toBeTruthy();
});

test('a journey step ends on three doors; taking Deeper makes a side step and the ending names it', async ({ page }) => {
  await stubFive(page);
  await boot(page, '/');
  await reachEnd(page);
  const step = page.locator('.feed-item[data-slug="chan-unit"]');
  await expect(step.locator('.jrny-doors')).toBeHidden();          // doors come after the lesson
  await page.evaluate(() => chanTeach(feedItems().find(n => n._chan)));
  await expect(step.locator('[data-jrny-door]')).toHaveCount(3);
  await expect(step.locator('[data-jrny-door] small')).toHaveText(['Onward', 'Deeper', 'Sideways']);
  // No "n of N": the plan is a hidden spine, not a syllabus.
  expect(await page.evaluate(() => feedItems().find(n => n._chan)._chan._chip)).toBe('Japan\'s western front');
  await page.evaluate(() => document.querySelector('[data-jrny-door="1"]').click());
  await expect(step.locator('[data-jrny-go]')).toBeVisible();
  const calls = await page.evaluate(() => window.__sb.filter(c => c.path.startsWith('course_units') && c.method !== 'GET'));
  const post = calls.find(c => c.method === 'POST');
  expect(JSON.parse(post.body)[0]).toMatchObject({ course_id: 'c1', parent_id: 'u1', title: 'How Zhukov closed the ring', kind: 'unit' });
  const patches = calls.filter(c => c.method === 'PATCH').map(c => ({ path: c.path, body: JSON.parse(c.body) }));
  expect(patches.find(x => x.path.includes('id=eq.u1') && x.body.door_picked).body.door_picked).toBe('deeper');
  expect(patches.find(x => x.path.includes('id=eq.side0')).body.picked_at).toBeTruthy();
  expect(patches.find(x => x.path.includes('id=eq.u1') && x.body.taught_at)).toBeTruthy();
  await expect(step.locator('.jrny-door.unpicked')).toHaveCount(2);
  await expect(page.locator('[data-five-tomorrow]')).toHaveText('Next time: How Zhukov closed the ring.');
});

test('a short day says so honestly, and the ending offers more, wander and the library', async ({ page }) => {
  await stubFive(page, { due: 1, arrival: false, shelf: false, journey: false });
  await boot(page, '/');
  await reachEnd(page);
  await expect(page.locator('.five-end .main-text')).toHaveText('That\'s it for now.');
  await expect(page.locator('#feed-filters .five-rail i')).toHaveCount(1);
  await expect(page.locator('.five-act')).toHaveText(['Five more', 'Wander', 'Library']);
  await page.evaluate(() => document.querySelector('[data-five-wander]').click());
  expect(await page.evaluate(() => feedMode)).toBe('scroll');
  await page.evaluate(() => openFlow());
  await reachEnd(page);
  await page.evaluate(() => document.querySelector('[data-five-home]').click());
  await expect(page.locator('#screen-home')).toHaveClass(/active/);
});

test('"Five more" deals different cards than the sitting before it', async ({ page }) => {
  await stubFive(page, { due: 8, arrival: false, shelf: false, journey: false });
  await boot(page, '/');
  await reachEnd(page);
  const first = await page.evaluate(() => feedItems().filter(n => n._due).map(n => n._due.id));
  expect(first).toEqual(['d0', 'd1', 'd2', 'd3', 'd4']);
  await page.evaluate(() => document.querySelector('[data-five-more]').click());
  await page.waitForFunction(() => five && five.planned && feedItems().some(n => n._due));
  await reachEnd(page);
  const second = await page.evaluate(() => feedItems().filter(n => n._due).map(n => n._due.id));
  expect(second).toEqual(['d5', 'd6', 'd7']);
});

test('#card=<id> leads the sitting with that card; one that is not due is a look, not a grade', async ({ page }) => {
  await stubFive(page);
  await boot(page, '/#card=1ead0000-aaaa-bbbb-cccc-000000000000');
  await page.waitForFunction(() => typeof five !== 'undefined' && five && five.planned && feedItems().length > 0);
  const s = await page.evaluate(() => {
    const item = feedItems()[0];
    feedToggleFlip(item);
    return { front: item._due.front, peek: !!item._due._peek, rate: item.querySelectorAll('[data-due-rate]').length,
      prov: item.querySelector('.due-prov').textContent, hash: location.hash };
  });
  expect(s.front).toBe('lambent');
  expect(s.peek).toBe(true);
  expect(s.rate).toBe(0);
  expect(s.prov).toBe('The Wind-Up Bird Chronicle · Aug 14');
  expect(s.hash).toBe('');
});

test('home is a library: shelves by where a card came from, the old home behind Wander', async ({ page }) => {
  await stubFive(page, { wander: '0' });
  await boot(page);
  await expect(page.locator('#flow-label')).toHaveText('Today\'s five');
  const rows = page.locator('#lib-shelves .lib-row');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toHaveText(/Books and Kindle lookups\s*3/);
  await expect(rows.nth(1)).toHaveText(/Kitchen\s*1/);
  await expect(rows.nth(2)).toHaveText(/Everything else\s*4/);
  await expect(page.locator('#lib-journeys-n')).toHaveText('1');
  await expect(page.locator('#home-wander')).toBeHidden();
  await page.locator('#lib-wander').click();
  await expect(page.locator('#activity-grid')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('break_home_wander'))).toBe('1');
  // A shelf opens as a list with provenance, and its run takes only what needs a look.
  await rows.nth(0).click();
  await expect(page.locator('#screen-shelf')).toHaveClass(/active/);
  await expect(page.locator('#shelf-title')).toHaveText('Books and Kindle lookups');
  await expect(page.locator('.shelf-card')).toHaveCount(3);
  await expect(page.locator('#shelf-run-n')).toHaveText('3');
});

test('a journey trail lists the steps walked and keeps passed doors open', async ({ page }) => {
  await stubFive(page);
  await boot(page);
  await page.evaluate(async () => {
    await trailOpen('ch1');
    trailState.units[0].state = 'taught';
    trailState.units[0].taught_at = '2026-11-20T10:00:00Z';
    trailState.units[0].door_picked = 'onward';
    trailRender();
  });
  await expect(page.locator('#trail-title')).toHaveText('Japan\'s western front');
  await expect(page.locator('#trail-body .trail-row')).toHaveText([
    /Khalkhin Gol, 1939\s*Nov 20/, /How Zhukov closed the ring\s*open/, /Richard Sorge, the spy in Tokyo\s*open/, /The Neutrality Pact, April 1941\s*next/,
  ]);
  await expect(page.locator('.trail-foot')).toHaveText('1 step walked · 2 roads still open');
  await page.locator('[data-trail-road="u1:2"]').click();
  await page.waitForFunction(() => window.__sb.some(c => c.method === 'POST' && c.path.startsWith('course_units')));
  const post = await page.evaluate(() => JSON.parse(window.__sb.find(c => c.method === 'POST' && c.path.startsWith('course_units')).body)[0]);
  expect(post).toMatchObject({ parent_id: 'u1', title: 'Richard Sorge, the spy in Tokyo' });
  // Taking a passed road later does not rewrite the choice made at the time.
  const patch = await page.evaluate(() => window.__sb.filter(c => c.method === 'PATCH' && c.path.includes('id=eq.u1')).map(c => JSON.parse(c.body)));
  expect(patch.some(b => 'door_picked' in b)).toBe(false);
});

test('the mixed and in-sequence Flows are still there, one menu tap away', async ({ page }) => {
  await stubFive(page);
  await boot(page);
  await expect(page.locator('#flow-order-label')).toHaveText('Five');
  await page.evaluate(() => document.getElementById('btn-flow-order').click());
  await expect(page.locator('#flow-order-label')).toHaveText('Mixed');
  await expect(page.locator('#flow-label')).toHaveText('Flow');
  await page.evaluate(() => document.getElementById('btn-flow-order').click());
  await expect(page.locator('#flow-order-label')).toHaveText('In sequence');
  await page.evaluate(() => document.getElementById('btn-flow-order').click());
  await expect(page.locator('#flow-order-label')).toHaveText('Five');
});
