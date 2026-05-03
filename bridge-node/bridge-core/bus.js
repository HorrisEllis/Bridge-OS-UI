// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
'use strict';
/**
 * bridge-core/bus.js
 * Central event bus for bridge-node ecosystem.
 * SISO-backed. Every event has UUID, ts, source, level.
 * IME can subscribe to receive all bus events for behavioral profiling.
 *
 * Usage:
 *   const bus = createBus();
 *   bus.on('userscript:connected', (data) => { ... });
 *   bus.emit('userscript:connected', { sessionId }, 'INFO');
 */

'use strict';

const crypto = require('crypto');
const { Event, Gate, Stream, StreamLog } = require('./siso/index');

function createBus({ logLevel = 'EVENTS', ime = null } = {}) {
  const log     = new StreamLog(logLevel);
  const stream  = new Stream(log);
  const _listeners = new Map();  // sig → Set<fn>
  const _wildcard  = new Set();  // listeners for all events
  let   _seqNum    = 0;

  // ── Meta-health: tracks silent degradation conditions ─────────────────────
  // The bus can degrade silently (wildcard errors swallowed, causal disabled,
  // DHT empty). This object makes those conditions observable so operators
  // are not running a blind system. Check via bus.health().
  const _metaHealth = {
    observerErrors:    0,   // count of swallowed wildcard listener errors
    causalDisabled:    false,
    dhtEmpty:          false,
    lastDegradeSignal: null,
  };

  // Every gate just calls registered listeners — transform is the dispatch
  function _ensureGate(sig) {
    if (!stream._gates.has(sig)) {
      stream.addGate(new Gate(sig, (data, event) => {
        const fns = _listeners.get(sig) || new Set();
        for (const fn of fns) {
          try { fn(data, event); } catch (e) {
            console.error(`[bus] listener error on ${sig}:`, e.message);
          }
        }
        return data;
      }));
    }
  }

  // Shallow-copy is sufficient for the enriched bus envelope (only scalar fields
  // are added). However, for critical paths that reason about payload integrity
  // (IME, SNR gate, causal kernel), we pass a structured-cloned snapshot of the
  // original data. This closes the invariant gap where a module retaining a
  // reference to the original data object could mutate nested fields after
  // emission, causing causal log ≠ actual event at replay time.
  function _safeClone(obj) {
    try { return structuredClone(obj); } catch {
      // structuredClone not available (Node <17) — fall back to JSON round-trip
      try { return JSON.parse(JSON.stringify(obj)); } catch { return { ...obj }; }
    }
  }

  function emit(sig, data = {}, level = 'INFO') {
    const enriched = {
      ...data,
      _busId:  crypto.randomUUID(),
      _seq:    _seqNum++,
      _ts:     Date.now(),
      _level:  level,
      _sig:    sig,
    };

    _ensureGate(sig);
    const result = stream.emit(new Event(sig, enriched));

    // Feed IME using a deep clone of the original data — prevents mutations
    // to nested payload fields post-emit from corrupting the IME profile or
    // breaking causal log replay determinism.
    if (ime && data._uuid) {
      const safeData = _safeClone(data);
      ime.ingest({
        uuid:      safeData._uuid,
        type:      _mapSigToIMEType(sig),
        timestamp: enriched._ts,
        payload:   { sig, source: safeData.source || null, tool: safeData.tool || null },
      });
    }

    // Wildcard listeners — swallowed errors are intentional (low priority observers)
    // but we emit a meta-signal so degradation is observable
    for (const fn of _wildcard) {
      try { fn(sig, enriched); } catch (e) {
        // Meta-signal: wildcard listener failure — do not recursively emit if sig is meta
        _metaHealth.observerErrors++;
        _metaHealth.lastDegradeSignal = Date.now();
        if (sig !== 'bus:meta:observer_error') {
          try { emit('bus:meta:observer_error', { sig, error: e.message, totalErrors: _metaHealth.observerErrors }, 'WARN'); } catch {}
        }
      }
    }

    return result;
  }

  function on(sig, fn) {
    _ensureGate(sig);
    if (!_listeners.has(sig)) _listeners.set(sig, new Set());
    _listeners.get(sig).add(fn);
    return () => off(sig, fn); // returns unsubscribe fn
  }

  function off(sig, fn) {
    _listeners.get(sig)?.delete(fn);
  }

  function onAll(fn) {
    _wildcard.add(fn);
    return () => _wildcard.delete(fn);
  }

  function once(sig, fn) {
    const wrapped = (data, event) => { fn(data, event); off(sig, wrapped); };
    return on(sig, wrapped);
  }

  function _mapSigToIMEType(sig) {
    if (sig.startsWith('agent.'))       return 'agent.tool_call';
    if (sig.startsWith('ssh.'))         return 'ssh.command';
    if (sig.startsWith('file.'))        return 'file.read';
    if (sig.startsWith('mesh.'))        return 'mesh.connection';
    if (sig.startsWith('data.'))        return 'data.push';
    if (sig.startsWith('http.'))        return 'http.request';
    if (sig.startsWith('guardian.'))    return 'guardian.event';
    return 'http.request';
  }

  function health() {
    return {
      ok:               _metaHealth.observerErrors === 0 && !_metaHealth.causalDisabled,
      observerErrors:   _metaHealth.observerErrors,
      causalDisabled:   _metaHealth.causalDisabled,
      dhtEmpty:         _metaHealth.dhtEmpty,
      lastDegradeSignal: _metaHealth.lastDegradeSignal,
    };
  }
  function setMeta(key, val) { if (key in _metaHealth) _metaHealth[key] = val; }

  return { emit, on, off, once, onAll, log, stream, health, setMeta };
}

module.exports = { createBus };
