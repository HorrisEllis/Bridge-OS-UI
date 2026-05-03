// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
'use strict';
/**
 * bridge-core/siso/index.js
 * SISO: Event → Gate → Stream → StreamLog
 * Pure functional event-driven framework. Zero external dependencies.
 * Extracted from bridge-node for standalone use across all modules.
 *
 * AXIOMS:
 * - Signature collision is a hard error
 * - Transforms run depth-first, synchronously
 * - Pending is residue — not an error state
 * - The log observes — it does not consume
 * - Sub-streams share the parent log
 */

// ── Event ─────────────────────────────────────────────────────────────────────
class Event {
  constructor(sig, data = {}) {
    if (!sig || typeof sig !== 'string') throw new Error('[SISO] Event sig must be a non-empty string');
    this.sig  = sig;
    this.data = data;
    this.ts   = Date.now();
    Object.freeze(this);
  }
}

// ── Gate ──────────────────────────────────────────────────────────────────────
class Gate {
  constructor(sig, transform) {
    if (!sig) throw new Error('[SISO] Gate sig required');
    if (typeof transform !== 'function') throw new Error('[SISO] Gate transform must be a function');
    this.sig       = sig;
    this.transform = transform;
  }
}

// ── Stream ────────────────────────────────────────────────────────────────────
class Stream {
  constructor(log = null, { bufferPending = false, maxPendingBuffer = 64 } = {}) {
    this._gates    = new Map();  // sig → Gate (O(1) lookup)
    this._log      = log;
    this._eventCount = 0;
    // PENDING-01 fix: optionally buffer events that arrive before a gate is registered.
    // When a gate is later added via addGate(), buffered events for that sig are
    // replayed immediately. This eliminates the non-deterministic boot-order race
    // where modules emit events before their consuming gates are registered.
    this._bufferPending  = bufferPending;
    this._pendingBuffer  = new Map();  // sig → Event[]
    this._maxPendingBuf  = maxPendingBuffer;
  }

  // Add a gate. Collision is a hard error.
  addGate(gate) {
    if (!(gate instanceof Gate)) throw new Error('[SISO] addGate requires a Gate instance');
    if (this._gates.has(gate.sig)) {
      throw new Error(`[SISO] Signature collision: "${gate.sig}" already registered`);
    }
    this._gates.set(gate.sig, gate);
    // Replay any buffered pending events for this sig
    if (this._bufferPending && this._pendingBuffer.has(gate.sig)) {
      const buffered = this._pendingBuffer.get(gate.sig);
      this._pendingBuffer.delete(gate.sig);
      for (const event of buffered) {
        this._log?.observe(event, 'replayed');
        try { gate.transform(event.data, event); } catch {}
      }
    }
    return this;
  }

  // Remove a gate by sig
  removeGate(sig) {
    this._gates.delete(sig);
    return this;
  }

  // Emit an event through the gate chain
  emit(event) {
    if (!(event instanceof Event)) throw new Error('[SISO] emit requires an Event instance');
    this._eventCount++;
    this._log?.observe(event, 'emit');

    const gate = this._gates.get(event.sig);
    if (!gate) {
      this._log?.observe(event, 'pending');
      if (this._bufferPending) {
        // Buffer the event so it replays when the gate is registered later
        if (!this._pendingBuffer.has(event.sig)) this._pendingBuffer.set(event.sig, []);
        const buf = this._pendingBuffer.get(event.sig);
        if (buf.length < this._maxPendingBuf) buf.push(event);
        // else: buffer full, oldest events silently drop (still capped, not unbounded)
      }
      return { status: 'pending', event, residue: event };
    }

    // Depth-first synchronous transform
    let result;
    try {
      result = gate.transform(event.data, event);
    } catch (err) {
      this._log?.observe(event, 'error', err);
      return { status: 'error', event, error: err };
    }

    const out = { status: 'ok', event, result };
    this._log?.observe(event, 'ok', null, result);
    return out;
  }

  // Sub-stream shares parent log
  sub() {
    return new Stream(this._log);
  }

  get size()       { return this._gates.size; }
  get eventCount() { return this._eventCount; }
}

// ── StreamLog ─────────────────────────────────────────────────────────────────
const LOG_LEVELS = { OFF: 0, EVENTS: 1, DEEP: 2, DATA: 3 };

class StreamLog {
  constructor(level = 'EVENTS') {
    this._level    = LOG_LEVELS[level] ?? LOG_LEVELS.EVENTS;
    this._entries  = [];
    this._listeners = [];
  }

  setLevel(level) {
    this._level = LOG_LEVELS[level] ?? this._level;
  }

  observe(event, status, error = null, result = null) {
    if (this._level === LOG_LEVELS.OFF) return;

    const entry = {
      ts:     Date.now(),
      sig:    event.sig,
      status,
    };

    if (this._level >= LOG_LEVELS.DEEP) {
      entry.error = error ? error.message : null;
    }
    if (this._level >= LOG_LEVELS.DATA) {
      entry.data   = event.data;
      entry.result = result;
    }

    this._entries.push(entry);
    if (this._entries.length > 10000) this._entries.shift();
    for (const fn of this._listeners) fn(entry);
  }

  on(fn)  { this._listeners.push(fn); }
  off(fn) { this._listeners = this._listeners.filter(f => f !== fn); }

  query(filter = {}) {
    return this._entries.filter(e => {
      if (filter.sig    && e.sig    !== filter.sig)    return false;
      if (filter.status && e.status !== filter.status) return false;
      if (filter.since  && e.ts < filter.since)        return false;
      return true;
    });
  }

  get entries() { return [...this._entries]; }
}

module.exports = { Event, Gate, Stream, StreamLog, LOG_LEVELS };
