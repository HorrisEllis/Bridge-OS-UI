// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
'use strict';

/**
 * bridge-mesh/kernel.js
 * Production-safe sovereign mesh kernel
 *
 * Core principles:
 * - deterministic state transitions
 * - no implicit trust escalation
 * - race-safe channel creation
 * - replay protection enforced
 * - bus used only for events (not RPC)
 */

const crypto = require('crypto');

const { createPeerRegistry }        = require('./mesh/peer-discovery');
const { createSecureChannel,
        generateSessionKeypair,
        deriveSessionKey,
        encrypt,
        decrypt }                  = require('./mesh/channel');

const { createTrustSignalHandler }  = require('./mesh/trust-signal');
const { createPortRegistry }        = require('./network/port-registry');
const { createHostRotator }         = require('./network/host-rotation');

/* ──────────────────────────────────────────────────────────────── */
/* STATE MACHINE                                                   */
/* ──────────────────────────────────────────────────────────────── */

const PeerState = {
  UNKNOWN: 'UNKNOWN',
  DISCOVERED: 'DISCOVERED',
  VERIFIED: 'VERIFIED',
  TRUSTED: 'TRUSTED',
  CONNECTED: 'CONNECTED',
  EXPIRED: 'EXPIRED'
};

/* ──────────────────────────────────────────────────────────────── */
/* KERNEL                                                          */
/* ──────────────────────────────────────────────────────────────── */

function createMeshNode({ identity = null, gate = null, ime = null, busEmit = null } = {}) {

  const peers       = createPeerRegistry({ busEmit, gate });
  const trust       = createTrustSignalHandler({ ime, gate, busEmit, identity });
  const ports       = createPortRegistry();
  const rotator     = createHostRotator();

  /* ── internal state ─────────────────────────────────────────── */

  const channels     = new Map(); // peerUuid → channel
  const channelLocks = new Map(); // peerUuid → boolean
  const nonces       = new Map(); // peerUuid → Set(nonce)

  /* ── helpers ─────────────────────────────────────────────────── */

  function isReplay(peerUuid, nonce) {
    if (!nonces.has(peerUuid)) nonces.set(peerUuid, new Set());

    const set = nonces.get(peerUuid);
    if (set.has(nonce)) return true;

    set.add(nonce);

    // TTL cleanup (simple bounded memory)
    if (set.size > 1000) set.clear();

    return false;
  }

  function setState(peer, newState) {
    peer.state = newState;
    peer.lastStateChange = Date.now();

    busEmit?.('mesh:peer:state', {
      uuid: peer.uuid,
      state: newState
    });
  }

  function canConnect(peer) {
    return trust.isTrusted(peer.uuid) === true;
  }

  /* ── CHANNEL LIFECYCLE (RACE SAFE) ─────────────────────────── */

  async function openChannel(peerUuid, theirPubKeyB64) {

    const peer = peers.get(peerUuid);
    if (!peer) throw new Error(`Unknown peer: ${peerUuid}`);

    /* trust gate */
    if (!canConnect(peer)) {
      throw new Error(`Peer not trusted: ${peerUuid}`);
    }

    /* race lock */
    if (channelLocks.get(peerUuid)) {
      return channels.get(peerUuid);
    }
    channelLocks.set(peerUuid, true);

    try {
      if (channels.has(peerUuid)) {
        return channels.get(peerUuid);
      }

      const { privateKey, publicKeyB64 } = generateSessionKeypair();
      const sessionKey = deriveSessionKey(privateKey, theirPubKeyB64);

      const channel = createSecureChannel({
        peerUuid,
        sessionKey
      });

      channels.set(peerUuid, channel);

      setState(peer, PeerState.CONNECTED);

      busEmit?.('mesh:channel:opened', {
        peerUuid,
        publicKeyB64
      });

      return channel;

    } finally {
      channelLocks.set(peerUuid, false);
    }
  }

  function closeChannel(peerUuid) {
    channels.delete(peerUuid);
    channelLocks.delete(peerUuid);

    busEmit?.('mesh:channel:closed', { peerUuid });
  }

  /* ── HANDSHAKE PIPELINE (SAFE + VERIFIED) ───────────────────── */

  function handleHandshake({ handshake, address }) {

    if (!handshake?.nonce || !handshake?.signature || !handshake?.pubKey) {
      return { ok: false, error: 'INVALID_HANDSHAKE' };
    }

    /* replay protection */
    if (isReplay(handshake.uuid, handshake.nonce)) {
      return { ok: false, error: 'REPLAY_DETECTED' };
    }

    /* verify identity integrity */
    const peer = peers.verifyHandshake(handshake, address);

    if (!peer.ok) {
      return peer;
    }

    setState(peer.data, PeerState.VERIFIED);

    /* trust evaluation stage (NOT implicit connect) */
    const trustResult = trust.evaluatePeer(peer.data);

    if (trustResult.ok && trustResult.trusted) {
      setState(peer.data, PeerState.TRUSTED);
    }

    return peer;
  }

  /* ── HTTP ROUTER (TRANSPARENT TRANSLATION ONLY) ─────────────── */

  function route(method, parts, body, req, res) {

    const json = (code, data) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };

    /* handshake */
    if (method === 'POST' && parts[1] === 'handshake') {
      const result = handleHandshake({
        handshake: body?.handshake,
        address: req.socket?.remoteAddress
      });

      return json(result.ok ? 200 : 403, result);
    }

    /* peers */
    if (method === 'GET' && parts[1] === 'peers') {
      return json(200, {
        ok: true,
        peers: peers.list().map(p => ({
          uuid: p.uuid,
          state: p.state,
          lastSeen: p.lastSeen
        }))
      });
    }

    /* trust signals */
    if (method === 'POST' && parts[1] === 'trust-signal') {
      return json(200, trust.receiveSignal(body || {}));
    }

    /* disputes */
    if (method === 'GET' && parts[1] === 'disputes') {
      return json(200, trust.listDisputes());
    }

    /* ports */
    if (method === 'GET' && parts[1] === 'ports') {
      return json(200, ports.list());
    }

    return json(404, { ok: false, error: 'UNKNOWN_ROUTE' });
  }

  /* ── PUBLIC API ─────────────────────────────────────────────── */

  return {
    peers,
    ports,
    trust,

    openChannel,
    closeChannel,
    route,

    encrypt,
    decrypt
  };
}

module.exports = {
  createMeshNode
};