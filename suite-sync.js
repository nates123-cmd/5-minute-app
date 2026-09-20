/*
 * suite-sync.js — offline outbox + read snapshot for the Personal OS suite.
 *
 * Canonical copy lives in 5-minute-break/suite-sync.js and is VENDORED into each
 * app (no build step, no shared host). Bump VERSION when you change it and copy
 * the file forward. Works as a drop-in around fetch for two families of app:
 *
 *   raw-fetch apps   : sbFetch() calls  sync.fetch(url, init)  instead of fetch()
 *   supabase-js apps : createClient(url, key, { global: { fetch: sync.fetch } })
 *
 * What it does
 *   Writes (POST/PATCH/PUT/DELETE to /rest/v1/) while offline, or while anything
 *   is already pending, go to a localStorage outbox and replay FIFO on
 *   reconnect. Offline POSTs get a client-minted uuid so chained writes link up
 *   and the replay is an idempotent upsert. Trailing PATCHes to the same row
 *   merge. 4xx on replay goes to a dead-letter list (never retried forever);
 *   5xx/network retries with backoff; 401 pauses the queue and hands control to
 *   onAuthLost so nothing is dropped while the session is re-established.
 *
 *   Reads (GET) that succeed are snapshotted (IndexedDB, localStorage fallback).
 *   When a read fails for network reasons the last snapshot is returned, with
 *   pending PATCH/DELETE ops overlaid by row id, so a cold start offline still
 *   shows yesterday's data with today's offline edits applied.
 *
 * Ordering rule (the one that matters): once the outbox is non-empty, EVERY
 * write is enqueued behind it and a flush is kicked, even when online. Sending
 * a live PATCH ahead of a queued POST for the same row would silently no-op on
 * PostgREST (zero rows matched) and the grade would be lost.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SuiteSync = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = '1.0.0';
  var WRITE = { POST: 1, PATCH: 1, PUT: 1, DELETE: 1 };
  var QUEUED_MARK = '__queued';

  function nowMs() { return Date.now(); }

  function safeJsonParse(s, fallback) {
    try { return JSON.parse(s); } catch (e) { return fallback; }
  }

  function headersToObject(h) {
    var out = {};
    if (!h) return out;
    if (typeof h.forEach === 'function' && !Array.isArray(h)) {
      h.forEach(function (v, k) { out[k] = v; });
      return out;
    }
    if (Array.isArray(h)) { h.forEach(function (p) { out[p[0]] = p[1]; }); return out; }
    Object.keys(h).forEach(function (k) { out[k] = h[k]; });
    return out;
  }

  function findHeader(obj, name) {
    var lower = name.toLowerCase();
    var keys = Object.keys(obj);
    for (var i = 0; i < keys.length; i++) if (keys[i].toLowerCase() === lower) return keys[i];
    return null;
  }

  function getHeader(obj, name) { var k = findHeader(obj, name); return k ? obj[k] : undefined; }

  function setHeader(obj, name, value) {
    var k = findHeader(obj, name);
    obj[k || name] = value;
    return obj;
  }

  function deleteHeader(obj, name) { var k = findHeader(obj, name); if (k) delete obj[k]; }

  function isNetworkError(e) {
    // fetch rejects with TypeError on network failure in every browser; Safari
    // sometimes uses "Load failed". AbortError is the caller's own timeout,
    // not the network, and must NOT be queued (the caller expects a failure).
    if (!e) return false;
    if (e.name === 'AbortError') return false;
    return e instanceof TypeError || e.name === 'TypeError' || /load failed|network|failed to fetch/i.test(String(e.message || e));
  }

  function mintId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    var s = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx';
    return s.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  function tableOf(url) {
    var m = String(url).match(/\/rest\/v1\/([^?#/]+)/);
    return m ? m[1] : null;
  }

  function eqIdOf(url) {
    var m = String(url).match(/[?&]id=eq\.([^&#]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  // Snapshot keys drop concrete dates so `next_review=lte.2026-09-20` hits the
  // snapshot taken yesterday under `next_review=lte.2026-09-19`.
  function snapshotKey(url) {
    return String(url).replace(/\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?/g, '~');
  }

  // ── default stores ───────────────────────────────────────────────────────
  function memoryStorage() {
    var m = {};
    return {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
      setItem: function (k, v) { m[k] = String(v); },
      removeItem: function (k) { delete m[k]; },
    };
  }

  function defaultStorage() {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.getItem('__suite_sync_probe');
        return localStorage;
      }
    } catch (e) {}
    return memoryStorage();
  }

  // IndexedDB kv for snapshots (they can be big: card packs, day logs). Falls
  // back to localStorage, and from there to memory, so the API never throws.
  function idbStore(dbName, storeName) {
    var dbp = null;
    function open() {
      if (dbp) return dbp;
      dbp = new Promise(function (resolve, reject) {
        try {
          var req = indexedDB.open(dbName, 1);
          req.onupgradeneeded = function () { req.result.createObjectStore(storeName); };
          req.onsuccess = function () { resolve(req.result); };
          req.onerror = function () { reject(req.error); };
          req.onblocked = function () { reject(new Error('idb blocked')); };
        } catch (e) { reject(e); }
      });
      dbp.catch(function () { dbp = null; });
      return dbp;
    }
    function run(mode, fn) {
      return open().then(function (db) {
        return new Promise(function (resolve, reject) {
          var tx = db.transaction(storeName, mode);
          var st = tx.objectStore(storeName);
          var req = fn(st);
          tx.oncomplete = function () { resolve(req && req.result); };
          tx.onerror = function () { reject(tx.error); };
          tx.onabort = function () { reject(tx.error); };
        });
      });
    }
    return {
      get: function (k) { return run('readonly', function (st) { return st.get(k); }).catch(function () { return undefined; }); },
      set: function (k, v) { return run('readwrite', function (st) { return st.put(v, k); }).catch(function () {}); },
      del: function (k) { return run('readwrite', function (st) { return st.delete(k); }).catch(function () {}); },
    };
  }

  function storageSnapStore(storage, prefix) {
    return {
      get: function (k) { return Promise.resolve(safeJsonParse(storage.getItem(prefix + k), undefined)); },
      set: function (k, v) { try { storage.setItem(prefix + k, JSON.stringify(v)); } catch (e) {} return Promise.resolve(); },
      del: function (k) { try { storage.removeItem(prefix + k); } catch (e) {} return Promise.resolve(); },
    };
  }

  // One database PER APP. Every suite app shares the GitHub Pages origin, and a
  // shared database would only run onupgradeneeded for the first app to open
  // it, leaving every later app without its object store.
  function defaultSnapStore(name, storage) {
    if (typeof indexedDB !== 'undefined') return idbStore('suite-sync:' + name, 'snap');
    return storageSnapStore(storage, name + '_snap:');
  }

  // ── instance ─────────────────────────────────────────────────────────────
  function create(cfg) {
    cfg = cfg || {};
    var name = cfg.name || 'suite';
    var storage = cfg.storage || defaultStorage();
    var snapStore = cfg.snapStore || defaultSnapStore(name, storage);
    var KEY = name + '_outbox';
    var DEAD_KEY = name + '_outbox_dead';
    var underlying = cfg.fetch || function () { return globalThis.fetch.apply(globalThis, arguments); };
    var shouldHandle = cfg.shouldHandle || function (url) { return String(url).indexOf('/rest/v1/') !== -1; };
    var authHeaders = cfg.authHeaders || function () { return {}; };
    var onAuthLost = cfg.onAuthLost || function () {};
    var onChange = cfg.onChange || function () {};
    var onFlushed = cfg.onFlushed || function () {};
    var onQueued = cfg.onQueued || function () {};
    var snapshotReads = cfg.snapshotReads !== false;
    var idempotentPost = cfg.idempotentPost !== false;
    var maxAttempts = cfg.maxAttempts || 5;
    var maxSnapshotBytes = cfg.maxSnapshotBytes || 2 * 1024 * 1024;
    var idField = cfg.idField || 'id';
    var isOnline = cfg.isOnline || function () {
      return (typeof navigator === 'undefined') ? true : navigator.onLine !== false;
    };
    var setTimer = cfg.setTimeout || function (fn, ms) { return setTimeout(fn, ms); };
    var clearTimer = cfg.clearTimeout || function (t) { clearTimeout(t); };

    var flushing = false;
    var paused = false;         // 401 seen during replay; resume() after re-auth
    var retryTimer = null;      // backoff after a failed replay
    var soonTimer = null;       // coalesced "flush on next tick"
    var retryCount = 0;
    var lastError = null;

    function readQueue() { var q = safeJsonParse(storage.getItem(KEY), []); return Array.isArray(q) ? q : []; }
    function writeQueue(q) {
      try { if (q.length) storage.setItem(KEY, JSON.stringify(q)); else storage.removeItem(KEY); }
      catch (e) { lastError = e; }
    }
    function readDead() { var q = safeJsonParse(storage.getItem(DEAD_KEY), []); return Array.isArray(q) ? q : []; }
    function writeDead(q) {
      try { if (q.length) storage.setItem(DEAD_KEY, JSON.stringify(q.slice(-50))); else storage.removeItem(DEAD_KEY); }
      catch (e) {}
    }

    function state() {
      return { pending: readQueue().length, dead: readDead().length, online: isOnline(), flushing: flushing, paused: paused, lastError: lastError };
    }
    function notify() { try { onChange(state()); } catch (e) {} }

    function parseBody(body) {
      if (body == null) return null;
      if (typeof body === 'string') { var v = safeJsonParse(body, undefined); return v === undefined ? body : v; }
      if (typeof body === 'object' && !(body instanceof ArrayBuffer) && typeof body.append !== 'function') return body;
      return body; // FormData/Blob etc: stored as-is, will not survive JSON — callers should not send those to REST
    }

    function synthResponse(status, bodyText, extraHeaders) {
      var h = { 'Content-Type': 'application/json', 'X-Suite-Sync': 'queued' };
      if (extraHeaders) Object.keys(extraHeaders).forEach(function (k) { h[k] = extraHeaders[k]; });
      return new Response(status === 204 ? null : bodyText, { status: status, headers: h });
    }

    // Build the queue entry and the optimistic response the caller sees.
    function enqueue(url, init, opts) {
      init = init || {};
      opts = opts || {};
      var method = String(init.method || 'GET').toUpperCase();
      var headers = headersToObject(init.headers);
      deleteHeader(headers, 'Authorization'); // re-issued at replay by authHeaders()
      var body = parseBody(init.body);
      var minted = [];

      if (method === 'POST' && body && typeof body === 'object') {
        var rows = Array.isArray(body) ? body : [body];
        rows.forEach(function (r) {
          if (r && typeof r === 'object' && r[idField] == null) { r[idField] = mintId(); minted.push(r[idField]); }
        });
      }

      var q = readQueue();
      var collapsed = false;
      var last = q[q.length - 1];
      if (method === 'PATCH' && last && last.method === 'PATCH' && last.url === url
          && body && typeof body === 'object' && !Array.isArray(body)
          && last.body && typeof last.body === 'object' && !Array.isArray(last.body)) {
        last.body = Object.assign({}, last.body, body);
        last.ts = nowMs();
        collapsed = true;
      } else {
        q.push({ id: mintId(), url: String(url), method: method, headers: headers, body: body, ts: nowMs(), attempts: 0 });
      }
      writeQueue(q);
      notify();
      try { onQueued({ url: String(url), method: method, collapsed: collapsed, pending: q.length }); } catch (e) {}
      if (!opts.silent) flushSoon(0);

      var prefer = String(getHeader(headers, 'Prefer') || '');
      if (method === 'POST' && /return=representation/.test(prefer) && body && typeof body === 'object') {
        var rep = (Array.isArray(body) ? body : [body]).map(function (r) {
          var c = Object.assign({}, r); c[QUEUED_MARK] = true; return c;
        });
        return synthResponse(201, JSON.stringify(rep));
      }
      if (/return=representation/.test(prefer) && body && typeof body === 'object' && !Array.isArray(body)) {
        var one = Object.assign({}, body); one[QUEUED_MARK] = true;
        return synthResponse(200, JSON.stringify([one]));
      }
      return synthResponse(204, null);
    }

    function isQueued(res) {
      if (!res) return false;
      if (typeof res.headers === 'object' && res.headers && typeof res.headers.get === 'function') return res.headers.get('X-Suite-Sync') === 'queued';
      var row = Array.isArray(res) ? res[0] : res;
      return !!(row && typeof row === 'object' && row[QUEUED_MARK]);
    }

    // ── replay ────────────────────────────────────────────────────────────
    function scheduleRetry() {
      if (retryTimer) return;
      var delay = Math.min(30000 * Math.pow(2, retryCount), 5 * 60000);
      retryCount++;
      retryTimer = setTimer(function () { retryTimer = null; flush(); }, delay);
    }

    function flushSoon(ms) {
      if (soonTimer) return;
      soonTimer = setTimer(function () { soonTimer = null; flush(); }, ms || 0);
    }

    async function flush() {
      if (retryTimer) { clearTimer(retryTimer); retryTimer = null; }
      if (flushing || paused || !isOnline()) { notify(); return state(); }
      var q = readQueue();
      if (!q.length) { notify(); return state(); }
      flushing = true; notify();
      var synced = 0, dropped = 0, deadOps = [];
      var stopReason = null;
      try {
        while (q.length) {
          var op = q[0];
          var headers = Object.assign({}, op.headers || {});
          var auth = {};
          try { auth = await authHeaders(); } catch (e) {}
          Object.keys(auth || {}).forEach(function (k) { setHeader(headers, k, auth[k]); });
          if (!getHeader(headers, 'Content-Type') && op.body != null) setHeader(headers, 'Content-Type', 'application/json');
          if (idempotentPost && op.method === 'POST' && op.body && typeof op.body === 'object') {
            var rows = Array.isArray(op.body) ? op.body : [op.body];
            var allHaveIds = rows.every(function (r) { return r && r[idField] != null; });
            if (allHaveIds) {
              var prefer = String(getHeader(headers, 'Prefer') || '');
              if (!/resolution=/.test(prefer)) setHeader(headers, 'Prefer', prefer ? prefer + ', resolution=merge-duplicates' : 'resolution=merge-duplicates');
            }
          }
          var init = { method: op.method, headers: headers };
          if (op.body != null) init.body = typeof op.body === 'string' ? op.body : JSON.stringify(op.body);

          var res;
          try { res = await underlying(op.url, init); }
          catch (e) {
            if (isNetworkError(e)) { stopReason = 'network'; break; }
            // Non-network throw: treat like a permanent failure so we never wedge.
            op.error = String(e && e.message || e); deadOps.push(q.shift()); dropped++; writeQueue(q); continue;
          }

          if (res.ok) { q.shift(); synced++; retryCount = 0; writeQueue(q); continue; }

          var status = res.status;
          var text = '';
          try { text = await res.text(); } catch (e) {}

          if (status === 401) {
            // Session dead. Keep the op; the app re-auths and calls resume().
            paused = true; stopReason = 'auth'; lastError = new Error('401 during replay');
            writeQueue(q);
            try { onAuthLost(); } catch (e) {}
            break;
          }
          if (status === 404 || (status === 409 && /23505|duplicate key/i.test(text))) {
            // Already applied (or the row is gone): nothing left to do.
            q.shift(); synced++; writeQueue(q); continue;
          }
          if (status >= 400 && status < 500) {
            op.error = status + ' ' + text.slice(0, 300); deadOps.push(q.shift()); dropped++; writeQueue(q); continue;
          }
          // 5xx / other: bounded retries.
          op.attempts = (op.attempts || 0) + 1;
          op.error = status + ' ' + text.slice(0, 300);
          if (op.attempts >= maxAttempts) { deadOps.push(q.shift()); dropped++; writeQueue(q); continue; }
          writeQueue(q); stopReason = 'server'; break;
        }
      } finally {
        flushing = false;
      }
      if (deadOps.length) writeDead(readDead().concat(deadOps));
      if (stopReason === 'server' || (stopReason === 'network' && isOnline())) scheduleRetry();
      notify();
      if (synced || dropped) { try { await onFlushed({ synced: synced, dropped: dropped, remaining: q.length }); } catch (e) {} }
      return state();
    }

    function resume() { paused = false; retryCount = 0; return flush(); }

    // ── reads ─────────────────────────────────────────────────────────────
    function overlayPending(text, url) {
      var rows = safeJsonParse(text, undefined);
      if (!Array.isArray(rows)) return text;
      var table = tableOf(url);
      if (!table) return text;
      var q = readQueue();
      var changed = false;
      q.forEach(function (op) {
        if (tableOf(op.url) !== table) return;
        var id = eqIdOf(op.url);
        if (!id) return;
        if (op.method === 'PATCH' && op.body && typeof op.body === 'object') {
          rows.forEach(function (r) { if (r && String(r[idField]) === id) { Object.assign(r, op.body); changed = true; } });
        } else if (op.method === 'DELETE') {
          var before = rows.length;
          rows = rows.filter(function (r) { return !(r && String(r[idField]) === id); });
          if (rows.length !== before) changed = true;
        }
      });
      return changed ? JSON.stringify(rows) : text;
    }

    function snapResponse(snap, url) {
      var h = { 'X-Suite-Sync': 'snapshot' };
      if (snap.headers) Object.keys(snap.headers).forEach(function (k) { h[k] = snap.headers[k]; });
      if (!h['Content-Type'] && !h['content-type']) h['Content-Type'] = 'application/json';
      return new Response(overlayPending(snap.text, url), { status: 200, headers: h });
    }

    async function handleRead(url, init) {
      var key = snapshotKey(url);
      if (!isOnline()) {
        var s0 = snapshotReads ? await snapStore.get(key) : undefined;
        if (s0) return snapResponse(s0, url);
        throw new TypeError('Failed to fetch (offline, no snapshot)');
      }
      var res;
      try { res = await underlying(url, init); }
      catch (e) {
        if (isNetworkError(e) && snapshotReads) {
          var s1 = await snapStore.get(key);
          if (s1) return snapResponse(s1, url);
        }
        throw e;
      }
      if (snapshotReads && res.ok && res.status === 200) {
        try {
          var text = await res.clone().text();
          if (text.length <= maxSnapshotBytes) {
            var keep = {};
            ['content-type', 'content-range'].forEach(function (k) { var v = res.headers.get(k); if (v) keep[k] = v; });
            snapStore.set(key, { text: text, headers: keep, ts: nowMs() });
          }
        } catch (e) {}
      }
      return res;
    }

    // ── writes ────────────────────────────────────────────────────────────
    async function handleWrite(url, init) {
      if (!isOnline() || readQueue().length) return enqueue(url, init);
      try {
        var res = await underlying(url, init);
        return res;
      } catch (e) {
        if (isNetworkError(e)) return enqueue(url, init);
        throw e;
      }
    }

    function fetchWrapped(url, init) {
      init = init || {};
      var u = (url && typeof url === 'object' && url.url) ? url.url : String(url);
      if (!shouldHandle(u, init)) return underlying(url, init);
      var method = String(init.method || (url && url.method) || 'GET').toUpperCase();
      if (WRITE[method]) return handleWrite(u, init);
      if (method === 'GET' || method === 'HEAD') return handleRead(u, init);
      return underlying(url, init);
    }

    // ── wiring ────────────────────────────────────────────────────────────
    function attach() {
      if (typeof window === 'undefined') return;
      window.addEventListener('online', function () { retryCount = 0; flush(); });
      window.addEventListener('offline', function () { notify(); });
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') flush(); });
      }
      notify();
      flushSoon(0);
    }

    return {
      VERSION: VERSION,
      name: name,
      fetch: fetchWrapped,
      enqueue: function (url, init) { return enqueue(url, init); },
      flush: flush,
      resume: resume,
      state: state,
      pending: function () { return readQueue(); },
      dead: function () { return readDead(); },
      clearDead: function () { writeDead([]); notify(); },
      isQueued: isQueued,
      isOnline: isOnline,
      snapshotKey: snapshotKey,
      attach: attach,
      _keys: { outbox: KEY, dead: DEAD_KEY },
    };
  }

  return { create: create, VERSION: VERSION, snapshotKey: snapshotKey, isNetworkError: isNetworkError };
});
