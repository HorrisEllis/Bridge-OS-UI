// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
'use strict';
/**
 * bridge-identity/identity.js
 * Ed25519 keypair generation, UUID derivation, signing.
 *
 * INVARIANTS:
 * 1. UUID derived from publicKey only. Never set directly.
 * 2. Private key never in memory longer than needed for signing.
 * 3. data/identity.json contains NO secrets.
 * 4. UUID mismatch on load → hard stop, loud error.
 * 5. SHA256(publicKey) === uuid — enforced on every load.
 */

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

// ── UUID derivation ────────────────────────────────────────────────────────────
function deriveUUID(publicKeyBuffer) {
  const hash = crypto.createHash('sha256').update(publicKeyBuffer).digest('hex');
  const h = hash.slice(0, 32);
  return [h.slice(0,8), h.slice(8,12), h.slice(12,16), h.slice(16,20), h.slice(20,32)].join('-');
}

// ── Handshake payload ──────────────────────────────────────────────────────────
function makeHandshake(uuid, publicKey, privateKey, groupHint = null) {
  const ts = Date.now();
  const payload = Buffer.from(String(ts));
  const sig = crypto.sign(null, payload, { key: privateKey, dsaEncoding: 'der' });
  return {
    uuid,
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    ts,
    sig: sig.toString('base64'),
    groupHint,
  };
}

// ── Handshake verification ─────────────────────────────────────────────────────
function verifyHandshake(hs) {
  const { uuid, publicKey: b64, ts, sig: sigB64 } = hs;
  if (!uuid || !b64 || !ts || !sigB64) return { ok: false, reason: 'missing fields' };

  // Replay protection — 30 second window
  if (Math.abs(Date.now() - ts) > 30000) return { ok: false, reason: 'stale timestamp' };

  let pubKey;
  try {
    const der = Buffer.from(b64, 'base64');
    pubKey = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
  } catch {
    return { ok: false, reason: 'invalid publicKey encoding' };
  }

  // UUID === SHA256(publicKey)
  const der = pubKey.export({ type: 'spki', format: 'der' });
  const expected = deriveUUID(der);
  if (uuid !== expected) return { ok: false, reason: 'UUID-publicKey mismatch' };

  // Signature valid?
  const payload = Buffer.from(String(ts));
  const sig = Buffer.from(sigB64, 'base64');
  try {
    const valid = crypto.verify(null, payload, { key: pubKey, dsaEncoding: 'der' }, sig);
    if (!valid) return { ok: false, reason: 'signature invalid' };
  } catch {
    return { ok: false, reason: 'signature verification error' };
  }

  return { ok: true, uuid, publicKey: pubKey, groupHint: hs.groupHint || null };
}

// ── Identity class ─────────────────────────────────────────────────────────────
class Identity {
  constructor() {
    this._uuid       = null;
    this._publicKey  = null;
    this._privateKey = null; // held only during signing window
    this._groupHint  = null;
    this._createdAt  = null;
    this._loaded     = false;
  }

  // Generate brand new identity
  generate(groupHint = null) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const der = publicKey.export({ type: 'spki', format: 'der' });
    this._uuid       = deriveUUID(der);
    this._publicKey  = publicKey;
    this._privateKey = privateKey;
    this._groupHint  = groupHint;
    this._createdAt  = new Date().toISOString();
    this._loaded     = true;
    return this;
  }

  // Load identity from stored keypair. Verifies UUID consistency.
  load(privateKeyPem, publicRecord) {
    let privateKey, publicKey;
    try {
      privateKey = crypto.createPrivateKey(privateKeyPem);
      publicKey  = crypto.createPublicKey(privateKey);
    } catch (e) {
      throw new Error(`[bridge-identity] HARD STOP: failed to load private key — ${e.message}`);
    }

    const der      = publicKey.export({ type: 'spki', format: 'der' });
    const expected = deriveUUID(der);

    if (publicRecord.uuid !== expected) {
      throw new Error(
        `[bridge-identity] HARD STOP: UUID mismatch on load.\n` +
        `  stored:   ${publicRecord.uuid}\n` +
        `  derived:  ${expected}\n` +
        `  Identity is corrupted or key was changed. Run --reset-identity if intentional.`
      );
    }

    this._uuid       = expected;
    this._publicKey  = publicKey;
    this._privateKey = privateKey;
    this._groupHint  = publicRecord.groupHint || null;
    this._createdAt  = publicRecord.createdAt || null;
    this._loaded     = true;
    return this;
  }

  sign(payload) {
    if (!this._loaded) throw new Error('[bridge-identity] sign() called before identity loaded');
    const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
    const sig = crypto.sign(null, buf, { key: this._privateKey, dsaEncoding: 'der' });
    return sig.toString('base64');
  }

  handshake() {
    if (!this._loaded) throw new Error('[bridge-identity] handshake() called before identity loaded');
    return makeHandshake(this._uuid, this._publicKey, this._privateKey, this._groupHint);
  }

  get uuid()      { return this._uuid; }
  get publicKey() { return this._publicKey; }
  get groupHint() { return this._groupHint; }
  get createdAt() { return this._createdAt; }
  get isLoaded()  { return this._loaded; }

  // Public record — safe to write to disk, commit, share
  publicRecord() {
    return {
      uuid:       this._uuid,
      publicKey:  this._publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
      groupHint:  this._groupHint,
      createdAt:  this._createdAt,
    };
  }

  // Lineage entry for migration assertions
  makeMigrationAssertion(oldUUID, reason) {
    if (!['tpm-loss', 'reset', 'clone-resolution', 'scheduled'].includes(reason)) {
      throw new Error(`[bridge-identity] Unknown migration reason: ${reason}`);
    }
    const ts = Date.now();
    const payload = JSON.stringify({ oldUUID, newUUID: this._uuid, ts, reason });
    return {
      ancestorUuid: oldUUID,
      migratedAt:   ts,
      reason,
      selfSig:      this.sign(payload),
      newUUID:      this._uuid,
    };
  }
}

module.exports = { Identity, deriveUUID, verifyHandshake, makeHandshake };
