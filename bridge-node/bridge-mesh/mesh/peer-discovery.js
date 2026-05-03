// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
'use strict';
/**
 * bridge-mesh/mesh/peer-discovery.js
 * Peer discovery cascade:
 *   1. LAN pulse listener (UDP :7777)
 *   2. Manual registration (hub/admin)
 *   3. STUN probe (TODO: Gate 5)
 *   4. TURN relay (TODO: Gate 5)
 *
 * LAN Trust Invariant (non-negotiable):
 * LAN pulse discovery = routing convenience only.
 * A node discovered via LAN still requires full signed handshake.
 * Proximity is not a credential.
 */

const { verifyHandshake } = require('../../bridge-identity/identity');

// ── Peer record ───────────────────────────────────────────────────────────────
function makePeer(handshakeResult, address, discoveredVia) {
  return {
    uuid:          handshakeResult.uuid,
    publicKey:     handshakeResult.publicKey,
    groupHint:     handshakeResult.groupHint || null,
    address,
    discoveredVia, // 'lan' | 'manual' | 'stun' | 'turn'
    // LAN discovery grants NO trust bonus — must go through sngate
    trustTier:    discoveredVia === 'lan' ? 'unverified' : 'unverified',
    firstSeen:    Date.now(),
    lastSeen:     Date.now(),
    verified:     true, // handshake passed — cryptographic claim valid
  };
}

// ── Peer registry ─────────────────────────────────────────────────────────────
function createPeerRegistry({ busEmit = null, gate = null } = {}) {
  const _peers = new Map();  // uuid → peer

  // Attempt to register a peer from a raw handshake payload.
  // Returns { ok, peer, reason } — never throws.
  function registerFromHandshake(rawHandshake, address, discoveredVia = 'manual') {
    // Step 1: cryptographic verification
    const result = verifyHandshake(rawHandshake);
    if (!result.ok) {
      busEmit?.('mesh:handshake:rejected', {
        address, reason: result.reason, discoveredVia,
      }, 'WARN');
      return { ok: false, reason: result.reason };
    }

    // Step 2: sngate mesh adapter (if wired)
    let gateDecision = 'allow';
    if (gate) {
      const gateResult = gate.evaluateMeshHandshake(result);
      gateDecision = gateResult.decision;
      if (gateDecision === 'deny') {
        busEmit?.('mesh:peer:blocked', {
          uuid: result.uuid, address, reason: gateResult.reason,
        }, 'WARN');
        return { ok: false, reason: `sngate denied: ${gateResult.reason}` };
      }
    }

    // Step 3: register (upsert)
    const existing = _peers.get(result.uuid);
    const peer = existing
      ? { ...existing, lastSeen: Date.now(), address }
      : makePeer(result, address, discoveredVia);

    _peers.set(result.uuid, peer);

    busEmit?.('mesh:peer:registered', {
      uuid:         peer.uuid,
      address,
      discoveredVia,
      gateDecision,
      groupHint:    peer.groupHint,
    }, 'INFO');

    return { ok: true, peer };
  }

  function get(uuid)    { return _peers.get(uuid) || null; }
  function list()       { return [..._peers.values()]; }
  function remove(uuid) { _peers.delete(uuid); }

  function seen(uuid) {
    const p = _peers.get(uuid);
    if (p) p.lastSeen = Date.now();
  }

  // Peers that haven't been seen in threshold ms
  function stalePeers(thresholdMs = 60000) {
    const cutoff = Date.now() - thresholdMs;
    return [..._peers.values()].filter(p => p.lastSeen < cutoff);
  }

  return { registerFromHandshake, get, list, remove, seen, stalePeers };
}

module.exports = { createPeerRegistry, makePeer };
