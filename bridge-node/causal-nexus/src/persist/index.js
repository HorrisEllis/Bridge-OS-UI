// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
/**
 * @module       persist
 * @uuid         fde4fdbd-4c51-4e92-a5d2-fca39a348762
 * @version      5.0.0
 *
 * Persistence layer — events survive kernel.reset() and process restart.
 *
 * Three storage tiers:
 *   HOT   — kernel ring buffer (in-memory, O(1), bounded by ringCap)
 *   WARM  — WAL: append-only, one batch per N ingests. Replay on restart.
 *   COLD  — archive: ring-evicted events moved here instead of discarded.
 *
 * Three backends with identical async API:
 *   memory      — in-process, no persistence (tests, development)
 *   indexeddb   — browser: survives page refresh
 *   filesystem  — Node.js: append-only JSONL in configurable directory
 *
 * Design laws:
 *   - Kernel ring buffer is never modified by persist (read-only projection)
 *   - Archive events are immutable once written
 *   - WAL is append-only — existing entries never overwritten
 *   - Recovery ingests via kernel.ingest() with replayOf — dedup applies
 *   - No causal edges inferred from archive — edges replayed as-is
 *
 * KNOWN ISSUE (archiveEvicted): The wiring described in the archiveEvicted
 * docstring requires a kernel eviction hook that passes the evicted event
 * object. The current kernel only emits system:ring:evicted with { cap, evictedSeq }
 * — not the event object itself. To use archiveEvicted, intercept ring evictions
 * at the application layer, maintain a side-channel reference to the last-evicted
 * event, and pass it to archiveEvicted() from there.
 *
 * @hook 0a729534-56d1-4884-b47a-a738359deca4  createStore
 * @hook 9b61f864-491d-49c0-8a85-b6a5d29096f4  flushStore
 * @hook df1e5b04-d887-4a1d-ae05-b40645fe8e26  recoverStore
 * @hook 6c3e50dc-64f3-4850-8092-09738c38adbc  archiveEvicted
 * @hook 31be7ae8-e365-4773-b0a0-53cc1ca2819c  queryArchive
 * @hook 17d5158f-3ac2-4cf1-9431-ce0a2645b84a  StoreConfig
 */

'use strict';

// ── Default configuration ─────────────────────────────────────────────────────

/** @hook 17d5158f-3ac2-4cf1-9431-ce0a2645b84a  persist:StoreConfig */
export const StoreConfig = {
  defaults: {
    walFlushEvery:   100,
    snapshotEvery:   10_000,
    archiveMaxBytes: 50_000_000,
    archiveCompact:  true,
    backend:         'auto',
    walKey:          'causal-nexus:wal',
    archiveKey:      'causal-nexus:archive',
    snapshotKey:     'causal-nexus:snapshot',
  },
};

// ── Backend detection ─────────────────────────────────────────────────────────

function detectBackend(preference) {
  if (preference === 'memory')     return 'memory';
  if (preference === 'indexeddb')  return typeof indexedDB !== 'undefined' ? 'indexeddb' : 'memory';
  if (preference === 'filesystem') return (typeof process !== 'undefined' && process.versions?.node) ? 'filesystem' : 'memory';
  if (typeof indexedDB !== 'undefined') return 'indexeddb';
  if (typeof process  !== 'undefined' && process.versions?.node) return 'filesystem';
  return 'memory';
}

// ── Memory backend ────────────────────────────────────────────────────────────

function createMemoryBackend() {
  const wal     = [];
  const archive = [];
  let   snap    = null;

  return {
    name: 'memory',
    async appendWAL(batchId, events)       { wal.push({ batchId, ts: Date.now(), events: events.map(e => ({ ...e })) }); },
    async readWAL()                         { return wal.flatMap(b => b.events); },
    async clearWAL()                        { wal.length = 0; },
    async writeSnapshot(s)                  { snap = JSON.parse(JSON.stringify(s)); },
    async readSnapshot()                    { return snap ? JSON.parse(JSON.stringify(snap)) : null; },
    async appendArchive(events)             { for (const e of events) archive.push(Object.freeze({ ...e })); },
    async queryArchiveRaw({ type, tsStart, tsEnd, contentHash, limit = 1000 }) {
      let r = archive;
      if (type)        r = r.filter(e => e.type === type);
      if (tsStart)     r = r.filter(e => e.ts >= tsStart);
      if (tsEnd)       r = r.filter(e => e.ts <= tsEnd);
      if (contentHash) r = r.filter(e => e.contentHash === contentHash);
      return r.slice(0, limit);
    },
    async archiveSize() { return archive.length; },
    stats() { return { walBatches: wal.length, archiveEvents: archive.length, hasSnapshot: !!snap }; },
  };
}

// ── IndexedDB backend ─────────────────────────────────────────────────────────

function createIndexedDBBackend(config) {
  const DB_NAME    = config.walKey || 'causal-nexus';
  const DB_VERSION = 1;
  let   _db        = null;

  async function getDB() {
    if (_db) return _db;
    return new Promise((resolve, reject) => {
      const req         = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('wal'))      db.createObjectStore('wal',      { keyPath: 'batchId' });
        if (!db.objectStoreNames.contains('archive'))  db.createObjectStore('archive',  { autoIncrement: true });
        if (!db.objectStoreNames.contains('snapshot')) db.createObjectStore('snapshot', { keyPath: 'id' });
      };
      req.onsuccess = e => { _db = e.target.result; resolve(_db); };
      req.onerror   = e => reject(e.target.error);
    });
  }

  async function txn(store, mode, fn) {
    const db = await getDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(store, mode);
      const obj = tx.objectStore(store);
      const req = fn(obj);
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
  }

  async function getAll(store) {
    const db = await getDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(store, 'readonly');
      const obj = tx.objectStore(store);
      const req = obj.getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
  }

  return {
    name: 'indexeddb',
    async appendWAL(batchId, events)   { await txn('wal', 'readwrite', s => s.put({ batchId, ts: Date.now(), events })); },
    async readWAL()                     { const b = await getAll('wal'); b.sort((a,b)=>a.ts-b.ts); return b.flatMap(b=>b.events); },
    async clearWAL()                    { await txn('wal', 'readwrite', s => s.clear()); },
    async writeSnapshot(s)              { await txn('snapshot', 'readwrite', o => o.put({ id: 'latest', snap: s, ts: Date.now() })); },
    async readSnapshot()                { try { const r = await txn('snapshot','readonly',o=>o.get('latest')); return r?.snap||null; } catch { return null; } },
    async appendArchive(events) {
      const db = await getDB();
      return new Promise((resolve, reject) => {
        const tx  = db.transaction('archive', 'readwrite');
        const obj = tx.objectStore('archive');
        for (const e of events) obj.add(e);
        tx.oncomplete = resolve;
        tx.onerror    = () => reject(tx.error);
      });
    },
    async queryArchiveRaw({ type, tsStart, tsEnd, contentHash, limit = 1000 }) {
      const all = await getAll('archive');
      let r = all;
      if (type)        r = r.filter(e => e.type === type);
      if (tsStart)     r = r.filter(e => e.ts >= tsStart);
      if (tsEnd)       r = r.filter(e => e.ts <= tsEnd);
      if (contentHash) r = r.filter(e => e.contentHash === contentHash);
      return r.slice(0, limit);
    },
    async archiveSize() { const all = await getAll('archive'); return all.length; },
    stats() { return { backend: 'indexeddb' }; },
  };
}

// ── Filesystem backend ────────────────────────────────────────────────────────

function createFilesystemBackend(config) {
  let fs, path;
  try { fs = require('fs'); path = require('path'); }
  catch { return createMemoryBackend(); }

  const base     = config.storePath || path.join(process.cwd(), '.causal-nexus');
  const walPath  = path.join(base, 'wal.jsonl');
  const snapPath = path.join(base, 'snapshot.json');
  const archPath = path.join(base, 'archive.jsonl');

  try { fs.mkdirSync(base, { recursive: true }); } catch {}

  function appendLine(file, obj) { fs.appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8'); }
  function readLines(file) {
    try { return fs.readFileSync(file,'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l)); }
    catch { return []; }
  }

  return {
    name: 'filesystem',
    async appendWAL(batchId, events)   { appendLine(walPath, { batchId, ts: Date.now(), events }); },
    async readWAL()                     { return readLines(walPath).flatMap(b => b.events || []); },
    async clearWAL()                    { try { fs.writeFileSync(walPath,'','utf8'); } catch {} },
    async writeSnapshot(s)              { fs.writeFileSync(snapPath, JSON.stringify(s), 'utf8'); },
    async readSnapshot()                { try { return JSON.parse(fs.readFileSync(snapPath,'utf8')); } catch { return null; } },
    async appendArchive(events)         { for (const e of events) appendLine(archPath, e); },
    async queryArchiveRaw({ type, tsStart, tsEnd, contentHash, limit = 1000 }) {
      let r = readLines(archPath);
      if (type)        r = r.filter(e => e.type === type);
      if (tsStart)     r = r.filter(e => e.ts >= tsStart);
      if (tsEnd)       r = r.filter(e => e.ts <= tsEnd);
      if (contentHash) r = r.filter(e => e.contentHash === contentHash);
      return r.slice(0, limit);
    },
    async archiveSize() { return readLines(archPath).length; },
    stats() {
      return { backend: 'filesystem', base, hasWal: fs.existsSync(walPath), hasSnap: fs.existsSync(snapPath), hasArch: fs.existsSync(archPath) };
    },
  };
}

// ── createStore ───────────────────────────────────────────────────────────────

/**
 * Create a persistence store for a kernel instance.
 *
 * @param {object} kernel
 * @param {object} [opts]
 * @hook 0a729534-56d1-4884-b47a-a738359deca4  persist:createStore
 */
export function createStore(kernel, opts = {}) {
  const config  = { ...StoreConfig.defaults, ...opts };
  const backend = (() => {
    const name = detectBackend(config.backend);
    if (name === 'indexeddb')  return createIndexedDBBackend(config);
    if (name === 'filesystem') return createFilesystemBackend(config);
    return createMemoryBackend();
  })();

  let   _batchId   = 0;
  let   _sinceSnap = 0;
  const _pending   = [];

  const _unsub = kernel.subscribe(ev => {
    _pending.push(ev);
    if (_pending.length >= config.walFlushEvery) {
      flushStore(kernel, store).catch(() => {});
    }
  });

  const store = {
    backend, config,
    get pendingCount() { return _pending.length; },
    get batchId()      { return _batchId; },
    async _drain() {
      if (!_pending.length) return;
      const batch = _pending.splice(0);
      _batchId++;
      await backend.appendWAL(String(_batchId), batch);
    },
    _snapshotDue()    { return (kernel.version - _sinceSnap) >= config.snapshotEvery; },
    _snapshotWritten(){ _sinceSnap = kernel.version; },
    destroy()         { _unsub(); },
  };

  return store;
}

// ── flushStore ────────────────────────────────────────────────────────────────

/**
 * Flush WAL. If snapshot is due, write snapshot and clear WAL.
 * @hook 9b61f864-491d-49c0-8a85-b6a5d29096f4  persist:flushStore
 */
export async function flushStore(kernel, store) {
  await store._drain();

  let snapshotWritten = false;
  if (store._snapshotDue()) {
    try {
      // Dynamic import avoids circular dependency at load time
      const { snapshot } = await import('../compress/index.js');
      const snap         = snapshot(kernel);
      await store.backend.writeSnapshot(snap);
      await store.backend.clearWAL();
      store._snapshotWritten();
      snapshotWritten = true;
    } catch (e) {
      kernel.ingest('nexus:persist:snapshot:failed', { error: e.message }, { source: 'persist:flushStore' });
    }
  }

  kernel.ingest('nexus:persist:flushed', {
    batchId: store.batchId, pending: 0, snapshotWritten, backend: store.backend.name,
  }, { source: 'persist:flushStore' });

  return { walEntries: store.batchId, snapshotWritten };
}

// ── recoverStore ──────────────────────────────────────────────────────────────

/**
 * Recover a kernel from persistent storage on startup.
 * Sequence: snapshot restore → WAL replay → dedup handles overlap.
 * @hook df1e5b04-d887-4a1d-ae05-b40645fe8e26  persist:recoverStore
 */
export async function recoverStore(store, kernel) {
  let snapshotEvents = 0, walReplayed = 0;
  const errors = [];
  let   recoveredFromSnapshot = false;

  // 1. Try snapshot
  try {
    const snap = await store.backend.readSnapshot();
    if (snap) {
      const { restore } = await import('../compress/index.js');
      const restored    = restore(snap);
      for (const ev of restored.getAll()) {
        try {
          kernel.ingest(ev.type, ev.payload, {
            source: ev.source, sessionId: ev.sessionId, srcBusName: ev.srcBusName,
            origEventTs: ev.eventTs, replayOf: ev.id, causedBy: ev.causedBy, edgeType: ev.edgeType,
          });
          snapshotEvents++;
        } catch (e) { errors.push({ phase: 'snapshot', type: ev.type, error: e.message }); }
      }
      recoveredFromSnapshot = true;
    }
  } catch (e) { errors.push({ phase: 'snapshot-read', error: e.message }); }

  // 2. Replay WAL — dedup suppresses events already in snapshot
  try {
    const walEvents = await store.backend.readWAL();
    for (const ev of walEvents) {
      try {
        kernel.ingest(ev.type, ev.payload, {
          source: ev.source, sessionId: ev.sessionId, srcBusName: ev.srcBusName,
          origEventTs: ev.eventTs, replayOf: ev.id, causedBy: ev.causedBy, edgeType: ev.edgeType,
        });
        walReplayed++;
      } catch (e) { errors.push({ phase: 'wal', type: ev.type, error: e.message }); }
    }
  } catch (e) { errors.push({ phase: 'wal-read', error: e.message }); }

  const result = {
    ok: errors.length === 0, snapshotEvents, walReplayed,
    totalRecovered: snapshotEvents + walReplayed, recoveredFromSnapshot, errors,
  };

  kernel.ingest('nexus:persist:recovered', { ...result, errorCount: errors.length }, { source: 'persist:recoverStore' });
  return result;
}

// ── archiveEvicted ────────────────────────────────────────────────────────────

/**
 * Move ring-evicted events to cold archive.
 *
 * See module docstring for the known wiring limitation with the current kernel.
 *
 * @hook 6c3e50dc-64f3-4850-8092-09738c38adbc  persist:archiveEvicted
 */
export async function archiveEvicted(store, events) {
  if (!events?.length) return;
  await store.backend.appendArchive(events);
}

// ── queryArchive ──────────────────────────────────────────────────────────────

/**
 * Query the cold event archive. O(n) scan — no secondary indexes.
 * For hot queries use kernel's idIndex and typeIndex.
 *
 * @hook 31be7ae8-e365-4773-b0a0-53cc1ca2819c  persist:queryArchive
 */
export async function queryArchive(store, filter = {}) {
  return store.backend.queryArchiveRaw(filter);
}
