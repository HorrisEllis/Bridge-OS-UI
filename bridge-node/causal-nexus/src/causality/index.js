// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
/**
 * @module       causality
 * @uuid         32a3f387-655c-4531-87a5-1b98641a8895
 * @version      5.0.0
 *
 * Causal graph store, edge taxonomy, and CalltoMap.
 *
 * Edge type taxonomy (C-1 — declared at ingestion, never inferred post-hoc):
 *   causal/explicit  — caller explicitly provided causedBy
 *   causal/rule      — deterministic gate rule fired
 *   causal/adapter   — lifecycle pair resolved by calltoMap (running→success/failed)
 *   observational    — sideband annotation, never traversed in causal paths
 *
 * H-1 fix: pruneEdgesFor() called on every ring eviction — graph stays bounded.
 * Graph is a DAG — diamond parents are rejected (system event emitted, no crash).
 *
 * @hook 4043de0a-bbfb-4517-b91c-65fc1a214c58  EDGE_CAUSAL_EXPLICIT
 * @hook 664b9eb0-1abd-4240-b88c-8ef65eb29691  EDGE_CAUSAL_RULE
 * @hook 16f1afab-2f65-4b9a-82dc-db59e256bf68  EDGE_CAUSAL_ADAPTER
 * @hook 2f06c350-792a-40da-ad43-68fa7fb00480  EDGE_OBSERVATIONAL
 * @hook e14743d1-19db-49b2-909c-5886558268c2  CAUSAL_EDGE_TYPES
 * @hook 941b8426-9fe9-4a23-acd4-c71840340f05  isCausalEdge
 * @hook fb5929e3-33cd-4c23-ab46-2e128b05ad49  createEdge
 * @hook f90f426c-ccc0-4c09-bcbf-2f9f60b7e4ac  createCausalStore
 * @hook 7c009aa3-3026-4335-b2ea-cf6c0f9c8972  createCalltoMap
 */

// ── Edge type constants ───────────────────────────────────────────────────────

/** @hook 4043de0a-bbfb-4517-b91c-65fc1a214c58 */
export const EDGE_CAUSAL_EXPLICIT = 'causal/explicit';
/** @hook 664b9eb0-1abd-4240-b88c-8ef65eb29691 */
export const EDGE_CAUSAL_RULE     = 'causal/rule';
/** @hook 16f1afab-2f65-4b9a-82dc-db59e256bf68 */
export const EDGE_CAUSAL_ADAPTER  = 'causal/adapter';
/** @hook 2f06c350-792a-40da-ad43-68fa7fb00480 */
export const EDGE_OBSERVATIONAL   = 'observational';

/** @hook e14743d1-19db-49b2-909c-5886558268c2 */
export const CAUSAL_EDGE_TYPES = new Set([
  EDGE_CAUSAL_EXPLICIT,
  EDGE_CAUSAL_RULE,
  EDGE_CAUSAL_ADAPTER,
]);

/**
 * True if the edge participates in causal path traversal.
 * Observational edges are sideband annotations — never traversed (C-3).
 * @hook 941b8426-9fe9-4a23-acd4-c71840340f05  causality:isCausalEdge
 */
export function isCausalEdge(edge) {
  return CAUSAL_EDGE_TYPES.has(edge.edgeType);
}

// ── Edge factory ──────────────────────────────────────────────────────────────

/**
 * Create an immutable edge record.
 * @hook fb5929e3-33cd-4c23-ab46-2e128b05ad49  causality:createEdge
 */
export function createEdge(fromId, toId, edgeType, ruleName, dtTicks, confidence = 1.0) {
  if (!fromId) throw new Error('createEdge: fromId required');
  if (!toId)   throw new Error('createEdge: toId required');
  if (!CAUSAL_EDGE_TYPES.has(edgeType) && edgeType !== EDGE_OBSERVATIONAL) {
    throw new Error(`createEdge: unknown edgeType '${edgeType}'`);
  }
  return Object.freeze({
    fromId,
    toId,
    edgeType,
    ruleName:   ruleName || '',
    dtTicks:    dtTicks  || 0,
    confidence,
  });
}

// ── Causal graph store ────────────────────────────────────────────────────────

/**
 * Bi-directional causal graph. Append-only add; bounded by ring via pruneEdgesFor.
 *
 * H-1: pruneEdgesFor(evictedId) removes both the upward edge (where evictedId
 * is a child) and the downward reference (where evictedId is a parent).
 * Children of the evicted node retain their own entries — only edges pointing
 * to/from the evicted node are removed. traceToRoot stops earlier (truncated=true).
 *
 * @hook f90f426c-ccc0-4c09-bcbf-2f9f60b7e4ac  causality:createCausalStore
 */
export function createCausalStore() {
  const edgeMap           = new Map(); // childId → Edge
  const childrenMap       = new Map(); // parentId → Set<childId>
  const causalChildrenMap = new Map(); // parentId → Set<childId> (causal only)

  let _storeVersion = 0;
  const _descCache  = new Map();

  function addEdge(edge) {
    if (edgeMap.has(edge.toId)) {
      throw new Error(
        `Causal store: event ${edge.toId} already has a parent. Diamond graphs not supported.`
      );
    }
    edgeMap.set(edge.toId, edge);

    if (!childrenMap.has(edge.fromId)) childrenMap.set(edge.fromId, new Set());
    childrenMap.get(edge.fromId).add(edge.toId);

    if (isCausalEdge(edge)) {
      if (!causalChildrenMap.has(edge.fromId)) causalChildrenMap.set(edge.fromId, new Set());
      causalChildrenMap.get(edge.fromId).add(edge.toId);
    }
  }

  /**
   * H-1: Remove all edges connected to an evicted event ID.
   * Direction 1 (as child): removes edge where evictedId is the child.
   * Direction 2 (as parent): removes evictedId from both children maps.
   * Memory: O(fan-out of evicted event) per eviction call.
   */
  function pruneEdgesFor(evictedId) {
    edgeMap.delete(evictedId);
    childrenMap.delete(evictedId);
    causalChildrenMap.delete(evictedId);
    _storeVersion++;
  }

  function getEdge(childId)     { return edgeMap.get(childId)     || null; }
  function getChildren(parentId){ return childrenMap.get(parentId) || new Set(); }
  function getCausalChildren(parentId) { return causalChildrenMap.get(parentId) || new Set(); }

  function traceToRoot(eventId, maxDepth = 50) {
    const path = [eventId];
    let cur = eventId;
    let truncated = false;

    for (let i = 0; i < maxDepth; i++) {
      const edge = edgeMap.get(cur);
      if (!edge || !isCausalEdge(edge) || !edge.fromId) break;
      path.unshift(edge.fromId);
      cur = edge.fromId;
    }

    if (path.length - 1 === maxDepth) {
      const topEdge = edgeMap.get(path[0]);
      truncated = !!(topEdge && isCausalEdge(topEdge) && topEdge.fromId);
    }

    return { path, depth: path.length - 1, truncated };
  }

  function descendants(rootId, maxDepth = 30) {
    const cached = _descCache.get(rootId);
    if (cached && cached.version === _storeVersion) return cached.result;

    const out     = [rootId];
    const queue   = [rootId];
    const visited = new Set([rootId]);
    let depth     = 0;

    while (queue.length && depth < maxDepth) {
      const next = [];
      for (const id of queue) {
        const kids = causalChildrenMap.get(id);
        if (!kids) continue;
        for (const kid of kids) {
          if (visited.has(kid)) continue;
          visited.add(kid);
          out.push(kid);
          next.push(kid);
        }
      }
      queue.length = 0;
      queue.push(...next);
      depth++;
    }

    _descCache.set(rootId, { version: _storeVersion, result: out });
    return out;
  }

  function clear() {
    edgeMap.clear();
    childrenMap.clear();
    causalChildrenMap.clear();
    _descCache.clear();
    _storeVersion = 0;
  }

  function invalidateCache() {
    _storeVersion++;
    // Prune stale cache entries when cache grows large
    if (_descCache.size > 1000) {
      for (const [k, v] of _descCache) {
        if (v.version !== _storeVersion) _descCache.delete(k);
      }
    }
  }

  return {
    addEdge, getEdge, getChildren, getCausalChildren,
    traceToRoot, descendants, clear, invalidateCache,
    pruneEdgesFor,
    get size()    { return edgeMap.size; },
    get version() { return _storeVersion; },
  };
}

// ── CalltoMap with TTL ────────────────────────────────────────────────────────

/**
 * Map tracking in-flight callto pairs: calltoId → { eventId, registeredAt }.
 *
 * TTL (in kernel event-time ticks) controls when an unresolved entry is
 * considered orphaned. TTL=0 disables expiry (original behavior).
 *
 * Expiry is not automatic — callers must invoke expire(currentTick) each
 * gate cycle. Expired entries are returned for the kernel to emit events.
 * CalltoMap never calls kernel.ingest() — pure data structure, no circular dep.
 *
 * K-4: calltoTtlTicks option wires this via kernel constructor.
 *
 * @hook 7c009aa3-3026-4335-b2ea-cf6c0f9c8972  causality:createCalltoMap
 */
export function createCalltoMap({ ttlTicks = 0 } = {}) {
  const map = new Map();
  let _orphanCount = 0;

  function register(calltoId, eventId, currentTick = 0) {
    if (map.has(calltoId)) _orphanCount++;
    map.set(calltoId, { eventId, registeredAt: currentTick });
  }

  function resolve(calltoId) {
    const entry = map.get(calltoId);
    map.delete(calltoId);
    return entry ? entry.eventId : null;
  }

  function peek(calltoId) {
    const entry = map.get(calltoId);
    return entry ? entry.eventId : null;
  }

  function expire(currentTick) {
    if (!ttlTicks || !map.size) return [];
    const expired = [];
    for (const [calltoId, entry] of map) {
      if (currentTick - entry.registeredAt >= ttlTicks) {
        expired.push({ calltoId, eventId: entry.eventId, age: currentTick - entry.registeredAt });
        map.delete(calltoId);
        _orphanCount++;
      }
    }
    return expired;
  }

  function clear() { map.clear(); _orphanCount = 0; }

  return {
    register, resolve, peek, expire, clear,
    get size()        { return map.size; },
    get orphanCount() { return _orphanCount; },
    get ttlTicks()    { return ttlTicks; },
  };
}
