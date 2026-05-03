// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
/**
 * @module       projection
 * @uuid         74eddeca-5097-417a-8a50-677d8446767b
 * @version      5.0.0
 *
 * Read-only, disposable, rebuildable projections over kernel event arrays.
 * Projections NEVER call kernel.ingest(). They are pure computations.
 *
 * R-2: Source filtering uses Set.has() — O(1) per event.
 * R-3: buildBranchTree uses depth/fan-out/chain limits to prevent exponential blowup.
 *
 * @hook da9cee3a-37f2-49f4-84b7-fb1519a520b4  createFilterCache
 * @hook fc576f68-d433-43e1-9651-d1cc3daf0288  computeSourceCounts
 * @hook c708054b-b4e9-4523-b182-7764a1de8d7a  computeTypeStats
 * @hook e7aa20f4-b170-496e-8af8-ad7af7259827  computeDelta
 * @hook 9462433c-f64e-4c40-b6b2-cb11a5297d42  buildBranchTree
 */

// ── Filter projection ─────────────────────────────────────────────────────────

/**
 * Version-keyed, source-filtered event cache.
 * Invalidated automatically when kernel.version or the source filter changes.
 * R-2: sourceSet.has() is O(1) per event.
 *
 * @hook da9cee3a-37f2-49f4-84b7-fb1519a520b4  projection:createFilterCache
 */
export function createFilterCache() {
  let _cache = null;

  function get(events, version, sources) {
    const filterKey = sources.join('\0');
    if (_cache && _cache.version === version && _cache.filterKey === filterKey) {
      return _cache.result;
    }
    const sourceSet = new Set(sources);  // R-2: O(1) per-event lookup
    const result    = events.filter(e => sourceSet.has(e.source || 'unknown'));
    _cache = { version, filterKey, result };
    return result;
  }

  function invalidate() { _cache = null; }

  return { get, invalidate };
}

// ── Source statistics ─────────────────────────────────────────────────────────

/**
 * Count events per source. Returns Map<source, count> sorted by count desc.
 * @hook fc576f68-d433-43e1-9651-d1cc3daf0288  projection:computeSourceCounts
 */
export function computeSourceCounts(events) {
  const counts = new Map();
  for (const e of events) {
    counts.set(e.source, (counts.get(e.source) || 0) + 1);
  }
  return new Map([...counts.entries()].sort((a, b) => b[1] - a[1]));
}

// ── Event type statistics ─────────────────────────────────────────────────────

/**
 * Compute statistical profile for a given event type over the event array.
 *
 * Previously named computeSigma (renamed R-2 — the name σ is reserved for
 * the upcoming σ trajectory classifier in sigma.js, a different concept).
 *
 * Returns: { type, count, rate, p50, p95, p99, firstSeq, lastSeq, span }
 *
 * @hook c708054b-b4e9-4523-b182-7764a1de8d7a  projection:computeTypeStats
 */
export function computeTypeStats(events, type) {
  const typed = events.filter(e => e.type === type);
  if (!typed.length) return null;

  const count    = typed.length;
  const firstSeq = typed[0].seq;
  const lastSeq  = typed[typed.length - 1].seq;
  const span     = typed[typed.length - 1].eventTs - typed[0].eventTs;

  const gaps = [];
  for (let i = 1; i < typed.length; i++) {
    gaps.push(typed[i].eventTs - typed[i - 1].eventTs);
  }
  gaps.sort((a, b) => a - b);

  function percentile(arr, p) {
    if (!arr.length) return 0;
    const idx = Math.ceil((p / 100) * arr.length) - 1;
    return arr[Math.max(0, idx)];
  }

  return {
    type,
    count,
    rate:    span > 0 ? (count / span) * 1000 : 0,
    p50:     percentile(gaps, 50),
    p95:     percentile(gaps, 95),
    p99:     percentile(gaps, 99),
    firstSeq,
    lastSeq,
    span,
  };
}

// ── Delta projection ──────────────────────────────────────────────────────────

/**
 * Compute structural delta between a child event's payload and its parent's.
 * Returns { changed, added, removed, isEmpty }.
 * Operates on payload fields only — never identity fields.
 *
 * @hook e7aa20f4-b170-496e-8af8-ad7af7259827  projection:computeDelta
 */
export function computeDelta(parentEvent, childEvent) {
  if (!parentEvent || !childEvent) return null;

  const p      = parentEvent.payload || {};
  const c      = childEvent.payload  || {};
  const allKeys = new Set([...Object.keys(p), ...Object.keys(c)]);

  const changed = {}, added = {}, removed = {};

  for (const key of allKeys) {
    const inParent = Object.prototype.hasOwnProperty.call(p, key);
    const inChild  = Object.prototype.hasOwnProperty.call(c, key);

    if (inParent && inChild) {
      const pv = JSON.stringify(p[key]);
      const cv = JSON.stringify(c[key]);
      if (pv !== cv) changed[key] = [p[key], c[key]];
    } else if (inChild) {
      added[key] = c[key];
    } else {
      removed[key] = p[key];
    }
  }

  return {
    changed,
    added,
    removed,
    isEmpty: !Object.keys(changed).length && !Object.keys(added).length && !Object.keys(removed).length,
  };
}

// ── Branch tree projection ────────────────────────────────────────────────────

/**
 * Build a branch tree from a root event for the Branches view.
 * R-3: limits depth and fan-out to prevent exponential blowup.
 * Returns array of chains: [[rootId, child1, child2, ...], ...]
 *
 * @hook 9462433c-f64e-4c40-b6b2-cb11a5297d42  projection:buildBranchTree
 */
export function buildBranchTree(rootId, getChildren, maxDepth = 10, maxFanOut = 5, maxChains = 50) {
  const chains = [];

  function descend(id, chain, depth) {
    if (chains.length >= maxChains) return;
    if (depth > maxDepth) return;

    const kids = [...(getChildren(id) || [])].slice(0, maxFanOut);
    if (!kids.length) {
      chains.push([...chain]);
      return;
    }
    for (const kid of kids) {
      descend(kid, [...chain, kid], depth + 1);
    }
  }

  descend(rootId, [rootId], 0);
  return chains;
}
