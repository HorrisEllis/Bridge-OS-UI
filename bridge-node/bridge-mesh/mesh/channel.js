// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
'use strict';
/**
 * bridge-mesh/mesh/channel.js
 * Secure channel between two verified nodes.
 *
 * Key exchange: ECDH P-256 per session → forward secrecy
 * Encryption:   AES-256-GCM (payload E2E)
 *
 * A channel is established AFTER both nodes have passed handshake + sngate.
 * The session key is derived fresh per connection — compromise of one
 * session key does not expose past or future sessions.
 */

const crypto = require('crypto');

// ── ECDH session key derivation ───────────────────────────────────────────────
function deriveSessionKey(myPrivateKey, theirPublicKey) {
  // myPrivateKey: ECDH object returned by generateSessionKeypair()
  // theirPublicKey: Buffer or base64 string of their public key
  let theirRaw;
  if (Buffer.isBuffer(theirPublicKey)) {
    theirRaw = theirPublicKey;
  } else if (typeof theirPublicKey === 'string') {
    theirRaw = Buffer.from(theirPublicKey, 'base64');
  } else {
    throw new Error('[bridge-mesh] theirPublicKey must be Buffer or base64 string');
  }

  // myPrivateKey is the ECDH instance — call computeSecret directly on it
  const shared = myPrivateKey.computeSecret(theirRaw);
  // HKDF expand to 32 bytes for AES-256
  return crypto.createHash('sha256').update(shared).digest();
}

// ── Generate ECDH keypair for session ────────────────────────────────────────
function generateSessionKeypair() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    privateKey:      ecdh,
    publicKeyBuffer: ecdh.getPublicKey(),
    publicKeyB64:    ecdh.getPublicKey('base64'),
  };
}

// ── AES-256-GCM encrypt ───────────────────────────────────────────────────────
function encrypt(sessionKey, plaintext) {
  const iv     = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', sessionKey, iv);
  const enc    = Buffer.concat([cipher.update(
    Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(JSON.stringify(plaintext))
  ), cipher.final()]);
  const tag    = cipher.getAuthTag();
  return {
    iv:  iv.toString('base64'),
    enc: enc.toString('base64'),
    tag: tag.toString('base64'),
  };
}

// ── AES-256-GCM decrypt ───────────────────────────────────────────────────────
function decrypt(sessionKey, { iv, enc, tag }) {
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    sessionKey,
    Buffer.from(iv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  try {
    const plain = Buffer.concat([
      decipher.update(Buffer.from(enc, 'base64')),
      decipher.final(),
    ]);
    return JSON.parse(plain.toString());
  } catch {
    throw new Error('[bridge-mesh] Decryption failed — tampered or wrong key');
  }
}

// ── Secure channel state ──────────────────────────────────────────────────────
function createSecureChannel({ peerUuid, sessionKey }) {
  let _messageCount = 0;
  let _established  = Date.now();

  function send(payload) {
    _messageCount++;
    return encrypt(sessionKey, { seq: _messageCount, ts: Date.now(), payload });
  }

  function receive(ciphertext) {
    const msg = decrypt(sessionKey, ciphertext);
    return msg.payload;
  }

  return {
    peerUuid,
    send,
    receive,
    get messageCount() { return _messageCount; },
    get establishedAt() { return _established; },
  };
}

module.exports = { generateSessionKeypair, deriveSessionKey, encrypt, decrypt, createSecureChannel };
