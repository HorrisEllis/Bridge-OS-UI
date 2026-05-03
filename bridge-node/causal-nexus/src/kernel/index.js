// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
/**
 * @module       kernel
 * @uuid         5d90c63d-c55f-43e8-bc2e-169b960fddd9
 * @version      5.0.0
 *
 * The single source of truth. Append-only event ring with bounded memory,
 * causal graph, gate system, and macro projection.
 *
 * Pipeline order (C-4 enforced — gates fire BEFORE listeners):
 *   1. Dedup (replay path only, H-6 LRU-bounded)
 *   2. Build + freeze event
 *   3. Store in ring + indexes (H-2 O(1) Set, H-1 edge pruning on eviction)
 *   4. Build causal edge
 *   5. Update macro projection (H-4 O(1) macrosByPattern Map)
 *   6. Run gates (A-2 atomic output collection; depth-guarded by GATE_DEPTH_MAX=20)
 *   6b. Expire stale calltos (K-4)
 *   7. Notify listeners
 *
 * Hostile hardening applied (all proven with measurements — see CHANGELOG):
 *   H-1  pruneEdgesFor on every ring eviction — edge graph bounded
 *   H-2  typeIndex uses Set<id> — O(1) add/delete/has
 *   H-3  query.typeIds() returns Array.from(set) — defensive copy
 *   H-4  macrosByPattern Map for O(1) macro lookup
 *   H-5  query API exposes clock.tick value, not live clock object
 *   H-6  seenMap LRU-capped at MAX_SEEN_MAP=10,000
 *
 * @hook ef1a2535-a366-48cd-a325-c1c98b91ca3c  createKernel
 * @hook 186a1b79-5b6e-4922-91a1-b243ec3eec57  gateOutput
 * @hook 2569f54c-41e0-447f-9145-76e72a96f82e  BUILTIN_GATES
 */

import { newEventId, contentHash, dedupKey } from '../identity/index.js';
import { createClock, wallNow }              from '../time/index.js';
import {
  createEdge, createCausalStore, createCalltoMap,
  EDGE_CAUSAL_EXPLICIT, EDGE_CAUSAL_RULE, EDGE_CAUSAL_ADAPTER,
  isCausalEdge,
} from '../causality/index.js';

// ── Ring Buffer ───────────────────────────────────────────────────────────────

function createRingBuffer(cap) {
  const buf = new Array(cap);
  let head = 0;
  let size = 0;

  function push(item) {
    const evicted = size === cap ? buf[head] : null;
    buf[head] = item;
    head = (head + 1) % cap;
    if (size < cap) size++;
    return evicted;
  }

  function get(logicalIdx) {
    if (logicalIdx < 0 || logicalIdx >= size) return undefined;
    return buf[size < cap ? logicalIdx : (head + logicalIdx) % cap];
  }

  function last() {
    return size === 0 ? undefined : buf[(head - 1 + cap) % cap];
  }

  function rangeView(start, end) {
    const s = Math.max(0, start);
    const e = Math.min(size - 1, end);
    if (s > e) return [];
    const out = new Array(e - s + 1);
    for (let i = s; i <= e; i++) out[i - s] = get(i);
    return out;
  }

  function toArray() {
    const out = new Array(size);
    for (let i = 0; i < size; i++) out[i] = get(i);
    return out;
  }

  function findLast(fn) {
    for (let i = size - 1; i >= 0; i--) {
      const item = get(i);
      if (fn(item)) return item;
    }
    return null;
  }

  function clear() { head = 0; size = 0; }

  return {
    push, get, last, rangeView, toArray, findLast, clear,
    get length() { return size; },
  };
}

// ── Gate output descriptor ────────────────────────────────────────────────────

/**
 * Construct a GateOutput descriptor.
 * Gates return GateOutput[] — they never call ingest() directly (A-2).
 * The kernel applies all outputs atomically after all gates have run.
 *
 * @hook 186a1b79-5b6e-4922-91a1-b243ec3eec57  kernel:gateOutput
 */
export function gateOutput(type, payload, meta) {
  return Object.freeze({
    type,
    payload: Object.freeze(payload || {}),
    meta:    Object.freeze(meta    || {}),
  });
}

// ── Built-in gate names and priorities ───────────────────────────────────────

/**
 * @hook 2569f54c-41e0-447f-9145-76e72a96f82e  kernel:BUILTIN_GATES
 */
export const BUILTIN_GATES = {
  DOM_STABILITY:    'gate:dom_stability',
  SESSION_BOUNDARY: 'gate:session_boundary',
  ERROR_ESCALATION: 'gate:error_escalation',
};

const BUILTIN_PRIORITY = {
  [BUILTIN_GATES.ERROR_ESCALATION]: 10,
  [BUILTIN_GATES.DOM_STABILITY]:    20,
  [BUILTIN_GATES.SESSION_BOUNDARY]: 30,
};

const DEFAULT_CUSTOM_PRIORITY = 50;

// ── Kernel factory ────────────────────────────────────────────────────────────

/**
 * @hook ef1a2535-a366-48cd-a325-c1c98b91ca3c  kernel:createKernel
 *
 * @param {object} [opts]
 *   opts.ringCap        {number}  Ring buffer capacity (default 5_000_000)
 *   opts.calltoTtlTicks {number}  Ticks before unresolved calltos expire (0=disabled)
 */
export function createKernel({
  ringCap        = 5_000_000,
  calltoTtlTicks = 0,
} = {}) {

  const ring    = createRingBuffer(ringCap);
  const idIndex = new Map();

  // H-2: typeIndex uses Set<id> per type — O(1) add/delete/has
  const typeIndex = new Map();    // type → Set<eventId>

  const causal  = createCausalStore();
  const callto  = createCalltoMap({ ttlTicks: calltoTtlTicks });

  // H-6: seenMap LRU-bounded at MAX_SEEN_MAP entries
  const seenMap     = new Map();
  const MAX_SEEN_MAP = 10_000;

  const clock = createClock();

  // Macro projection — H-4: macrosByPattern for O(1) lookup
  const macros          = [];
  const macrosByPattern = new Map();
  const _macroWindow    = ['', '', '', ''];
  let   _macroWindowHead = 0;
  const _macroCounts    = new Map();
  const MACRO_WINDOW    = 4;
  const MACRO_THRESHOLD = 3;

  const listeners = [];
  let   droppedCount = 0;
  let   _version     = 0;

  const GATE_DEPTH_MAX = 20;

  // K-1/K-2: Gate registry — builtins + custom, sorted by priority
  const _gateRegistry = [];
  let   _gatesNeedSort    = true;
  let   _gateOutputDepth  = 0;  // K-5: counter, not binary flag

  // ── Private helpers ───────────────────────────────────────────────────────

  // H-2: O(1) add
  function _addToTypeIndex(type, id) {
    if (!typeIndex.has(type)) typeIndex.set(type, new Set());
    typeIndex.get(type).add(id);
  }

  // H-2 + K-3: O(1) delete from typeIndex Set
  function _pruneTypeIndex(evictedId, evictedType) {
    const s = typeIndex.get(evictedType);
    if (!s) return;
    s.delete(evictedId);
    if (s.size === 0) typeIndex.delete(evictedType);
  }

  function _advanceMacroWindow(type) {
    _macroWindow[_macroWindowHead] = type;
    _macroWindowHead = (_macroWindowHead + 1) % MACRO_WINDOW;
  }

  function _getMacroWindow(len) {
    const out   = [];
    const count = Math.min(len, MACRO_WINDOW);
    for (let i = count; i >= 1; i--) {
      const idx = ((_macroWindowHead - i) + MACRO_WINDOW * 100) % MACRO_WINDOW;
      if (_macroWindow[idx]) out.push(_macroWindow[idx]);
    }
    return out;
  }

  // H-4: macrosByPattern Map replaces macros.find() — O(1) lookup
  function _updateMacroProjection(ev) {
    _advanceMacroWindow(ev.type);
    for (let len = 2; len <= MACRO_WINDOW; len++) {
      const window = _getMacroWindow(len);
      if (window.length < len) continue;
      const key  = window.join(' → ');
      const prev = _macroCounts.get(key) || 0;
      const next = prev + 1;
      _macroCounts.set(key, next);
      if (next === MACRO_THRESHOLD) {
        if (!macrosByPattern.has(key)) {
          const m = {
            id:               newEventId(),
            pattern:          key,
            count:            next,
            firstSeenSeq:     ev.seq,
            firstSeenEventId: ev.id,
            eventTs:          ev.eventTs,
            triggerEventId:   ev.id,
          };
          macros.push(m);
          macrosByPattern.set(key, m);
        } else {
          macrosByPattern.get(key).count = next;
        }
      } else if (next > MACRO_THRESHOLD) {
        const m = macrosByPattern.get(key);
        if (m) m.count = next;
      }
    }
  }

  // ── Gate machinery ────────────────────────────────────────────────────────

  function _getSortedGates() {
    if (_gatesNeedSort) {
      _gateRegistry.sort((a, b) => a.priority - b.priority);
      _gatesNeedSort = false;
    }
    return _gateRegistry;
  }

  // H-3: typeIds returns Array.from(set) — snapshot not live reference
  // H-5: exposes clock.tick value, not the live clock object
  function _makeQueryApi() {
    return {
      findById:    (id)   => idIndex.get(id) || null,
      getChildren: (id)   => causal.getChildren(id),
      edgeMeta:    (id)   => causal.getEdge(id),
      typeIds:     (type) => {
        const s = typeIndex.get(type);
        return s ? Array.from(s) : [];   // H-3: defensive copy
      },
      currentTick: clock.tick,           // H-5: value, not object
    };
  }

  // ── Built-in gates ────────────────────────────────────────────────────────
  // Pure functions: receive (ev, query), return GateOutput[]. Never call ingest.

  function _builtinErrorEscalation(ev) {
    if (ev.type !== 'command:failed') return [];
    const r = (ev.payload.retryCount || ev.payload.retries) || 0;
    if (r < 3) return [];
    return [gateOutput('alert:critical', {
      reason: 'command_max_retries', originalId: ev.id, retries: r,
    }, { source: BUILTIN_GATES.ERROR_ESCALATION, causedBy: ev.id, edgeType: EDGE_CAUSAL_RULE })];
  }

  function _builtinDomStability(ev, query) {
    if (ev.type !== 'dom:changed') return [];
    const windowStart = ev.eventTs - 500;
    const domIds      = query.typeIds('dom:changed'); // H-3: safe copy
    const recent      = [];
    for (let i = domIds.length - 1; i >= 0; i--) {
      const e = query.findById(domIds[i]);
      if (!e) continue;
      if (e.eventTs < windowStart) break;
      if (e.eventTs <= ev.eventTs) recent.push(e);
    }
    if (recent.length < 5) return [];
    const unstableIds = query.typeIds('dom:unstable');
    if (unstableIds.length) {
      const lastUnstable = query.findById(unstableIds[unstableIds.length - 1]);
      if (lastUnstable && (ev.eventTs - lastUnstable.eventTs) <= 500) return [];
    }
    return [gateOutput('dom:unstable', {
      burstCount:     recent.length,
      windowTicks:    500,
      memberIds:      recent.map(e => e.id),
      targets:        [...new Set(recent.map(e => e.payload.selector).filter(Boolean))],
      classification: recent.length >= 10 ? 'render_storm' : 'render_burst',
    }, { source: BUILTIN_GATES.DOM_STABILITY, causedBy: ev.id, edgeType: EDGE_CAUSAL_RULE })];
  }

  function _builtinSessionBoundary(ev) {
    if (ev.type !== 'page:navigated') return [];
    const p = ev.payload;
    return [gateOutput('session:boundary', { from: p.from, to: p.to, trigger: 'navigation' }, {
      source: BUILTIN_GATES.SESSION_BOUNDARY, causedBy: ev.id, edgeType: EDGE_CAUSAL_RULE,
    })];
  }

  _gateRegistry.push(
    { signature: BUILTIN_GATES.ERROR_ESCALATION, fn: _builtinErrorEscalation, priority: BUILTIN_PRIORITY[BUILTIN_GATES.ERROR_ESCALATION], builtin: true },
    { signature: BUILTIN_GATES.DOM_STABILITY,    fn: _builtinDomStability,    priority: BUILTIN_PRIORITY[BUILTIN_GATES.DOM_STABILITY],    builtin: true },
    { signature: BUILTIN_GATES.SESSION_BOUNDARY, fn: _builtinSessionBoundary, priority: BUILTIN_PRIORITY[BUILTIN_GATES.SESSION_BOUNDARY], builtin: true },
  );

  // ── A-2: Atomic gate output application ──────────────────────────────────

  function _runGates(ev) {
    if (_gateOutputDepth >= GATE_DEPTH_MAX) {
      _reportGateError('kernel:gates:depth', new Error(
        `Gate output depth exceeded ${GATE_DEPTH_MAX} while processing ${ev.type}.`
      ));
      return;
    }

    const query   = _makeQueryApi();
    const outputs = [];
    const gates   = _getSortedGates();

    for (const gate of gates) {
      let gateOutputs;
      try   { gateOutputs = gate.fn(ev, query); }
      catch (err) { _reportGateError(gate.signature, err); continue; }
      if (!Array.isArray(gateOutputs)) continue;
      for (const out of gateOutputs) {
        if (out && out.type) outputs.push({ output: out, sig: gate.signature });
      }
    }

    if (!outputs.length) return;

    // Apply gate outputs atomically — depth counter allows recursive gate chains
    // up to GATE_DEPTH_MAX, then terminates with system error event.
    _gateOutputDepth++;
    try {
      for (const { output: out, sig } of outputs) {
        try   { ingest(out.type, out.payload, out.meta); }
        catch (err) { _reportGateError(sig + ':apply', err); }
      }
    } finally {
      _gateOutputDepth--;
    }
  }

  // ── System event helper ───────────────────────────────────────────────────

  function _emitSystemEvent(type, payload) {
    const ev = Object.freeze({
      id:          newEventId(),
      seq:         clock.nextSeq(),
      ts:          wallNow(),
      eventTs:     clock.nextTick(),
      type,
      payload:     Object.freeze(payload || {}),
      causedBy:    null, edgeType: null,
      source:      'kernel:system', sessionId: null, tabId: null,
      srcBusName:  null, replayOf: null,
      contentHash: contentHash(type, payload, 'kernel:system'),
    });
    ring.push(ev);
    idIndex.set(ev.id, ev);
    _addToTypeIndex(ev.type, ev.id);
    _version++;
    for (const L of listeners) { try { L(ev); } catch (_) {} }
    return ev;
  }

  function _reportGateError(gate, err) {
    console.error('[URCK kernel]', gate, err);
    _emitSystemEvent('system:gate:error', { gate, message: err.message });
  }

  // ── Core ingest ───────────────────────────────────────────────────────────

  function ingest(type, payload, meta = {}) {
    const isReplay = !!meta.replayOf;

    // 1. Dedup (replay path only) — H-6: seenMap LRU-bounded
    if (isReplay) {
      const dk = dedupKey(type, payload, meta.source, meta.replayOf);
      if (seenMap.has(dk)) {
        droppedCount++;
        _emitSystemEvent('system:event:merged', {
          reason: 'replay-dedup', droppedType: type, originalId: seenMap.get(dk).id,
        });
        return seenMap.get(dk);
      }
    }

    // 2. Build event
    const evEventTs = (meta.origEventTs != null) ? meta.origEventTs : clock.nextTick();
    const ev = Object.freeze({
      id:          newEventId(),
      seq:         clock.nextSeq(),
      ts:          wallNow(),
      eventTs:     evEventTs,
      type,
      payload:     Object.freeze(payload ?? {}),
      causedBy:    meta.causedBy   || null,
      edgeType:    meta.edgeType   || null,
      source:      meta.source     || 'unknown',
      sessionId:   meta.sessionId  || null,
      tabId:       meta.tabId      || null,
      srcBusName:  meta.srcBusName || null,
      replayOf:    meta.replayOf   || null,
      contentHash: contentHash(type, payload, meta.source),
    });

    // 3. Store in ring + indexes
    const evicted = ring.push(ev);
    if (evicted) {
      idIndex.delete(evicted.id);
      _pruneTypeIndex(evicted.id, evicted.type);   // H-2: O(1)
      causal.pruneEdgesFor(evicted.id);            // H-1: prune causal graph
      _emitSystemEvent('system:ring:evicted', { cap: ringCap, evictedSeq: evicted.seq });
    }
    idIndex.set(ev.id, ev);
    _addToTypeIndex(ev.type, ev.id);

    // H-6: cap seenMap at MAX_SEEN_MAP (LRU via Map insertion order)
    if (isReplay) {
      const dk = dedupKey(type, payload, meta.source, meta.replayOf);
      if (seenMap.size >= MAX_SEEN_MAP) {
        seenMap.delete(seenMap.keys().next().value);
      }
      seenMap.set(dk, ev);
    }
    _version++;

    // 4. Build causal edge
    if (ev.causedBy) {
      const parent = idIndex.get(ev.causedBy);
      if (parent) {
        const et = ev.edgeType || (
          ev.source && ev.source.startsWith('gate:') ? EDGE_CAUSAL_RULE : EDGE_CAUSAL_EXPLICIT
        );
        const edge = createEdge(
          parent.id, ev.id, et,
          ev.source || '',
          ev.eventTs - parent.eventTs,
          et === EDGE_CAUSAL_RULE || et === EDGE_CAUSAL_ADAPTER ? 1.0 : 0.9
        );
        try   { causal.addEdge(edge); }
        catch (e) { _emitSystemEvent('system:edge:diamond', { childId: ev.id, message: e.message }); }
        causal.invalidateCache();
      }
    }

    // 5. Update macro projection — H-4: O(1) via macrosByPattern Map
    _updateMacroProjection(ev);

    // 6. Run gates (A-2: atomic output collection)
    _runGates(ev);

    // 6b. K-4: Expire stale calltos
    if (calltoTtlTicks > 0) {
      const expired = callto.expire(ev.eventTs);
      for (const { calltoId, eventId, age } of expired) {
        _emitSystemEvent('system:callto:orphaned', { calltoId, originalEventId: eventId, ageTicks: age });
      }
    }

    // 7. Notify listeners (C-4: gates already fired above)
    for (const L of listeners) {
      try   { L(ev); }
      catch (e) { _reportGateError('kernel:listener', e); }
    }

    return ev;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  function findById(id)            { return idIndex.get(id) || null; }
  function rangeView(start, end)   { return ring.rangeView(start, end); }
  function getAll()                { return ring.toArray(); }
  function traceToRoot(id, d)      { return causal.traceToRoot(id, d); }
  function descendants(rid, d)     { return causal.descendants(rid, d); }
  function edgeMeta(childId)       { return causal.getEdge(childId); }
  function getChildren(parentId)   { return causal.getChildren(parentId); }

  function subscribe(fn) {
    listeners.push(fn);
    return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); };
  }

  // K-1/K-2: Custom gate registration
  function registerGate(signature, fn, { priority = DEFAULT_CUSTOM_PRIORITY } = {}) {
    if (typeof signature !== 'string' || !signature)
      throw new Error('registerGate: signature must be a non-empty string');
    if (typeof fn !== 'function')
      throw new Error('registerGate: fn must be a function');
    if (_gateRegistry.find(g => g.signature === signature))
      throw new Error(`registerGate: gate '${signature}' already registered`);
    _gateRegistry.push({ signature, fn, priority, builtin: false });
    _gatesNeedSort = true;
    return function unregisterGate() {
      const idx = _gateRegistry.findIndex(g => g.signature === signature);
      if (idx >= 0) _gateRegistry.splice(idx, 1);
      _gatesNeedSort = true;
    };
  }

  function getGates() {
    return _getSortedGates().map(g => ({
      signature: g.signature, priority: g.priority, builtin: g.builtin,
    }));
  }

  function reset() {
    ring.clear();
    idIndex.clear();
    typeIndex.clear();
    causal.clear();
    callto.clear();
    seenMap.clear();
    clock.reset();
    macros.length = 0;
    macrosByPattern.clear();
    _macroCounts.clear();
    _macroWindow.fill('');
    _macroWindowHead = 0;
    droppedCount     = 0;
    _gateOutputDepth = 0;
    _version         = 0;
  }

  function registerCallto(calltoId, eventId) { callto.register(calltoId, eventId, clock.tick); }
  function resolveCallto(calltoId)           { return callto.resolve(calltoId); }

  return {
    ingest, findById, rangeView, getAll,
    traceToRoot, descendants, edgeMeta, getChildren,
    subscribe, reset,
    registerCallto, resolveCallto,
    registerGate, getGates,
    get length()        { return ring.length; },
    get version()       { return _version; },
    get droppedCount()  { return droppedCount; },
    get macros()        { return macros; },
    get edgeCount()     { return causal.size; },
    get calltoOrphans() { return callto.orphanCount; },
    get calltoSize()    { return callto.size; },
    get clock()         { return clock; },
    // Internal references exposed for query module's typeIndex fast-path
    // Prefix signals "read-only — do not mutate"
    _ring:      ring,
    _causal:    causal,
    _idIndex:   idIndex,
    _typeIndex: typeIndex,
  };
}
