// Shared stub for the Today's Five suites: a small, deterministic Supabase.
export function stubFive(page, opts = {}) {
  return page.addInitScript((o) => {
    localStorage.setItem('break_flow_order', o.order || 'five');
    if (o.wander != null) localStorage.setItem('break_home_wander', o.wander);
    window.__sb = [];
    const json = (v) => new Response(JSON.stringify(v), {
      status: 200, headers: { 'Content-Type': 'application/json', 'Content-Range': '0-0/0' },
    });
    const now = new Date().toISOString();
    const card = (id, extra) => Object.assign({
      id, front: 'Front ' + id, back: 'Back ' + id, source: 'manual', status: 'review',
      next_review: '2020-01-01', interval: 3, ease_factor: 2.5, created_at: '2026-08-14T10:00:00Z',
      ladder_level: 0, ladder_streak: 0, kind: 'fact', shelved_at: null,
    }, extra || {});
    const due = (o.due != null ? Array.from({ length: o.due }, (_, i) => card('d' + i)) : [card('d0'), card('d1'), card('d2'), card('d3')]);
    const arrivals = o.arrival === false ? [] : [card('new0', { front: 'apostasy', status: 'new', source: 'Kindle Vocabulary Builder', kind: 'vocab', created_at: now })];
    const shelf = o.shelf === false ? [] : [card('s0', { front: 'sinecure', source: 'Kindle Vocabulary Builder', kind: 'vocab', shelved_at: '2026-11-20T10:00:00Z' })];
    const lead = card('lead0', { front: 'lambent', next_review: '2099-01-01', source: 'book: The Wind-Up Bird Chronicle', kind: 'vocab' });
    const units = [
      { id: 'u1', course_id: 'c1', position: 1, kind: 'unit', title: 'Khalkhin Gol, 1939', state: 'ready', built_at: now,
        hook: { kind: 'guess', question: 'Who beat the Kwantung Army in 1939?', answer: 'Zhukov' },
        body: 'Zhukov surrounds a Japanese division.', why: 'Why did Tokyo look south?', key_points: [{ text: 'k' }],
        cards: [{ front: 'Khalkhin Gol', back: '1939 border battle' }],
        doors: o.doors === false ? null : [
          { role: 'onward', title: 'The Neutrality Pact, April 1941', unit_id: 'u2' },
          { role: 'deeper', title: 'How Zhukov closed the ring', one_line: 'The encirclement.' },
          { role: 'sideways', title: 'Richard Sorge, the spy in Tokyo', one_line: 'The warning.' },
        ] },
      { id: 'u2', course_id: 'c1', position: 2, kind: 'unit', title: 'The Neutrality Pact, April 1941', state: 'ready', built_at: null },
    ];
    window.fetch = async (url, opts = {}) => {
      const u = String(url);
      if (!u.includes('/rest/v1/')) return json([]);
      const path = decodeURIComponent(u.split('/rest/v1/')[1]);
      const method = opts.method || 'GET';
      window.__sb.push({ path, method, body: opts.body || null });
      if (path.startsWith('flashcards')) {
        if (method !== 'GET') return json([]);
        if (path.includes('shelved_at=not.is.null')) return json(shelf);
        if (path.includes('id=eq.')) return json([lead]);
        if (path.includes('select=id,front,back,source')) return json(due.concat(arrivals, shelf, [card('k0', { source: 'Cooking temps' }), card('b0', { source: 'book: The Lathe of Heaven' })]));
        if (path.includes('next_review=lte') && !path.includes('source=eq')) return json(due.concat(arrivals));
        return json([]);
      }
      if (path.startsWith('channels')) return json(o.journey === false ? [] : [{ id: 'ch1', name: 'Japan\'s western front', course_id: 'c1', status: 'following', seeded_from: 'topic', weight: 1, last_shown_at: null }]);
      if (path.startsWith('courses')) return json([{ id: 'c1', title: 'Japan\'s western front', shape: 'chronology', source: 'model', new_per_day: 2, status: 'active' }]);
      if (path.startsWith('course_units')) {
        if (method === 'POST') { const rows = JSON.parse(opts.body); return json(rows.map((r, i) => Object.assign({ id: 'side' + i, state: 'ready', built_at: null }, r))); }
        if (method === 'GET') return json(units);
        return json([]);
      }
      return json([]);
    };
  }, opts);
}

// Only a few cards are mounted ahead of the thumb; walk the feed to its end.
export async function reachEnd(page) {
  await page.waitForFunction(() => {
    if (typeof feedMounted === 'undefined') return false;
    if (feedMounted.includes('flow-mark')) return true;
    feedActiveIdx = feedItems().length - 1; feedFill();
    return false;
  }, null, { timeout: 8000, polling: 150 });
}
