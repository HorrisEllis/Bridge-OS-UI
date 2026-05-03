// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
/**
 * @module       observer
 * @uuid         f7a8b9c0-d1e2-4f3a-4b5c-6d7e8f9a0b1c
 * @version      5.0.0
 *
 * Typed event subscription bus, scoped to a single execution context.
 *
 * Each ObserverBus is bound to one context at creation time via scopeId.
 * Observers registered on a LiveContext bus cannot receive ReplayContext
 * events — isolation is structural (different bus instances), not flag-based.
 * This is the observer-layer proof of CI-1.
 *
 * Design:
 *   createObserverBus(scopeId, contextType) → ObserverBus
 *   ObserverBus.subscribe(filter, fn)       → Observer
 *   ObserverBus.emit(event)                 → void
 *   Observer.off()                          → void
 *
 * Filter: a predicate (ev) => boolean, or an event type string for convenience.
 * Handlers receive the event and the ObserverBus that emitted it.
 * Handler errors are caught and logged — they never halt emission.
 *
 * Revocation: once revoke() is called on a bus, any subsequent emit() throws.
 * This mirrors the spec's bus scope revocation on context completion.
 *
 * @hook f7a8b9c0-d1e2-4f3a-4b5c-6d7e8f9a0b1c  createObserverBus
 * @hook a8b9c0d1-e2f3-4a4b-5c6d-7e8f9a0b1c2d  ObserverBus
 * @hook b9c0d1e2-f3a4-4b5c-6d7e-8f9a0b1c2d3e  Observer
 * @hook c0d1e2f3-a4b5-4c6d-7e8f-9a0b1c2d3e4f  OBSERVER_BUS_LIVE
 * @hook d1e2f3a4-b5c6-4d7e-8f9a-0b1c2d3e4f5a  OBSERVER_BUS_REPLAY
 */

'use strict';

// ── Context type labels (mirrors context module — no import to avoid cycle) ──

/** @hook c0d1e2f3-a4b5-4c6d-7e8f-9a0b1c2d3e4f  observer:OBSERVER_BUS_LIVE */
export const OBSERVER_BUS_LIVE   = 'live';

/** @hook d1e2f3a4-b5c6-4d7e-8f9a-0b1c2d3e4f5a  observer:OBSERVER_BUS_REPLAY */
export const OBSERVER_BUS_REPLAY = 'replay';

// ── createObserverBus ─────────────────────────────────────────────────────────

/**
 * Create a typed event bus scoped to one execution context.
 *
 * scopeId ties this bus to a specific context instance. A bus created for
 * a LiveContext has a different scopeId from any ReplayContext bus —
 * structural isolation proves CI-1 at the observer layer.
 *
 * @hook f7a8b9c0-d1e2-4f3a-4b5c-6d7e8f9a0b1c  observer:createObserverBus
 *
 * @param {string} scopeId     — contextId from the owning context
 * @param {string} contextType — 'live' | 'replay'
 * @returns {ObserverBus}
 */
export function createObserverBus(scopeId, contextType) {
  if (!scopeId || typeof scopeId !== 'string') {
    throw new Error('[observer] createObserverBus: scopeId must be a non-empty string');
  }
  if (contextType !== OBSERVER_BUS_LIVE && contextType !== OBSERVER_BUS_REPLAY) {
    throw new Error(`[observer] createObserverBus: contextType must be '${OBSERVER_BUS_LIVE}' or '${OBSERVER_BUS_REPLAY}'`);
  }

  const _subscriptions = new Map(); // subId → { filter, fn, active }
  let   _subSeq        = 0;
  let   _revoked       = false;
  let   _emitCount     = 0;

  // ── subscribe ───────────────────────────────────────────────────────────

  /**
   * Register a typed subscription.
   *
   * filter: string (event type match) or predicate (ev) => boolean
   * fn:     (event, bus) => void — handler, errors caught silently
   *
   * Returns an Observer handle with off() and active.
   *
   * @hook b9c0d1e2-f3a4-4b5c-6d7e-8f9a0b1c2d3e  observer:Observer
   */
  function subscribe(filter, fn) {
    if (typeof fn !== 'function') {
      throw new Error('[observer] subscribe: fn must be a function');
    }
    if (filter === null || filter === undefined) {
      throw new Error('[observer] subscribe: filter must be a string or predicate');
    }

    const predicate = typeof filter === 'string'
      ? (ev) => ev.type === filter
      : filter;

    if (typeof predicate !== 'function') {
      throw new Error('[observer] subscribe: filter must be a string or function');
    }

    const subId = `${scopeId}:sub:${++_subSeq}`;
    const sub   = { subId, filter: predicate, fn, active: true };
    _subscriptions.set(subId, sub);

    // Observer handle — returned to caller
    const observer = {
      off() {
        const s = _subscriptions.get(subId);
        if (s) { s.active = false; _subscriptions.delete(subId); }
      },
      get active() {
        return _subscriptions.has(subId) && (_subscriptions.get(subId)?.active ?? false);
      },
      scopeId,
      subId,
    };

    return Object.freeze(observer);
  }

  // ── emit ────────────────────────────────────────────────────────────────

  /**
   * Emit an event to all matching subscribers.
   * Throws if the bus has been revoked (context completed).
   * Handler errors are caught — they never halt emission.
   */
  function emit(event) {
    if (_revoked) {
      throw new Error(`[observer] emit on revoked bus '${scopeId}' — context has completed`);
    }
    if (!event || typeof event !== 'object') return;

    _emitCount++;
    for (const sub of _subscriptions.values()) {
      if (!sub.active) continue;
      let matches = false;
      try   { matches = sub.filter(event); } catch (_) { matches = false; }
      if (!matches) continue;
      try   { sub.fn(event, _bus); } catch (_) { /* handler errors never halt emission */ }
    }
  }

  // ── revoke ──────────────────────────────────────────────────────────────

  /**
   * Revoke this bus. Called when the owning context completes.
   * Subsequent emit() calls throw. Existing subscribers are cleared.
   * Spec: "scope ID is revoked when the context completes — any emission
   * on a revoked scope throws (fail loudly)"
   */
  function revoke() {
    _revoked = true;
    _subscriptions.clear();
  }

  // ── subscribeToKernel ───────────────────────────────────────────────────

  /**
   * Wire this bus to a kernel — all kernel events are forwarded to emit().
   * Returns an unsubscribe function.
   * The kernel's subscriber list and this bus are still independent objects —
   * no scope crossing occurs (CI-1 preserved at kernel level).
   */
  function subscribeToKernel(kernel) {
    if (!kernel || typeof kernel.subscribe !== 'function') {
      throw new Error('[observer] subscribeToKernel: kernel must have subscribe()');
    }
    return kernel.subscribe(ev => { if (!_revoked) emit(ev); });
  }

  const _bus = {
    emit,
    subscribe,
    revoke,
    subscribeToKernel,
    scopeId,
    contextType,
    get subscriptionCount() { return _subscriptions.size; },
    get emitCount()         { return _emitCount; },
    get revoked()           { return _revoked; },
  };

  return _bus;
}
