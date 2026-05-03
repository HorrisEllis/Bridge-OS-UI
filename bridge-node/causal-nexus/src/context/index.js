// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
/**
 * @module       context
 * @uuid         e1f2a3b4-c5d6-4e7f-8a9b-0c1d2e3f4a5b
 * @version      5.0.0
 *
 * Execution context model. Two hermetically isolated worlds:
 *
 *   createLiveContext(kernel, sandbox?)
 *     — wraps a kernel for real-time event ingestion.
 *     — adapters instantiated with full side-effect permissions.
 *
 *   createReplayContext(snapshot, opts?)
 *     — hermetically sealed replay world derived from a validated snapshot.
 *     — owns isolated kernel, clock, ring. No state crosses context boundaries.
 *     — FULL and LOCAL_ONLY adapters replaced with null adapters (sandbox enforces).
 *     — run({ onStep }) steps through events; complete() returns result record.
 *
 * Replay Isolation Axiom:
 *   Replay is not a mode. Replay is a separate execution instance derived from
 *   the kernel definition. No execution state, references, runtime handles,
 *   shared caches, or shared registries may cross context boundaries.
 *
 * Isolation is structural, not conditional:
 *   Each context owns its own kernel instance. A ReplayContext kernel is a
 *   different object from any LiveContext kernel. CI-1 is proven by object
 *   identity — no bus scope flag is required or used.
 *
 * Context Isolation Invariants (CI-1..CI-6):
 *   CI-1  Events emitted in ReplayContext cannot reach LiveContext listeners.
 *         (structural: different kernel objects, different listener arrays)
 *   CI-2  ReplayContext clock does not advance LiveContext clock.
 *         (structural: each kernel owns an isolated clock instance, T-1)
 *   CI-3  ReplayContext ring is independent of LiveContext ring.
 *         (structural: separate ring buffer objects)
 *   CI-4  FULL and LOCAL_ONLY adapters are null adapters in ReplayContext.
 *         (enforced by adapter-sandbox at instantiation time)
 *   CI-5  Gates in ReplayContext emit only to the replay kernel — never to
 *         external buses or live subscribers.
 *         (structural: gates call kernel.ingest() on the replay kernel only)
 *   CI-6  Replay is deterministic: same snapshot + same opts → same result.
 *         (snapshot events carry origEventTs; clock seeded from snapshot)
 *
 * Eliminated: the `isReplay = !!meta.replayOf` flag inside kernel.ingest().
 * Context is the execution boundary — the kernel does not need to know which
 * context it is operating in. That distinction belongs here.
 *
 * @hook e1f2a3b4-c5d6-4e7f-8a9b-0c1d2e3f4a5b  createLiveContext
 * @hook f2a3b4c5-d6e7-4f8a-9b0c-1d2e3f4a5b6c  createReplayContext
 * @hook a3b4c5d6-e7f8-4a9b-0c1d-2e3f4a5b6c7d  ContextCompletionRecord
 * @hook b4c5d6e7-f8a9-4b0c-1d2e-3f4a5b6c7d8e  CONTEXT_LIVE
 * @hook c5d6e7f8-a9b0-4c1d-2e3f-4a5b6c7d8e9f  CONTEXT_REPLAY
 */

'use strict';

import { createKernel }                from '../kernel/index.js';
import { restore }                     from '../compress/index.js';
import { computeDeltaStream }          from '../delta/index.js';
import {
  createAdapterSandbox,
  POLICY_READ_ONLY, POLICY_LOCAL_ONLY, POLICY_FULL,
} from '../adapter-sandbox/index.js';
import { classify as sigmaClassify } from '../sigma/index.js';

// ── Context type constants ────────────────────────────────────────────────────

/** @hook b4c5d6e7-f8a9-4b0c-1d2e-3f4a5b6c7d8e  context:CONTEXT_LIVE */
export const CONTEXT_LIVE   = 'live';

/** @hook c5d6e7f8-a9b0-4c1d-2e3f-4a5b6c7d8e9f  context:CONTEXT_REPLAY */
export const CONTEXT_REPLAY = 'replay';

// ── createLiveContext ─────────────────────────────────────────────────────────

/**
 * Wrap a kernel for real-time event ingestion.
 *
 * The caller owns the kernel — createLiveContext does not create one.
 * This keeps the factory pattern explicit: the kernel is the shared artifact
 * (per the Kernel Definition spec); context wraps it for adapter management.
 *
 * If a sandbox is provided, adapters are instantiated through it with
 * full side-effect permissions (not replay mode).
 *
 * @hook e1f2a3b4-c5d6-4e7f-8a9b-0c1d2e3f4a5b  context:createLiveContext
 *
 * @param {object}  kernel          — kernel instance (from createKernel())
 * @param {object}  [sandbox]       — AdapterSandbox instance (optional)
 * @returns {LiveContext}
 */
export function createLiveContext(kernel, sandbox = null) {
  if (!kernel || typeof kernel.ingest !== 'function') {
    throw new Error('[context] createLiveContext: kernel must be a valid kernel instance');
  }

  const _contextId = _newContextId('live');
  const _adapters  = new Map(); // name → adapter instance

  /**
   * Instantiate an adapter through the sandbox (live — full permissions).
   * No-op if no sandbox provided.
   */
  function mountAdapter(name, factoryOpts = {}) {
    if (!sandbox) throw new Error('[context] no sandbox — pass sandbox to createLiveContext to mount adapters');
    const adapter = sandbox.instantiate(name, kernel, { replay: false, factoryOpts });
    _adapters.set(name, adapter);
    return adapter;
  }

  function getAdapter(name) {
    return _adapters.get(name) || null;
  }

  function listAdapters() {
    return [..._adapters.keys()];
  }

  return Object.freeze({
    type:        CONTEXT_LIVE,
    contextId:   _contextId,
    kernel,
    mountAdapter,
    getAdapter,
    listAdapters,
    // Delegate core kernel API for ergonomics
    ingest:      (...args) => kernel.ingest(...args),
    subscribe:   (...args) => kernel.subscribe(...args),
    getAll:      ()        => kernel.getAll(),
    findById:    (id)      => kernel.findById(id),
  });
}

// ── createReplayContext ───────────────────────────────────────────────────────

/**
 * Create a hermetically isolated replay world from a validated snapshot.
 *
 * The snapshot must have already passed through the version gate:
 *   const valid    = versionGate.validate(raw);
 *   const migrated = versionGate.migrate(valid);
 *   const replay   = createReplayContext(migrated, opts);
 *
 * Isolation guarantees (CI-1..CI-6):
 *   - Owns a fresh kernel instance (CI-1, CI-2, CI-3)
 *   - Adapters mounted through sandbox with replay=true (CI-4)
 *   - Gates fire only into replay kernel (CI-5)
 *   - origEventTs from snapshot seeds clock deterministically (CI-6)
 *
 * @hook f2a3b4c5-d6e7-4f8a-9b0c-1d2e3f4a5b6c  context:createReplayContext
 *
 * @param {object}  snapshot        — validated+migrated NEX-SNAP artifact
 * @param {object}  [opts]
 *   opts.sandbox   {AdapterSandbox}  if provided, adapters are mounted as null
 *   opts.ringCap   {number}          ring capacity override
 * @returns {ReplayContext}
 */
export function createReplayContext(snapshot, opts = {}) {
  if (!snapshot || typeof snapshot !== 'object') {
    throw new Error('[context] createReplayContext: snapshot must be a non-null object');
  }

  const magic = snapshot.magic;
  if (magic !== 'NEX-SNAP' && magic !== 'URCK-SNAP') {
    throw new Error(`[context] createReplayContext: snapshot must be NEX-SNAP or URCK-SNAP, got '${magic}'`);
  }

  const _contextId = _newContextId('replay');
  const sandbox    = opts.sandbox || null;
  const _adapters  = new Map();

  // CI-1,2,3: fresh isolated kernel — no shared state with any live kernel
  // restore() handles snapshot decoding: delta timestamps, payload deltas,
  // edge type codes, causedBy reconstruction. Gates fire into this kernel only.
  const ringCap = opts.ringCap || undefined;
  const _kernel = restore(snapshot, ringCap ? { ringCap } : {});

  // Pre-compute the ordered event list once — replay steps through this.
  const _events = _kernel.getAll();
  let   _ran    = false;
  let   _done   = false;

  // Mount null adapters for sandbox entries (CI-4)
  if (sandbox) {
    for (const reg of sandbox.listRegistrations()) {
      try {
        const adapter = sandbox.instantiate(reg.name, _kernel, { replay: true });
        _adapters.set(reg.name, adapter);
      } catch (_) {
        // Registration may have been removed — skip silently, not a hard error
      }
    }
  }

  // ── run() ──────────────────────────────────────────────────────────────────

  /**
   * Step through all events in the replay kernel, calling onStep for each.
   *
   * onStep receives (event, index) — the event as stored in the replay ring,
   * and its position in the ordered sequence.
   *
   * Gates have already fired during restore() — the ring contains their output.
   * run() is an observation pass, not a re-ingestion pass.
   *
   * Throws if called more than once — ReplayContext is single-use (spec: "replay
   * is now eligible for GC — no cleanup phase, no exit mode").
   */
  function run({ onStep } = {}) {
    if (_ran) throw new Error('[context] ReplayContext.run() may only be called once');
    _ran = true;

    for (let i = 0; i < _events.length; i++) {
      const ev = _events[i];
      if (typeof onStep === 'function') {
        try { onStep(ev, i); } catch (_) { /* observer errors do not halt replay */ }
      }
    }

    _done = true;
  }

  // ── complete() ─────────────────────────────────────────────────────────────

  /**
   * Seal the replay and return the completion record.
   *
   * May be called without run() — useful when only the causal graph or
   * delta stream is needed without stepping.
   *
   * Returns ContextCompletionRecord:
   *   { contextId, type, eventCount, ring, deltaStream, stabilityReport }
   *
   * stabilityReport is null until sigma.js is built (Phase R5).
   *
   * @hook a3b4c5d6-e7f8-4a9b-0c1d-2e3f4a5b6c7d  context:ContextCompletionRecord
   */
  function complete() {
    const ring = _kernel.getAll();

    // Delta stream — pure measurement, replay-deterministic (uses eventTs not ts)
    let deltaStream = null;
    try {
      deltaStream = computeDeltaStream(
        ring,
        id => _kernel.findById(id),
        id => _kernel.edgeMeta(id),
        id => _kernel.getChildren(id),
      );
    } catch (_) {
      deltaStream = [];
    }

    return Object.freeze({
      contextId:        _contextId,
      type:             CONTEXT_REPLAY,
      eventCount:       ring.length,
      ring,
      deltaStream,
      stabilityReport:  deltaStream && deltaStream.length >= 3
        ? sigmaClassify(deltaStream)
        : null,
      completedAt:      Date.now(),
    });
  }

  function getAdapter(name) {
    return _adapters.get(name) || null;
  }

  function listAdapters() {
    return [..._adapters.keys()];
  }

  return Object.freeze({
    type:      CONTEXT_REPLAY,
    contextId: _contextId,
    // Read-only kernel access — consumers observe, never mutate
    getAll:    ()   => _kernel.getAll(),
    findById:  (id) => _kernel.findById(id),
    edgeMeta:  (id) => _kernel.edgeMeta(id),
    getChildren:(id)=> _kernel.getChildren(id),
    run,
    complete,
    getAdapter,
    listAdapters,
    get eventCount() { return _events.length; },
    get ran()        { return _ran; },
    get done()       { return _done; },
  });
}

// ── Internal helpers ──────────────────────────────────────────────────────────

let _contextSeq = 0;
function _newContextId(type) {
  return `ctx:${type}:${++_contextSeq}:${Date.now().toString(36)}`;
}
