// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
/**
 * @module       delta
 * @uuid         7a4219d0-04a3-4276-8a52-83e7d52db10a
 * @version      5.0.0
 *
 * Kinematic delta engine. Pure measurement — no thresholds, no judgment,
 * no anomaly classification. Judgment belongs in the σ layer (sigma.js, future).
 *
 * R1: computeThroughputTimeline buckets by ev.eventTs via eventTsToWindow,
 *     not by wall clock — replay-deterministic by construction.
 * R2: branchDepthChange removed (was always 0 or 1, tautological).
 *     computeSigma renamed to computeTypeStats (σ name reserved for classifier).
 * R3: structuralDeviation (C field) added — normalized causal depth deviation,
 *     orthogonal to temporal S field.
 * R4: instabilityScore, anomalyType, isBottleneck removed from delta records.
 *     detectBottlenecks/clusterByAnomaly deprecated to return [] stubs (UUID retained).
 *
 * Feature vector output per event:
 *   S-field: latencyImpact (z-score of inter-event gap)
 *   C-field: structuralDeviation (z-score of causal depth deviation)
 *   throughputChange: signed rate delta (S-field temporal component)
 *   childCount: raw structural measurement
 *
 * @hook c2237d17-ca86-4938-ba4c-83975cef1681  computeEventDelta
 * @hook 67240917-2b71-4c71-b990-f70d8fb63815  computeDeltaStream
 * @hook e3bb7a99-ec6a-4515-96a7-21e30b8bd1bd  detectBottlenecks (deprecated stub)
 * @hook 728a38ea-5e0b-4389-a3b8-8f2b34c4bbad  computeThroughputTimeline
 * @hook 24ded596-d004-4c08-aa21-ee215fa87bf2  compressToL1
 * @hook f86550cf-140f-4f57-895f-3dd125d977be  overlayMacros
 * @hook 060b1fc1-bbf7-4d27-8780-025609afd030  clusterByAnomaly (deprecated stub)
 * @hook e3a6c710-7d0f-4997-8a2f-953f6568f730  detectFractals
 * @hook b70350bf-59b9-4589-9ed8-b72c26a244cc  createGraphBranch
 * @hook a97b25f7-73e4-4cdf-9a86-f25a2bcdd8ff  createBranchRegistry
 * @hook 7fd8b41e-95bc-438d-9d98-ab8925c9203e  BOTTLENECK_THRESHOLD (deprecated)
 * @hook d0234be7-bfe3-42bd-9c93-8f8cea822754  FAN_OUT_ALERT_THRESHOLD (deprecated)
 * @hook 0fa077b8-30ca-4b11-9b6f-df32c211cfe2  DEPTH_ALERT_THRESHOLD (deprecated)
 * @hook ef133825-4823-4ad3-b156-4c16ac20ce3c  ZOOM_LEVELS
 */

import { newEventId }        from '../identity/index.js';
import { eventTsToWindow }   from '../lazy/index.js';

// ── Constants ─────────────────────────────────────────────────────────────────

/** @hook 339a1033-8919-465f-b9d5-71802442ac85 */
export const LATENCY_WINDOW    = 50;
/** @hook 62e32268-eb88-47fe-b48c-b89faaf1abf2 */
export const THROUGHPUT_WINDOW = 100;

// Deprecated threshold constants — exported for backward compatibility only.
// Do not use in new code. Judgment belongs in the σ layer.
/** @hook 7fd8b41e-95bc-438d-9d98-ab8925c9203e @deprecated */
export const BOTTLENECK_THRESHOLD    = 0.7;
/** @hook d0234be7-bfe3-42bd-9c93-8f8cea822754 @deprecated */
export const FAN_OUT_ALERT_THRESHOLD = 8;
/** @hook 0fa077b8-30ca-4b11-9b6f-df32c211cfe2 @deprecated */
export const DEPTH_ALERT_THRESHOLD   = 15;

// ── Single-event kinematic delta ──────────────────────────────────────────────

/**
 * Compute the kinematic delta for a single event.
 * Pure measurement — no thresholds, no anomaly classification (R4).
 *
 * Output fields:
 *   gap               — inter-event ticks from parent (0 for roots)
 *   latencyImpact     — z-score of gap vs rolling window (S-field, ≥0)
 *   ownDepth          — absolute causal depth (0 = root)
 *   throughputChange  — signed rate delta vs previous window
 *   childCount        — direct causal children at call time
 *   structuralDeviation — z-score of ownDepth vs recent depth window (C-field)
 *
 * @hook c2237d17-ca86-4938-ba4c-83975cef1681  delta:computeEventDelta
 */
export function computeEventDelta(ev, parent, parentDepth, recentGaps, recentRate, prevRate, childCount, recentDepths) {
  // S-field: latency z-score vs rolling baseline
  const gap = parent ? (ev.eventTs - parent.eventTs) : 0;
  let latencyImpact = 0;
  if (recentGaps.length >= 3) {
    const mean     = recentGaps.reduce((a, b) => a + b, 0) / recentGaps.length;
    const variance = recentGaps.reduce((s, g) => s + (g - mean) ** 2, 0) / recentGaps.length;
    const std      = Math.sqrt(variance) || 1;
    latencyImpact  = Math.max(0, (gap - mean) / std);
  }

  // Causal depth
  const ownDepth = parentDepth + (parent ? 1 : 0);

  // Throughput change (S-field temporal component) — no threshold applied
  const throughputChange = prevRate > 0 ? (recentRate - prevRate) / prevRate : 0;

  // C-field: structural deviation — normalized causal depth z-score
  // Independent of S, replay-invariant, scale-invariant across session sizes
  let structuralDeviation = 0;
  if (recentDepths && recentDepths.length >= 3) {
    const n        = recentDepths.length;
    const mean     = recentDepths.reduce((a, b) => a + b, 0) / n;
    const variance = recentDepths.reduce((s, d) => s + (d - mean) ** 2, 0) / n;
    const std      = Math.sqrt(variance) || 1;
    structuralDeviation = (ownDepth - mean) / std;
  }

  return Object.freeze({
    eventId:             ev.id,
    eventType:           ev.type,
    eventTs:             ev.eventTs,
    seq:                 ev.seq,
    gap,
    latencyImpact:       Math.round(latencyImpact     * 1000) / 1000,
    ownDepth,
    throughputChange:    Math.round(throughputChange   * 1000) / 1000,
    childCount,
    structuralDeviation: Math.round(structuralDeviation * 1000) / 1000,
  });
}

// ── Delta stream ──────────────────────────────────────────────────────────────

/**
 * Compute deltas for all events in an array — O(n) pass.
 *
 * @param {Event[]}    events     — kernel.getAll() or rangeView()
 * @param {Function}   findById   — kernel.findById
 * @param {Function}   edgeMeta   — kernel.edgeMeta
 * @param {Function}   getChildren— kernel.getChildren
 *
 * @hook 67240917-2b71-4c71-b990-f70d8fb63815  delta:computeDeltaStream
 */
export function computeDeltaStream(events, findById, edgeMeta, getChildren) {
  const deltas      = new Array(events.length);
  const gapWindow   = [];
  const depthWindow = [];
  let prevRate      = 0;

  const depthCache = new Map();

  function getDepth(ev) {
    if (depthCache.has(ev.id)) return depthCache.get(ev.id);
    if (!ev.causedBy) { depthCache.set(ev.id, 0); return 0; }
    const parent = findById(ev.causedBy);
    const d      = parent ? getDepth(parent) + 1 : 1;
    depthCache.set(ev.id, d);
    return d;
  }

  for (let i = 0; i < events.length; i++) {
    const ev          = events[i];
    const parent      = ev.causedBy ? findById(ev.causedBy) : null;
    const parentDepth = parent ? getDepth(parent) : 0;

    if (parent) {
      gapWindow.push(ev.eventTs - parent.eventTs);
      if (gapWindow.length > LATENCY_WINDOW) gapWindow.shift();
    }

    let recentRate = prevRate;
    if (i >= THROUGHPUT_WINDOW) {
      const windowEv = events[i - THROUGHPUT_WINDOW];
      const span     = ev.eventTs - windowEv.eventTs;
      recentRate     = span > 0 ? (THROUGHPUT_WINDOW / span) * 1000 : prevRate;
      if (i === THROUGHPUT_WINDOW) prevRate = recentRate;
    }

    const childCount = (getChildren(ev.id) || new Set()).size;

    deltas[i] = computeEventDelta(
      ev, parent, parentDepth,
      [...gapWindow], recentRate, prevRate,
      childCount, [...depthWindow]
    );

    const ownDepth = deltas[i].ownDepth;
    depthWindow.push(ownDepth);
    if (depthWindow.length > LATENCY_WINDOW) depthWindow.shift();

    prevRate = recentRate;
  }

  return deltas;
}

// ── Deprecated stubs (UUIDs retained for backward compat) ────────────────────

/**
 * @deprecated R4: depended on instabilityScore/anomalyType removed from delta.
 * Replacement: σ layer (sigma.js, future module). UUID 3bb7a99 retained.
 * @hook e3bb7a99-ec6a-4515-96a7-21e30b8bd1bd  delta:detectBottlenecks
 */
export function detectBottlenecks(_deltas, _threshold) { return []; }

/**
 * @deprecated R4: depended on anomalyType removed from delta.
 * Replacement: σ layer (sigma.js). UUID 060b1fc1 retained.
 * @hook 060b1fc1-bbf7-4d27-8780-025609afd030  delta:clusterByAnomaly
 */
export function clusterByAnomaly(_events, _deltas, _ticksPerBucket) { return []; }

// ── Throughput timeline ───────────────────────────────────────────────────────

/**
 * Bucket events by logical clock window (R1: eventTs not ts).
 * Returns { window, firstSeq, lastSeq, count, firstEventTs, lastEventTs }[]
 * sorted by window index ascending.
 *
 * @param {Event[]} events
 * @param {number}  [windowSize]  ticks per bucket (default DEFAULT_TICK_WINDOW)
 *
 * @hook 728a38ea-5e0b-4389-a3b8-8f2b34c4bbad  delta:computeThroughputTimeline
 */
export function computeThroughputTimeline(events, windowSize) {
  const buckets = new Map();

  for (let i = 0; i < events.length; i++) {
    const ev  = events[i];
    const win = eventTsToWindow(ev.eventTs, windowSize);

    if (!buckets.has(win)) {
      buckets.set(win, {
        window:       win,
        firstSeq:     ev.seq,
        lastSeq:      ev.seq,
        count:        0,
        firstEventTs: ev.eventTs,
        lastEventTs:  ev.eventTs,
      });
    }
    const b    = buckets.get(win);
    b.count++;
    b.lastSeq     = ev.seq;
    b.lastEventTs = ev.eventTs;
  }

  return [...buckets.values()]
    .sort((a, b) => a.window - b.window)
    .map(b => Object.freeze(b));
}

// ── Zoom levels ───────────────────────────────────────────────────────────────

/**
 * L0 — raw events (1:1)
 * L1 — compressed causal chains
 * L2 — macro patterns
 * L3 — system behaviour clusters
 * L4 — fractal summaries
 * @hook ef133825-4823-4ad3-b156-4c16ac20ce3c  delta:ZOOM_LEVELS
 */
export const ZOOM_LEVELS = Object.freeze({ L0: 0, L1: 1, L2: 2, L3: 3, L4: 4 });

// ── L1: Chain compression ─────────────────────────────────────────────────────

/**
 * Compress linear causal chains (A→B→C where each has one causal child)
 * into a single chain node. Returns compressed event list.
 * @hook 24ded596-d004-4c08-aa21-ee215fa87bf2  delta:compressToL1
 */
export function compressToL1(events, getChildren, edgeMeta) {
  const compressed = [];
  const absorbed   = new Set();

  for (const ev of events) {
    if (absorbed.has(ev.id)) continue;

    const kids = getChildren ? getChildren(ev.id) : new Set();

    if (kids.size === 1) {
      const chainIds = [ev.id];
      let cur        = [...kids][0];

      while (cur) {
        const curKids = getChildren(cur);
        chainIds.push(cur);
        absorbed.add(cur);
        if (curKids.size === 1) { cur = [...curKids][0]; }
        else break;
      }

      if (chainIds.length > 1) {
        compressed.push(Object.freeze({
          _isChain:    true,
          id:          ev.id,
          chainIds,
          chainLength: chainIds.length,
          firstSeq:    ev.seq,
          type:        'chain:' + ev.type,
          source:      ev.source,
          eventTs:     ev.eventTs,
          ts:          ev.ts,
          seq:         ev.seq,
          causedBy:    ev.causedBy,
          payload:     { ...ev.payload, chainLength: chainIds.length },
        }));
        continue;
      }
    }

    compressed.push(ev);
  }

  return compressed;
}

// ── L2: Macro overlay ─────────────────────────────────────────────────────────

/**
 * Overlay macro pattern nodes onto the event list.
 * Each detected macro becomes a node positioned after its trigger event.
 * @hook f86550cf-140f-4f57-895f-3dd125d977be  delta:overlayMacros
 */
export function overlayMacros(events, macros) {
  if (!macros.length) return events;

  const macroByTrigger = new Map();
  for (const m of macros) macroByTrigger.set(m.triggerEventId, m);

  const result = [];
  for (const ev of events) {
    result.push(ev);
    const macro = macroByTrigger.get(ev.id);
    if (macro) {
      result.push(Object.freeze({
        _isMacroNode: true,
        id:           macro.id,
        type:         'macro:' + macro.pattern.split(' → ')[0],
        pattern:      macro.pattern,
        count:        macro.count,
        source:       'projection:macro',
        eventTs:      ev.eventTs + 0.5,
        ts:           ev.ts,
        seq:          ev.seq,
        causedBy:     ev.id,
        payload:      { pattern: macro.pattern, count: macro.count },
      }));
    }
  }
  return result;
}

// ── Fractal engine ────────────────────────────────────────────────────────────

/**
 * Detect self-similar subgraphs. Walks causal chains of length minChainLen..maxChainLen,
 * hashes type sequences, counts occurrences. Returns FractalNode[].
 *
 * R2 fix: accepts caller-supplied findById (O(1) via kernel.findById) rather
 * than building a local O(n) linear scan index on each call.
 *
 * @hook e3a6c710-7d0f-4997-8a2f-953f6568f730  delta:detectFractals
 */
export function detectFractals(events, getChildren, edgeMeta, {
  minChainLen    = 3,
  minOccurrences = 3,
  maxChainLen    = 8,
  findById       = null,
} = {}) {
  const patternCounts = new Map();

  // O(1) event lookup — prefer caller-supplied findById
  const _index   = findById ? null : new Map(events.map(e => [e.id, e]));
  const _findById = findById || (id => _index.get(id) || null);

  function chainHash(typeSeq) { return typeSeq.join('→'); }

  function walkChains(startId, typeSeq, idSeq, depth) {
    if (depth > maxChainLen) return;
    if (typeSeq.length >= minChainLen) {
      const hash = chainHash(typeSeq);
      if (!patternCounts.has(hash)) {
        patternCounts.set(hash, {
          patternHash:  hash,
          typeSequence: [...typeSeq],
          chainLength:  typeSeq.length,
          occurrences:  [],
        });
      }
      patternCounts.get(hash).occurrences.push({ rootId: idSeq[0], ids: [...idSeq] });
    }
    const kids = getChildren ? getChildren(startId) : new Set();
    for (const kidId of kids) {
      const edge  = edgeMeta ? edgeMeta(kidId) : null;
      if (!edge || !['causal/explicit','causal/rule','causal/adapter'].includes(edge.edgeType)) continue;
      const kidEv = _findById(kidId);
      if (!kidEv) continue;
      walkChains(kidId, [...typeSeq, kidEv.type], [...idSeq, kidId], depth + 1);
    }
  }

  for (const ev of events) {
    if (ev.causedBy || ev.type.startsWith('system:')) continue;
    walkChains(ev.id, [ev.type], [ev.id], 1);
  }

  const fractals = [];
  for (const [, p] of patternCounts) {
    if (p.occurrences.length < minOccurrences) continue;
    const totalEvents        = events.length || 1;
    const expectedRate       = Math.pow(1 / Math.max(1, totalEvents), p.chainLength);
    const actualRate         = p.occurrences.length / totalEvents;
    const selfSimilarityScore = Math.min(1, actualRate / Math.max(expectedRate, 1e-10) / 1000);
    fractals.push(Object.freeze({
      id:                  newEventId(),
      patternHash:         p.patternHash,
      typeSequence:        p.typeSequence,
      chainLength:         p.chainLength,
      occurrenceCount:     p.occurrences.length,
      selfSimilarityScore: Math.round(selfSimilarityScore * 1000) / 1000,
      rootIds:             p.occurrences.map(o => o.rootId),
      canonicalIds:        p.occurrences[0].ids,
    }));
  }

  return fractals.sort((a, b) => b.occurrenceCount - a.occurrenceCount);
}

// ── Graph branch (fork on bottleneck) ────────────────────────────────────────

/**
 * Create an immutable snapshot branch from the current graph state.
 * The live graph is NEVER modified. Branches accumulate in a registry.
 * @hook b70350bf-59b9-4589-9ed8-b72c26a244cc  delta:createGraphBranch
 */
export function createGraphBranch(zone, snapshotEvents, currentSeq) {
  return Object.freeze({
    id:                 newEventId(),
    type:               'graph-branch',
    forkReason:         'bottleneck',
    forkSeq:            currentSeq,
    bottleneckZoneId:   zone.id,
    severity:           zone.severity,
    snapshotEventCount: snapshotEvents.length,
    snapshotIndex:      new Map(snapshotEvents.map(e => [e.id, e])),
    firstSeq:           snapshotEvents[0]?.seq ?? 0,
    lastSeq:            snapshotEvents[snapshotEvents.length - 1]?.seq ?? 0,
    createdTs:          Date.now(),
  });
}

/**
 * Registry accumulating graph branches (forked causal universes).
 * @hook a97b25f7-73e4-4cdf-9a86-f25a2bcdd8ff  delta:createBranchRegistry
 */
export function createBranchRegistry() {
  const branches = [];

  function addBranch(branch) { branches.push(branch); return branch; }
  function getById(id) { return branches.find(b => b.id === id) || null; }
  function getAll() { return [...branches]; }
  function findEventInBranch(branchId, eventId) {
    const branch = getById(branchId);
    return branch ? (branch.snapshotIndex.get(eventId) || null) : null;
  }
  function clear() { branches.length = 0; }

  return { addBranch, getById, getAll, findEventInBranch, clear, get count() { return branches.length; } };
}
