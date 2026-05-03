// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
/**
 * URCK Causal Engine v4.1.0 — Browser Extension Bundle
 * Bundled for Firefox MV2 (no ES module imports)
 * Sources: identity, time, causality, kernel, adapter layers
 */

'use strict';

// ── Identity ─────────────────────────────────────────────────────────────────

function newEventId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0'));
  return [hex.slice(0,4).join(''), hex.slice(4,6).join(''), hex.slice(6,8).join(''), hex.slice(8,10).join(''), hex.slice(10,16).join('')].join('-');
}

function shortId(id) {
  if (!id) return '?';
  const parts = id.split('-');
  return parts[parts.length - 1] || id.slice(-12);
}

function canonicalize(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalize).join(',') + ']';
  if (typeof v === 'object') {
    const keys = Object.keys(v).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalize(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

function hash64(s) {
  let h1 = 0x811c9dc5 | 0, h2 = 0xc4a6c57b | 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x01000193) ^ (h1 >>> 13);
  }
  return ((h1 >>> 0).toString(16).padStart(8, '0')) + ((h2 >>> 0).toString(16).padStart(8, '0'));
}

function contentHash(type, payload, source) {
  return hash64(canonicalize({ type, payload: payload ?? {}, source: source ?? 'unknown' }));
}

function dedupKey(type, payload, source, replayOf) {
  return contentHash(type, payload, source) + '::' + (replayOf || '');
}

// ── Time ──────────────────────────────────────────────────────────────────────

function createClock() {
  let _tick = 0, _seq = 0;
  return {
    nextTick() { return ++_tick; },
    nextSeq()  { return ++_seq;  },
    get tick() { return _tick; },
    get seq()  { return _seq;  },
    reset() { _tick = 0; _seq = 0; },
  };
}

function wallNow() { return Date.now(); }

// ── Causality ─────────────────────────────────────────────────────────────────

const EDGE_CAUSAL_EXPLICIT = 'causal/explicit';
const EDGE_CAUSAL_RULE     = 'causal/rule';
const EDGE_CAUSAL_ADAPTER  = 'causal/adapter';
const EDGE_OBSERVATIONAL   = 'observational';
const CAUSAL_EDGE_TYPES    = new Set([EDGE_CAUSAL_EXPLICIT, EDGE_CAUSAL_RULE, EDGE_CAUSAL_ADAPTER]);

function isCausalEdge(edge) { return CAUSAL_EDGE_TYPES.has(edge.edgeType); }

function createEdge(fromId, toId, edgeType, ruleName, dtTicks, confidence = 1.0) {
  if (!fromId) throw new Error('createEdge: fromId required');
  if (!toId)   throw new Error('createEdge: toId required');
  if (!CAUSAL_EDGE_TYPES.has(edgeType) && edgeType !== EDGE_OBSERVATIONAL)
    throw new Error(`createEdge: unknown edgeType '${edgeType}'`);
  return Object.freeze({ fromId, toId, edgeType, ruleName: ruleName || '', dtTicks: dtTicks || 0, confidence });
}

function createCausalStore() {
  const edgeMap    = new Map();
  const childrenMap = new Map();
  const causalChildrenMap = new Map();
  let _size = 0;
  let _cacheVersion = 0;
  const _descCache  = new Map();

  function addEdge(edge) {
    if (edgeMap.has(edge.toId)) throw new Error(`Diamond: ${edge.toId} already has parent`);
    edgeMap.set(edge.toId, edge);
    if (!childrenMap.has(edge.fromId)) childrenMap.set(edge.fromId, new Set());
    childrenMap.get(edge.fromId).add(edge.toId);
    if (isCausalEdge(edge)) {
      if (!causalChildrenMap.has(edge.fromId)) causalChildrenMap.set(edge.fromId, new Set());
      causalChildrenMap.get(edge.fromId).add(edge.toId);
    }
    _size++;
  }

  function getEdge(childId)    { return edgeMap.get(childId) || null; }
  function getChildren(parentId) { return [...(childrenMap.get(parentId) || [])]; }
  function invalidateCache()   { _cacheVersion++; }

  // Prune: remove all edges for an evicted event ID (both as child and parent)
  function prune(id) {
    // Remove as child (edge where id is toId)
    const edge = edgeMap.get(id);
    if (edge) {
      edgeMap.delete(id);
      const siblings = childrenMap.get(edge.fromId);
      if (siblings) { siblings.delete(id); if (!siblings.size) childrenMap.delete(edge.fromId); }
      const causalSiblings = causalChildrenMap.get(edge.fromId);
      if (causalSiblings) { causalSiblings.delete(id); if (!causalSiblings.size) causalChildrenMap.delete(edge.fromId); }
      _size = Math.max(0, _size - 1);
    }
    // Remove as parent (edges where id is fromId) — children become orphans
    childrenMap.delete(id);
    causalChildrenMap.delete(id);
    invalidateCache();
  }

  function traceToRoot(id, maxDepth = 50) {
    const path = []; let cur = id; let depth = 0;
    while (cur && depth < maxDepth) {
      const edge = edgeMap.get(cur);
      if (!edge || !isCausalEdge(edge)) break;
      path.push({ id: cur, edge });
      cur = edge.fromId;
      depth++;
    }
    return path;
  }

  function descendants(rootId, maxDepth = 50) {
    const cacheKey = `${rootId}:${maxDepth}:${_cacheVersion}`;
    if (_descCache.has(cacheKey)) return _descCache.get(cacheKey);
    const result = []; const queue = [[rootId, 0]]; const seen = new Set();
    while (queue.length) {
      const [id, depth] = queue.shift();
      if (seen.has(id) || depth > maxDepth) continue;
      seen.add(id);
      for (const childId of (causalChildrenMap.get(id) || [])) {
        result.push(childId); queue.push([childId, depth + 1]);
      }
    }
    if (_descCache.size > 200) _descCache.clear();
    _descCache.set(cacheKey, result);
    return result;
  }

  function clear() { edgeMap.clear(); childrenMap.clear(); causalChildrenMap.clear(); _size = 0; _descCache.clear(); }

  return { addEdge, getEdge, getChildren, invalidateCache,
    prune, traceToRoot, descendants, clear, get size() { return _size; } };
}

function createCalltoMap() {
  const map = new Map();
  let orphans = 0;
  function register(calltoId, eventId) { map.set(calltoId, eventId); }
  function resolve(calltoId) {
    const id = map.get(calltoId);
    if (!id) { orphans++; return null; }
    return id;
  }
  function clear() { map.clear(); orphans = 0; }
  return { register, resolve, clear, get orphanCount() { return orphans; } };
}

// ── Ring Buffer ───────────────────────────────────────────────────────────────

function createRingBuffer(cap) {
  const buf = new Array(cap); let head = 0, size = 0;
  function push(item) {
    const evicted = size === cap ? buf[head] : null;
    buf[head] = item;
    head = (head + 1) % cap;
    if (size < cap) size++;
    return evicted;
  }
  function get(i) {
    if (i < 0 || i >= size) return undefined;
    return buf[size < cap ? i : (head + i) % cap];
  }
  function last() { return size === 0 ? undefined : buf[(head - 1 + cap) % cap]; }
  function rangeView(start, end) {
    const s = Math.max(0, start), e = Math.min(size - 1, end);
    if (s > e) return [];
    const out = new Array(e - s + 1);
    for (let i = s; i <= e; i++) out[i - s] = get(i);
    return out;
  }
  function toArray() { const out = new Array(size); for (let i = 0; i < size; i++) out[i] = get(i); return out; }
  function findLast(fn) { for (let i = size - 1; i >= 0; i--) { const item = get(i); if (fn(item)) return item; } return null; }
  function clear() { head = 0; size = 0; }
  return { push, get, last, rangeView, toArray, findLast, clear, get length() { return size; } };
}

// ── Kernel ────────────────────────────────────────────────────────────────────

const BUILTIN_GATES = {
  DOM_STABILITY:    'gate:dom_stability',
  SESSION_BOUNDARY: 'gate:session_boundary',
  ERROR_ESCALATION: 'gate:error_escalation',
};

function createKernel({ ringCap = 10000 } = {}) {
  const ring      = createRingBuffer(ringCap);
  const idIndex   = new Map();
  const typeIndex = new Map();
  const causal    = createCausalStore();
  const callto    = createCalltoMap();
  const seenMap   = new Map();
  const clock     = createClock();
  const macros    = [];
  const _macroWindow = ['','','',''];
  let _macroWindowHead = 0;
  const _macroCounts = new Map();
  const MACRO_WINDOW = 4, MACRO_THRESHOLD = 3;
  const listeners = [];
  let droppedCount = 0, _gateDepth = 0, _version = 0;
  const GATE_DEPTH_MAX = 20;

  function _addToTypeIndex(type, id) {
    if (!typeIndex.has(type)) typeIndex.set(type, []);
    typeIndex.get(type).push(id);
  }

  function _advanceMacroWindow(type) {
    _macroWindow[_macroWindowHead] = type;
    _macroWindowHead = (_macroWindowHead + 1) % MACRO_WINDOW;
  }

  function _getMacroWindow(len) {
    const out = [], count = Math.min(len, MACRO_WINDOW);
    for (let i = count; i >= 1; i--) {
      const idx = ((_macroWindowHead - i) + MACRO_WINDOW * 100) % MACRO_WINDOW;
      if (_macroWindow[idx]) out.push(_macroWindow[idx]);
    }
    return out;
  }

  function _updateMacroProjection(ev) {
    _advanceMacroWindow(ev.type);
    for (let len = 2; len <= MACRO_WINDOW; len++) {
      const window = _getMacroWindow(len);
      if (window.length < len) continue;
      const key = window.join(' → ');
      const prev = _macroCounts.get(key) || 0, next = prev + 1;
      _macroCounts.set(key, next);
      if (next === MACRO_THRESHOLD) {
        if (!macros.find(m => m.pattern === key)) {
          macros.push({ id: newEventId(), pattern: key, count: next, firstSeenSeq: ev.seq, eventTs: ev.eventTs, triggerEventId: ev.id });
        }
      } else if (next > MACRO_THRESHOLD) {
        const m = macros.find(m => m.pattern === key);
        if (m) m.count = next;
      }
    }
  }

  function ingest(type, payload, meta = {}) {
    const isReplay = !!meta.replayOf;
    if (isReplay) {
      const dk = dedupKey(type, payload, meta.source, meta.replayOf);
      if (seenMap.has(dk)) { droppedCount++; return seenMap.get(dk); }
    }

    const evEventTs = (meta.origEventTs != null) ? meta.origEventTs : clock.nextTick();
    const ev = Object.freeze({
      id: newEventId(), seq: clock.nextSeq(), ts: wallNow(), eventTs: evEventTs,
      type, payload: Object.freeze(payload ?? {}),
      causedBy: meta.causedBy || null, edgeType: meta.edgeType || null,
      source: meta.source || 'guardian', sessionId: meta.sessionId || null,
      tabId: meta.tabId || null, srcBusName: meta.srcBusName || null,
      replayOf: meta.replayOf || null,
      contentHash: contentHash(type, payload, meta.source),
    });

    const evicted = ring.push(ev);
    if (evicted) {
      idIndex.delete(evicted.id);
      // Prune typeIndex — remove evicted ID to prevent unbounded growth
      const bucket = typeIndex.get(evicted.type);
      if (bucket) {
        const pos = bucket.indexOf(evicted.id);
        if (pos >= 0) bucket.splice(pos, 1);
        if (bucket.length === 0) typeIndex.delete(evicted.type);
      }
      // Prune causal edges for evicted event
      causal.prune(evicted.id);
    }
    idIndex.set(ev.id, ev);
    _addToTypeIndex(ev.type, ev.id);
    if (isReplay) {
      seenMap.set(dedupKey(type, payload, meta.source, meta.replayOf), ev);
      // Cap seenMap to prevent unbounded growth
      if (seenMap.size > 500) {
        const firstKey = seenMap.keys().next().value;
        seenMap.delete(firstKey);
      }
    }
    _version++;

    if (ev.causedBy) {
      const parent = idIndex.get(ev.causedBy);
      if (parent) {
        const et = ev.edgeType || (ev.source?.startsWith('gate:') ? EDGE_CAUSAL_RULE : EDGE_CAUSAL_EXPLICIT);
        try {
          causal.addEdge(createEdge(parent.id, ev.id, et, ev.source || '', ev.eventTs - parent.eventTs,
            et === EDGE_CAUSAL_RULE || et === EDGE_CAUSAL_ADAPTER ? 1.0 : 0.9));
          causal.invalidateCache();
        } catch {}
      }
    }

    _updateMacroProjection(ev);
    _runGates(ev);
    for (const L of listeners) { try { L(ev); } catch {} }
    return ev;
  }

  function _runGates(ev) {
    if (_gateDepth >= GATE_DEPTH_MAX) return;
    _gateDepth++;
    try {
      if (ev.type === 'command:failed') {
        const r = (ev.payload.retryCount || ev.payload.retries) || 0;
        if (r >= 3) ingest('alert:critical', { reason: 'command_max_retries', originalId: ev.id, retries: r }, { source: BUILTIN_GATES.ERROR_ESCALATION, causedBy: ev.id, edgeType: EDGE_CAUSAL_RULE });
      }
      if (ev.type === 'page:navigated') {
        const p = ev.payload;
        ingest('session:boundary', { from: p.from, to: p.to, trigger: 'navigation' }, { source: BUILTIN_GATES.SESSION_BOUNDARY, causedBy: ev.id, edgeType: EDGE_CAUSAL_RULE });
      }
    } finally { _gateDepth--; }
  }

  function findById(id)           { return idIndex.get(id) || null; }
  function rangeView(start, end)  { return ring.rangeView(start, end); }
  function getAll()               { return ring.toArray(); }
  function traceToRoot(id, max)   { return causal.traceToRoot(id, max); }
  function descendants(id, max)   { return causal.descendants(id, max); }
  function edgeMeta(childId)      { return causal.getEdge(childId); }
  function getChildren(id)        { return causal.getChildren(id); }
  function subscribe(fn)          { listeners.push(fn); return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }; }
  function registerCallto(id, ev) { callto.register(id, ev); }
  function resolveCallto(id)      { return callto.resolve(id); }

  function reset() {
    ring.clear(); idIndex.clear(); typeIndex.clear(); causal.clear(); callto.clear();
    seenMap.clear(); clock.reset(); macros.length = 0; _macroCounts.clear();
    _macroWindow.fill(''); _macroWindowHead = 0; droppedCount = 0; _gateDepth = 0; _version = 0;
  }

  // Guardian-specific convenience: filter by capture flag
  function captures() {
    return ring.toArray().filter(e => {
      const def = GUARDIAN_EVENT_TYPES[e.type];
      return def && def.capture === true;
    });
  }

  // Query helper
  function query(filter = {}) {
    return ring.toArray().filter(e => {
      if (filter.type   && e.type   !== filter.type)   return false;
      if (filter.since  && e.ts     <  filter.since)   return false;
      if (filter.tabId  && e.tabId  !== filter.tabId)  return false;
      if (filter.source && e.source !== filter.source) return false;
      return true;
    });
  }

  function last(type) { return ring.findLast(e => e.type === type); }

  return {
    ingest, findById, rangeView, getAll, captures, query, last,
    traceToRoot, descendants, edgeMeta, getChildren,
    subscribe, reset, registerCallto, resolveCallto,
    get length()       { return ring.length; },
    get version()      { return _version; },
    get droppedCount() { return droppedCount; },
    get macros()       { return macros; },
    get edgeCount()    { return causal.size; },
    get calltoOrphans(){ return callto.orphanCount; },
    get clock()        { return clock; },
  };
}

// ── Guardian event type registry ──────────────────────────────────────────────

const GUARDIAN_EVENT_TYPES = {
  'guardian.picker.start':       { capture: false },
  'guardian.picker.capture':     { capture: true  },
  'guardian.picker.stop':        { capture: false },
  'guardian.cookies.capture':    { capture: true  },
  'guardian.ig.dm':              { capture: true  },
  'guardian.ig.post':            { capture: true  },
  'guardian.threads.post':       { capture: true  },
  'guardian.chat.message':       { capture: true  },
  'guardian.chat.response':      { capture: true  },
  'guardian.session.connect':    { capture: false },
  'guardian.session.disconnect': { capture: false },
  'guardian.tab.navigate':       { capture: false },
  'guardian.voice.save':         { capture: true  },
  'guardian.bridge.callto':      { capture: true  },
  'guardian.bridge.result':      { capture: true  },
};

// ── Singleton URCK kernel for Guardian ────────────────────────────────────────

const URCK = createKernel({ ringCap: 10000 });

// Expose for background, content, popup
if (typeof window    !== 'undefined') window.URCK    = URCK;
if (typeof globalThis !== 'undefined') globalThis.URCK = URCK;

// Also expose helpers
if (typeof window !== 'undefined') {
  window.URCK_shortId          = shortId;
  window.URCK_GUARDIAN_EVENTS  = GUARDIAN_EVENT_TYPES;
  window.EDGE_CAUSAL_EXPLICIT  = EDGE_CAUSAL_EXPLICIT;
  window.EDGE_CAUSAL_RULE      = EDGE_CAUSAL_RULE;
  window.EDGE_CAUSAL_ADAPTER   = EDGE_CAUSAL_ADAPTER;
}
