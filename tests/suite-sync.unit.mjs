// Unit tests for suite-sync.js (the shared offline outbox). Runs under plain
// `node --test` with no browser: fetch, storage and the snapshot store are all
// injected. Run: `npm run unit` from tests/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const SuiteSync = require('../suite-sync.js');

const REST = 'https://x.supabase.co/rest/v1/';

function memStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    dump: () => Object.fromEntries(m),
  };
}
function memSnap() {
  const m = new Map();
  return { get: async (k) => m.get(k), set: async (k, v) => m.set(k, v), del: async (k) => m.delete(k), size: () => m.size, keys: () => [...m.keys()] };
}
const netErr = () => { const e = new TypeError('Failed to fetch'); return e; };
const json = (status, body, headers = {}) =>
  new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

// A harness: scripted fetch (queue of responders), manual online flag, manual timers.
function harness(opts = {}) {
  const calls = [];
  const responders = [];
  let online = opts.online ?? true;
  const timers = [];
  const storage = memStorage();
  const snap = memSnap();
  const events = { queued: [], flushed: [], change: [], authLost: 0 };
  const sync = SuiteSync.create({
    name: 't',
    storage,
    snapStore: snap,
    isOnline: () => online,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
    authHeaders: async () => ({ Authorization: 'Bearer fresh-token' }),
    onAuthLost: () => { events.authLost++; },
    onQueued: (op) => events.queued.push(op),
    onFlushed: (r) => events.flushed.push(r),
    onChange: (st) => events.change.push(st),
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      const r = responders.shift();
      if (!r) return json(200, []);
      if (typeof r === 'function') return r(url, init);
      if (r instanceof Error) throw r;
      return r;
    },
    ...opts.cfg,
  });
  return {
    sync, calls, storage, snap, events,
    respond: (...rs) => responders.push(...rs),
    setOnline: (v) => { online = v; },
    runTimers: async () => { const t = timers.splice(0); for (const x of t) await x.fn(); },
    timers,
  };
}

const post = (body, prefer = 'return=representation') => ({
  method: 'POST', headers: { apikey: 'k', Authorization: 'Bearer old', 'Content-Type': 'application/json', Prefer: prefer }, body: JSON.stringify(body),
});
const patch = (body) => ({ method: 'PATCH', headers: { apikey: 'k', Authorization: 'Bearer old', Prefer: 'return=minimal' }, body: JSON.stringify(body) });

test('online write with empty outbox goes straight to the network', async () => {
  const h = harness();
  h.respond(json(201, [{ id: 'srv' }]));
  const res = await h.sync.fetch(REST + 'flashcards', post({ front: 'a' }));
  assert.equal(res.status, 201);
  assert.equal(h.calls.length, 1);
  assert.equal(h.sync.pending().length, 0);
  assert.equal(h.sync.isQueued(await res.json()), false);
});

test('offline POST is queued, gets a client id, and returns a representation marked queued', async () => {
  const h = harness({ online: false });
  const res = await h.sync.fetch(REST + 'flashcards', post({ front: 'a', back: 'b' }));
  assert.equal(h.calls.length, 0, 'network not touched');
  assert.equal(res.status, 201);
  const rows = await res.json();
  assert.equal(rows.length, 1);
  assert.match(rows[0].id, /^[0-9a-f-]{36}$/);
  assert.equal(h.sync.isQueued(rows), true);
  const q = h.sync.pending();
  assert.equal(q.length, 1);
  assert.equal(q[0].body.id, rows[0].id, 'stored body carries the same id');
  assert.equal(q[0].body.__queued, undefined, 'marker is not persisted');
  assert.equal(q[0].headers.Authorization, undefined, 'stale bearer not stored');
  assert.equal(h.events.queued.length, 1);
});

test('network TypeError mid-flight while onLine also queues (AbortError does not)', async () => {
  const h = harness();
  h.respond(netErr());
  const res = await h.sync.fetch(REST + 'flashcards', post({ front: 'a' }));
  assert.equal(res.headers.get('X-Suite-Sync'), 'queued');
  assert.equal(h.sync.pending().length, 1);

  const h2 = harness();
  const abort = new Error('aborted'); abort.name = 'AbortError';
  h2.respond(abort);
  await assert.rejects(h2.sync.fetch(REST + 'flashcards?id=eq.1', { method: 'DELETE' }), /aborted/);
  assert.equal(h2.sync.pending().length, 0, 'abort is the caller\'s timeout, not queued');
});

test('trailing PATCHes to the same row merge into one op', async () => {
  const h = harness({ online: false });
  await h.sync.fetch(REST + 'flashcards?id=eq.9', patch({ interval: 3, ease_factor: 2.5 }));
  await h.sync.fetch(REST + 'flashcards?id=eq.9', patch({ next_review: '2026-09-23' }));
  const q = h.sync.pending();
  assert.equal(q.length, 1);
  assert.deepEqual(q[0].body, { interval: 3, ease_factor: 2.5, next_review: '2026-09-23' });
  assert.equal(h.events.queued[1].collapsed, true);
  // a PATCH to a different row does not merge
  await h.sync.fetch(REST + 'flashcards?id=eq.10', patch({ interval: 1 }));
  assert.equal(h.sync.pending().length, 2);
});

test('once anything is pending, a live write joins the queue (ordering)', async () => {
  const h = harness({ online: false });
  const created = await (await h.sync.fetch(REST + 'flashcards', post({ front: 'a' }))).json();
  h.setOnline(true);
  // grade the offline-created card while online: must NOT overtake its insert
  await h.sync.fetch(REST + 'flashcards?id=eq.' + created[0].id, patch({ interval: 1 }));
  assert.equal(h.calls.length, 0, 'not sent live');
  assert.equal(h.sync.pending().length, 2);
  h.respond(json(201, []), json(204));
  await h.sync.flush();
  assert.equal(h.calls[0].init.method, 'POST');
  assert.equal(h.calls[1].init.method, 'PATCH');
  assert.equal(h.sync.pending().length, 0);
});

test('replay re-issues fresh auth and upserts POSTs with a client id', async () => {
  const h = harness({ online: false });
  await h.sync.fetch(REST + 'flashcards', post({ front: 'a' }));
  h.setOnline(true);
  h.respond(json(201, []));
  await h.sync.flush();
  const sent = h.calls[0].init;
  assert.equal(sent.headers.Authorization, 'Bearer fresh-token');
  assert.match(sent.headers.Prefer, /return=representation, resolution=merge-duplicates/);
  assert.equal(JSON.parse(sent.body).front, 'a');
  assert.deepEqual(h.events.flushed[0], { synced: 1, dropped: 0, remaining: 0 });
});

test('replay stops on network error and keeps the queue intact', async () => {
  const h = harness({ online: false });
  await h.sync.fetch(REST + 'a', post({ x: 1 }));
  await h.sync.fetch(REST + 'b', post({ x: 2 }));
  h.setOnline(true);
  h.respond(netErr());
  await h.sync.flush();
  assert.equal(h.sync.pending().length, 2);
  assert.equal(h.calls.length, 1);
  assert.ok(h.timers.some((t) => t.ms >= 30000), 'backoff retry scheduled');
});

test('4xx on replay goes to dead-letter, never retried; 404 and duplicate 409 count as applied', async () => {
  const h = harness({ online: false });
  await h.sync.fetch(REST + 'a', post({ x: 1 }));     // -> 400
  await h.sync.fetch(REST + 'b', post({ x: 2 }));     // -> 404
  await h.sync.fetch(REST + 'c', post({ x: 3 }));     // -> 409 dup
  await h.sync.fetch(REST + 'd', post({ x: 4 }));     // -> 409 FK
  h.setOnline(true);
  h.respond(
    json(400, { message: 'bad' }),
    json(404, {}),
    json(409, { code: '23505', message: 'duplicate key' }),
    json(409, { code: '23503', message: 'fk violation' }),
  );
  await h.sync.flush();
  assert.equal(h.sync.pending().length, 0);
  assert.equal(h.sync.dead().length, 2);
  assert.match(h.sync.dead()[0].error, /^400/);
  assert.match(h.sync.dead()[1].error, /^409/);
  assert.deepEqual(h.events.flushed[0], { synced: 2, dropped: 2, remaining: 0 });
  h.sync.clearDead();
  assert.equal(h.sync.dead().length, 0);
});

test('5xx retries up to maxAttempts then dead-letters', async () => {
  const h = harness({ online: false, cfg: { maxAttempts: 2 } });
  await h.sync.fetch(REST + 'a', post({ x: 1 }));
  h.setOnline(true);
  h.respond(json(500, {}));
  await h.sync.flush();
  assert.equal(h.sync.pending().length, 1);
  assert.equal(h.sync.pending()[0].attempts, 1);
  h.respond(json(503, {}));
  await h.sync.flush();
  assert.equal(h.sync.pending().length, 0);
  assert.equal(h.sync.dead().length, 1);
});

test('401 on replay pauses the queue, fires onAuthLost, and resume() replays', async () => {
  const h = harness({ online: false });
  await h.sync.fetch(REST + 'a', post({ x: 1 }));
  h.setOnline(true);
  h.respond(json(401, { message: 'JWT expired' }));
  await h.sync.flush();
  assert.equal(h.sync.pending().length, 1, 'kept');
  assert.equal(h.events.authLost, 1);
  assert.equal(h.sync.state().paused, true);
  h.respond(json(201, []));
  await h.sync.flush();
  assert.equal(h.calls.length, 1, 'paused: flush is a no-op');
  await h.sync.resume();
  assert.equal(h.sync.pending().length, 0);
});

test('successful GET is snapshotted and served back offline with pending PATCH/DELETE overlaid', async () => {
  const h = harness();
  const url = REST + 'flashcards?next_review=lte.2026-09-19&order=next_review.asc&limit=50';
  h.respond(json(200, [{ id: '1', front: 'a', next_review: '2026-09-19' }, { id: '2', front: 'b', next_review: '2026-09-18' }], { 'Content-Range': '0-1/2' }));
  const live = await h.sync.fetch(url, { method: 'GET' });
  assert.equal(live.status, 200);
  assert.equal(h.snap.size(), 1);
  assert.equal(h.snap.keys()[0], h.sync.snapshotKey(url));

  h.setOnline(false);
  await h.sync.fetch(REST + 'flashcards?id=eq.1', patch({ next_review: '2026-09-25', interval: 6 }));
  await h.sync.fetch(REST + 'flashcards?id=eq.2', { method: 'DELETE' });
  // next day: the date in the query moved, the snapshot still hits
  const later = await h.sync.fetch(REST + 'flashcards?next_review=lte.2026-09-20&order=next_review.asc&limit=50', { method: 'GET' });
  assert.equal(later.headers.get('X-Suite-Sync'), 'snapshot');
  assert.equal(later.headers.get('content-range'), '0-1/2');
  const rows = await later.json();
  assert.deepEqual(rows, [{ id: '1', front: 'a', next_review: '2026-09-25', interval: 6 }]);
});

test('offline GET with no snapshot rejects with a TypeError (caller sees a network failure)', async () => {
  const h = harness({ online: false });
  await assert.rejects(h.sync.fetch(REST + 'flashcards?select=id', { method: 'GET' }), TypeError);
});

test('non-REST urls pass straight through untouched', async () => {
  const h = harness({ online: false });
  h.respond(json(200, { text: 'hi' }));
  const res = await h.sync.fetch('https://x.supabase.co/functions/v1/claude', { method: 'POST', body: '{}' });
  assert.equal(res.status, 200);
  assert.equal(h.calls.length, 1);
  assert.equal(h.sync.pending().length, 0);
});

test('enqueue() lets an app migrate a legacy queue; corrupt storage reads as empty', async () => {
  const h = harness({ online: false });
  h.storage.setItem('t_outbox', '{broken');
  assert.deepEqual(h.sync.pending(), []);
  h.sync.enqueue(REST + 'flashcards', post({ front: 'legacy' }));
  assert.equal(h.sync.pending().length, 1);
  assert.equal(h.sync.pending()[0].body.front, 'legacy');
});

test('snapshotKey masks dates and timestamps only', () => {
  assert.equal(SuiteSync.snapshotKey('a?x=lte.2026-09-19&y=1'), 'a?x=lte.~&y=1');
  assert.equal(SuiteSync.snapshotKey('a?t=gte.2026-09-19T04:00:00.000Z'), 'a?t=gte.~');
  assert.equal(SuiteSync.snapshotKey('a?limit=50'), 'a?limit=50');
});
