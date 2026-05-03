// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
'use strict';
/**
 * bridge-core/registry/index.js
 * Version: 1.1.0
 *
 * NodeRegistry — pure state ledger. Observes facts. Emits events. Makes NO decisions.
 *
 * Lifecycle authority contract:
 *   heartbeat  → calls seen() / missedBeat()
 *   heartbeat  → calls evict() when 10 missed beats confirmed
 *   trustMesh  → calls updateTrust() (advisory score only)
 *   boot.js    → bus.on('node:evicted') → nodeRegistry.remove()
 *
 * §1.2  Nothing silently fails. All transitions emit loudly.
 * §2.3  All state observable. Every lifecycle transition emits a bus event.
 * §5.1  Everything has a UUID, hook, event bus registration.
 * §5.7  Low coupling. Registry never calls heartbeat. Heartbeat calls registry.
 */

const crypto = require('crypto');

const LIFECYCLE = {
  ACTIVE:   'active',
  DEGRADED: 'degraded',
  DEAD:     'dead',
  EVICTED:  'evicted',
};

function createNodeRegistry({ busEmit = null } = {}) {
  const _nodes = new Map();

  function _emit(sig, data) {
    if (typeof busEmit === 'function') {
      try { busEmit(sig, { ...data, _uuid: data.uuid }, 'INFO'); } catch {}
    }
  }

  function register(node) {
    if (!node.uuid) throw new Error('[NodeRegistry] node.uuid required');

    const existing = _nodes.get(node.uuid);
    if (existing) {
      const changed = [];
      if (node.address   && node.address   !== existing.address)   { existing.address   = node.address;   changed.push('address'); }
      if (node.groupHint && node.groupHint !== existing.groupHint) { existing.groupHint = node.groupHint; changed.push('groupHint'); }
      if (node.publicKey && node.publicKey !== existing.publicKey) { existing.publicKey = node.publicKey; changed.push('publicKey'); }
      existing.lastSeen    = Date.now();
      existing.missedBeats = 0;
      existing.lifecycle   = LIFECYCLE.ACTIVE;
      if (changed.length) _emit('node:updated', { uuid: node.uuid, changed, address: existing.address });
      return existing;
    }

    const record = {
      uuid:        node.uuid,
      publicKey:   node.publicKey  || null,
      groupHint:   node.groupHint  || null,
      address:     node.address    || null,
      port:        node.port       || null,
      trustScore:  node.trustScore ?? 5,
      firstSeen:   Date.now(),
      lastSeen:    Date.now(),
      missedBeats: 0,
      lifecycle:   LIFECYCLE.ACTIVE,
    };
    _nodes.set(node.uuid, record);
    _emit('node:registered', { uuid: record.uuid, address: record.address, groupHint: record.groupHint });
    return record;
  }

  function seen(uuid) {
    const n = _nodes.get(uuid);
    if (!n) return;
    const wasNotActive = n.lifecycle !== LIFECYCLE.ACTIVE;
    n.lastSeen    = Date.now();
    n.missedBeats = 0;
    n.lifecycle   = LIFECYCLE.ACTIVE;
    if (wasNotActive) _emit('node:revived', { uuid, lifecycle: LIFECYCLE.ACTIVE });
  }

  function missedBeat(uuid, { degradeAt = 3, deadAt = 10 } = {}) {
    const n = _nodes.get(uuid);
    if (!n) return;
    n.missedBeats++;
    if (n.missedBeats >= deadAt && n.lifecycle !== LIFECYCLE.DEAD && n.lifecycle !== LIFECYCLE.EVICTED) {
      n.lifecycle = LIFECYCLE.DEAD;
      _emit('node:state:dead', { uuid, missedBeats: n.missedBeats });
    } else if (n.missedBeats >= degradeAt && n.lifecycle === LIFECYCLE.ACTIVE) {
      n.lifecycle = LIFECYCLE.DEGRADED;
      _emit('node:state:degraded', { uuid, missedBeats: n.missedBeats });
    }
  }

  function evict(uuid, reason = 'heartbeat:dead') {
    const n = _nodes.get(uuid);
    if (!n) return;
    n.lifecycle = LIFECYCLE.EVICTED;
    _emit('node:evicted', { uuid, reason, missedBeats: n.missedBeats, lastSeen: n.lastSeen });
  }

  function remove(uuid) {
    _nodes.delete(uuid);
  }

  function get(uuid) { return _nodes.get(uuid) || null; }

  function list({ all = false } = {}) {
    const nodes = [..._nodes.values()];
    if (all) return nodes;
    return nodes.filter(n => n.lifecycle === LIFECYCLE.ACTIVE || n.lifecycle === LIFECYCLE.DEGRADED);
  }

  function updateTrust(uuid, score) {
    const n = _nodes.get(uuid);
    if (n) n.trustScore = Math.max(0, Math.min(10, score));
  }

  function diagnostics() {
    const all = [..._nodes.values()];
    return {
      total:    all.length,
      active:   all.filter(n => n.lifecycle === LIFECYCLE.ACTIVE).length,
      degraded: all.filter(n => n.lifecycle === LIFECYCLE.DEGRADED).length,
      dead:     all.filter(n => n.lifecycle === LIFECYCLE.DEAD).length,
      evicted:  all.filter(n => n.lifecycle === LIFECYCLE.EVICTED).length,
    };
  }

  return { register, seen, missedBeat, evict, remove, get, list, updateTrust, diagnostics, LIFECYCLE };
}

// ── CalltoRegistry ────────────────────────────────────────────────────────────
const NON_DOM_CALLTOS = [
  'browser.download', 'browser.permission.request', 'browser.window.create',
  'browser.tab.capture', 'browser.file.choose', 'browser.auth.popup',
  'browser.iframe.cross-origin', 'browser.certificate.accept',
];

function createCalltoRegistry() {
  const _calltos = new Map();

  function register({ action, selector, origin, sessionId, tag, meta = {} }) {
    const uuid = 'ct_' + crypto.randomBytes(8).toString('hex');
    const callto = {
      uuid, action, selector, origin, sessionId,
      tag:         tag  || null,
      meta,
      status:      'registered',
      createdAt:   Date.now(),
      executedAt:  null,
      result:      null,
      error:       null,
      requiresCDP: NON_DOM_CALLTOS.includes(action),
      method:      null,
    };
    _calltos.set(uuid, callto);
    return callto;
  }

  function get(uuid)     { return _calltos.get(uuid) || null; }
  function delete_(uuid) { _calltos.delete(uuid); }

  function list({ origin, sessionId, status } = {}) {
    let all = [..._calltos.values()];
    if (origin)    all = all.filter(c => c.origin    === origin);
    if (sessionId) all = all.filter(c => c.sessionId === sessionId);
    if (status)    all = all.filter(c => c.status    === status);
    return all.sort((a, b) => b.createdAt - a.createdAt);
  }

  function resolve(uuid, { result, error, method }) {
    const c = _calltos.get(uuid);
    if (!c) return null;
    c.status     = error ? 'error' : 'ok';
    c.result     = result || null;
    c.error      = error  || null;
    c.executedAt = Date.now();
    c.method     = method || null;
    return c;
  }

  return { register, get, delete: delete_, list, resolve };
}

module.exports = { createCalltoRegistry, createNodeRegistry, NON_DOM_CALLTOS, LIFECYCLE };
