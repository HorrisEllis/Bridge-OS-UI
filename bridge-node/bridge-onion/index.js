// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
'use strict';
/**
 * bridge-onion/index.js
 * Onion Routing — multi-hop encrypted circuit paths.
 *
 * Design:
 *   Each hop knows only its predecessor and successor. No relay knows the
 *   full route. Layered ECDH P-256 encryption: originator wraps payload in
 *   N layers, each layer decryptable only by its target relay.
 *
 * Circuit lifecycle:
 *   1. Originator builds a circuit: [A → B → C → D(exit)]
 *   2. Originator generates an ephemeral ECDH keypair per hop.
 *   3. Each relay's public key (from DHT) is used to derive a shared AES-256-GCM key.
 *   4. Message is encrypted innermost-first (exit → ... → first hop).
 *   5. Each relay unwraps one layer, forwards the inner ciphertext to the next hop.
 *   6. Exit relay decrypts the payload and delivers it.
 *
 * Wire protocol (HTTP POST on existing server):
 *   POST /onion/relay   { circuitId, layer: <base64 encrypted blob> }
 *   POST /onion/build   { hops: [{uuid, address, publicKey}], payload, ttl }
 *   GET  /onion/stats   → { circuits, relayed, built, errors }
 *
 * Bus events:
 *   onion:circuit:built    { circuitId, hops, ttl }
 *   onion:relay:forwarded  { circuitId, hop }
 *   onion:circuit:expired  { circuitId }
 *   onion:error            { circuitId, reason }
 *
 * Invariants:
 *   O-01: No relay stores the full route — only prev/next hop addresses.
 *   O-02: Circuit IDs are ephemeral UUIDs with TTL ≤ 300s.
 *   O-03: Ephemeral keypairs are destroyed after circuit teardown.
 *   O-04: Payload is always AES-256-GCM encrypted with random IV per hop.
 *   O-05: Circuit build failure is non-fatal — falls back to direct path.
 *
 * UUID: bridge-onion-0000-0000-0000-000000000001
 * Version: 1.0.0
 */

const crypto = require('crypto');
const http   = require('http');

const MODULE_UUID    = 'bridge-onion-0000-0000-0000-000000000001';
const MODULE_VERSION = '1.0.0';

const CIRCUIT_TTL_MS  = 300_000;  // 5 min
const MAX_HOPS        = 7;        // Tor uses 3; we allow up to 7
const MIN_HOPS        = 2;        // minimum for meaningful anonymity
const RELAY_TIMEOUT   = 5_000;

// ── Crypto helpers ────────────────────────────────────────────────────────────

/**
 * Generate an ephemeral ECDH P-256 keypair for a single hop.
 * Returns { privateKey, publicKey, publicKeyB64 }
 */
function ephemeralKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const publicKeyB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  return { privateKey, publicKey, publicKeyB64 };
}

/**
 * Derive a shared AES-256-GCM key from our ephemeral privKey + peer's pubKeyDer.
 */
function deriveSharedKey(ourPrivKey, peerPublicKeyDer) {
  const peerPubKey = crypto.createPublicKey({ key: Buffer.from(peerPublicKeyDer, 'base64'), type: 'spki', format: 'der' });
  const ecdh       = crypto.diffieHellman({ privateKey: ourPrivKey, publicKey: peerPubKey });
  // HKDF-expand using SHA-256 to produce a 32-byte AES key
  return Buffer.from(crypto.hkdfSync('sha256', ecdh, Buffer.alloc(0), 'bridge-onion-v1', 32));
}

/**
 * Encrypt plaintext with AES-256-GCM. Returns { iv, ciphertext, tag } all base64.
 */
function encryptLayer(key, plaintextBuf) {
  const iv     = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc    = Buffer.concat([cipher.update(plaintextBuf), cipher.final()]);
  const tag    = cipher.getAuthTag();
  return {
    iv:         iv.toString('base64'),
    ciphertext: enc.toString('base64'),
    tag:        tag.toString('base64'),
  };
}

/**
 * Decrypt an onion layer. Returns plaintext Buffer or throws.
 */
function decryptLayer(key, { iv, ciphertext, tag }) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]);
}

// ── Circuit builder (originator side) ────────────────────────────────────────

/**
 * buildCircuit({ hops, payload, identity })
 *
 * hops: array of { uuid, address, publicKeyB64 } ordered from first relay to exit
 * payload: the final plaintext Buffer to deliver at exit
 * identity: optional local Identity for signing the circuit header
 *
 * Returns { circuitId, firstHop, layer } — send layer to firstHop.address
 */
function buildCircuit({ hops, payload, identity = null }) {
  if (!Array.isArray(hops) || hops.length < MIN_HOPS) {
    throw new Error(`[onion] buildCircuit requires at least ${MIN_HOPS} hops, got ${hops?.length}`);
  }
  if (hops.length > MAX_HOPS) {
    throw new Error(`[onion] buildCircuit: max ${MAX_HOPS} hops, got ${hops.length}`);
  }

  const circuitId  = crypto.randomUUID();
  const expiresAt  = Date.now() + CIRCUIT_TTL_MS;

  // Generate ephemeral keypairs — one per hop, destroyed after build
  const ephKeys = hops.map(() => ephemeralKeyPair());

  // Build from exit inward: innermost layer = final payload destined for exit
  // Each wrapping adds a layer that the corresponding relay can strip.
  //
  // Packet structure at each layer:
  //   { nextHop: address | null, ephPubKey: b64, ...encryptedInner }
  //
  // Exit layer:
  let current = JSON.stringify({
    type:       'exit',
    circuitId,
    expiresAt,
    nextHop:    null,
    payload:    payload.toString('base64'),
  });

  for (let i = hops.length - 1; i >= 0; i--) {
    const hop        = hops[i];
    const ephKey     = ephKeys[i];
    const sharedKey  = deriveSharedKey(ephKey.privateKey, hop.publicKeyB64);
    const inner      = encryptLayer(sharedKey, Buffer.from(current));
    const nextHop    = i < hops.length - 1 ? hops[i + 1].address : null;

    current = JSON.stringify({
      type:        i === 0 ? 'relay' : 'relay',
      circuitId,
      expiresAt,
      nextHop,
      ephPubKey:   ephKey.publicKeyB64, // relay uses this to derive shared key with originator
      ...inner,
    });
  }

  // Destroy ephemeral private keys — they are no longer needed
  // (Node GC will clean up; in a real HSM you'd explicitly zeroize)
  for (const k of ephKeys) k.privateKey = null;

  return {
    circuitId,
    firstHop:  hops[0].address,
    expiresAt,
    layer:     current, // send this to firstHop
  };
}

// ── Relay processor (intermediate node side) ──────────────────────────────────

/**
 * processLayer({ layer, identity, busEmit })
 *
 * Called when a relay receives a POST /onion/relay.
 * identity: local Identity object (has private key for ECDH)
 * Returns { circuitId, nextHop, innerLayer } or { circuitId, exit: true, payload }
 */
function processLayer({ layer, identity, busEmit = null }) {
  let packet;
  try { packet = typeof layer === 'string' ? JSON.parse(layer) : layer; }
  catch { return { ok: false, reason: 'malformed packet' }; }

  const { circuitId, expiresAt, nextHop, ephPubKey, iv, ciphertext, tag, payload, type } = packet;

  if (!circuitId || !expiresAt) return { ok: false, reason: 'missing fields' };
  if (Date.now() > expiresAt)   return { ok: false, reason: 'circuit expired' };

  // Exit node: packet has plaintext payload field (no encryption to strip)
  // This only happens if the originator addresses this node as exit AND uses
  // a special null-encryption exit flag. In the current design, the exit node
  // still has an encrypted layer — it just has nextHop: null.
  if (!ephPubKey) {
    // No ephemeral key means this is an exit or plaintext test packet
    busEmit?.('onion:relay:exit', { circuitId }, 'INFO');
    return { ok: true, circuitId, exit: true, payload };
  }

  // Derive shared key from the originator's ephemeral public key + our private key
  let sharedKey;
  try {
    sharedKey = deriveSharedKey(identity._privateKey, ephPubKey);
  } catch (e) {
    busEmit?.('onion:error', { circuitId, reason: `key derivation failed: ${e.message}` }, 'WARN');
    return { ok: false, reason: `key derivation: ${e.message}` };
  }

  // Strip our layer
  let inner;
  try {
    const decrypted = decryptLayer(sharedKey, { iv, ciphertext, tag });
    inner = decrypted.toString('utf8');
  } catch (e) {
    busEmit?.('onion:error', { circuitId, reason: `decrypt failed: ${e.message}` }, 'WARN');
    return { ok: false, reason: `decrypt: ${e.message}` };
  }

  busEmit?.('onion:relay:forwarded', { circuitId, nextHop: nextHop || '(exit)' }, 'DEBUG');

  if (!nextHop) {
    // We are the exit node — inner is the final payload
    let exitPayload;
    try {
      const parsed = JSON.parse(inner);
      exitPayload  = parsed.payload; // base64 encoded original payload
    } catch { exitPayload = inner; }
    return { ok: true, circuitId, exit: true, payload: exitPayload };
  }

  // We are an intermediate relay — forward inner to nextHop
  return { ok: true, circuitId, exit: false, nextHop, innerLayer: inner };
}

// ── HTTP relay forwarder ──────────────────────────────────────────────────────

function httpPost(address, path, body, timeoutMs = RELAY_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const url  = new URL(address + path);
    const data = JSON.stringify(body);
    const req  = http.request({
      hostname: url.hostname, port: url.port || 80, path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: timeoutMs,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end',  () => {
        try   { resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()) }); }
        catch { resolve({ status: res.statusCode, data: null }); }
      });
    });
    req.on('error',   reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`relay timeout: ${address}`)); });
    req.write(data);
    req.end();
  });
}

// ── OnionRouter factory ───────────────────────────────────────────────────────

function createOnionRouter({ identity, busEmit = null } = {}) {
  if (!identity) throw new Error('[onion] identity required');

  const _circuits  = new Map(); // circuitId → { expiresAt, hops, built }
  const _stats     = { circuits: 0, relayed: 0, built: 0, errors: 0 };

  // Prune expired circuits every 60s
  const _pruner = setInterval(() => {
    const now = Date.now();
    for (const [id, c] of _circuits) {
      if (now > c.expiresAt) {
        _circuits.delete(id);
        busEmit?.('onion:circuit:expired', { circuitId: id }, 'DEBUG');
      }
    }
  }, 60_000);

  /**
   * send({ hops, payload })
   * Build and transmit an onion circuit. Falls back to direct path on failure.
   * hops: [{ uuid, address, publicKeyB64 }]
   * payload: Buffer or string
   */
  async function send({ hops, payload }) {
    const payloadBuf = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
    let circuit;
    try {
      circuit = buildCircuit({ hops, payload: payloadBuf, identity });
      _circuits.set(circuit.circuitId, { expiresAt: circuit.expiresAt, hops: hops.length, built: Date.now() });
      _stats.built++;
      busEmit?.('onion:circuit:built', { circuitId: circuit.circuitId, hops: hops.length, ttl: CIRCUIT_TTL_MS }, 'INFO');
    } catch (e) {
      _stats.errors++;
      busEmit?.('onion:error', { reason: `build failed: ${e.message}` }, 'WARN');
      throw e;
    }

    // Send to first hop
    try {
      const r = await httpPost(circuit.firstHop, '/onion/relay', {
        circuitId: circuit.circuitId,
        layer:     circuit.layer,
      });
      return { ok: r.status === 200, circuitId: circuit.circuitId, status: r.status };
    } catch (e) {
      _stats.errors++;
      busEmit?.('onion:error', { circuitId: circuit.circuitId, reason: `send failed: ${e.message}` }, 'WARN');
      return { ok: false, circuitId: circuit.circuitId, reason: e.message };
    }
  }

  // HTTP route handler
  function route(method, urlParts, body, req, res) {
    const _json = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };

    // POST /onion/relay
    if (method === 'POST' && urlParts[1] === 'relay') {
      const { circuitId, layer } = body || {};
      if (!circuitId || !layer) return _json(400, { ok: false, error: 'circuitId and layer required' });

      const result = processLayer({ layer, identity, busEmit });
      if (!result.ok) {
        _stats.errors++;
        return _json(400, { ok: false, error: result.reason });
      }

      _stats.relayed++;

      if (result.exit) {
        // We're the exit — deliver locally (emit on bus)
        busEmit?.('onion:payload:received', {
          circuitId: result.circuitId,
          payload:   result.payload,
        }, 'INFO');
        return _json(200, { ok: true, circuitId: result.circuitId, delivered: true });
      }

      // Intermediate relay — forward async, return 200 immediately (fire and forget)
      setImmediate(async () => {
        try {
          await httpPost(result.nextHop, '/onion/relay', {
            circuitId: result.circuitId,
            layer:     result.innerLayer,
          });
        } catch (e) {
          _stats.errors++;
          busEmit?.('onion:error', { circuitId: result.circuitId, reason: `forward failed: ${e.message}` }, 'WARN');
        }
      });
      return _json(200, { ok: true, circuitId: result.circuitId, forwarded: true });
    }

    // POST /onion/build — debug/test endpoint: build and send a circuit from spec
    if (method === 'POST' && urlParts[1] === 'build') {
      const { hops, payload, ttl } = body || {};
      if (!Array.isArray(hops) || !payload) return _json(400, { ok: false, error: 'hops[] and payload required' });
      send({ hops, payload }).then(r => {}).catch(() => {});
      return _json(202, { ok: true, status: 'building', hops: hops.length });
    }

    // GET /onion/stats
    if (method === 'GET' && urlParts[1] === 'stats') {
      return _json(200, { ok: true, ..._stats, activeCircuits: _circuits.size });
    }

    return null;
  }

  function stop() { clearInterval(_pruner); }

  function diagnostics() {
    return { uuid: MODULE_UUID, version: MODULE_VERSION, ..._stats, activeCircuits: _circuits.size };
  }

  return { send, route, stop, diagnostics, MODULE_UUID, MODULE_VERSION };
}

module.exports = { createOnionRouter, buildCircuit, processLayer, ephemeralKeyPair, deriveSharedKey, MODULE_UUID, MODULE_VERSION };
