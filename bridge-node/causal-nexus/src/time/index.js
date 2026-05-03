// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
/**
 * @module       time
 * @uuid         ce9aac88-c293-4951-a2ea-0f565538c1da
 * @version      5.0.0
 *
 * Kernel-local monotonic clocks and time utilities.
 * No global state — each kernel instance creates its own clock (T-1).
 *
 * Two time axes (T-2):
 *   ts       — wall-clock (Date.now()) for display only, never for ordering
 *   eventTs  — logical tick counter for ordering and gate window math
 *
 * @hook 4ed4b385-c2c6-47a6-8d89-0c4cc8b6dadd  createClock
 * @hook c7a6165e-3885-4e3c-b48b-29007da1bf34  wallNow
 * @hook a4daa9f1-9f59-4bde-8d6c-77e74e606096  causalOrder
 * @hook 136bf8d9-3d8b-422d-97e9-65854d45d1a5  seqPrecedes
 * @hook f98b6248-2864-4c23-9b0f-a6836cb75d24  formatWallTs
 * @hook cea615e8-c09e-4091-8be5-790b06388c3b  formatEventTs
 */

/**
 * Create an isolated monotonic clock for a single kernel instance.
 * Each kernel creates its own clock — they never share state (T-1).
 *
 * @hook 4ed4b385-c2c6-47a6-8d89-0c4cc8b6dadd  time:createClock
 */
export function createClock() {
  let _tick = 0;
  let _seq  = 0;

  return {
    /** Advance and return the next event-time tick. One tick per ingest call. */
    nextTick() { return ++_tick; },

    /** Advance and return the next sequence number. Global ingestion order. */
    nextSeq()  { return ++_seq; },

    /** Current tick (read-only peek, does not advance). */
    get tick() { return _tick; },

    /** Current seq (read-only peek, does not advance). */
    get seq()  { return _seq; },

    /** Reset both counters to zero. ONLY called by kernel.reset(). */
    reset() { _tick = 0; _seq = 0; },
  };
}

/**
 * Wall-clock timestamp for display purposes only.
 * Never used for ordering or gate window logic (T-2).
 * @hook c7a6165e-3885-4e3c-b48b-29007da1bf34  time:wallNow
 */
export function wallNow() {
  return Date.now();
}

/**
 * Compute causal ordering between two events based on seq.
 * Does NOT incorporate wall-clock time (T-2).
 * Returns -1, 0, or 1.
 * @hook a4daa9f1-9f59-4bde-8d6c-77e74e606096  time:causalOrder
 */
export function causalOrder(a, b) {
  if (a.seq < b.seq) return -1;
  if (a.seq > b.seq) return  1;
  return 0;
}

/**
 * True if event A causally precedes event B by sequence number.
 * For full causal precedence including edges, use the causal engine.
 * @hook 136bf8d9-3d8b-422d-97e9-65854d45d1a5  time:seqPrecedes
 */
export function seqPrecedes(a, b) {
  return a.seq < b.seq;
}

/**
 * Format a wall-clock timestamp for display → HH:MM:SS.mmm
 * @hook f98b6248-2864-4c23-9b0f-a6836cb75d24  time:formatWallTs
 */
export function formatWallTs(ms) {
  const d = new Date(ms);
  return String(d.getHours()).padStart(2, '0') + ':'
       + String(d.getMinutes()).padStart(2, '0') + ':'
       + String(d.getSeconds()).padStart(2, '0') + '.'
       + String(d.getMilliseconds()).padStart(3, '0');
}

/**
 * Format an event-time tick for display → [ets:N]
 * @hook cea615e8-c09e-4091-8be5-790b06388c3b  time:formatEventTs
 */
export function formatEventTs(tick) {
  return `[ets:${tick}]`;
}
