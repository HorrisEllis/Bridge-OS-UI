// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
'use strict';
/**
 * bridge-identity/index.js
 * Public API: { Identity, KeyStore, loadOrInit, verifyHandshake }
 *
 * Usage:
 *   const { loadOrInit } = require('./bridge-identity');
 *   const identity = await loadOrInit({ dataDir, groupHint });
 *   identity.uuid         // → "a7f3c2d1-..."
 *   identity.handshake()  // → { uuid, publicKey, ts, sig }
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { Identity, verifyHandshake, deriveUUID } = require('./identity');
const { selectKeyStore }                         = require('./keystore/index');

const DEFAULT_DATA_DIR = path.join(process.cwd(), 'data');

// ── Load existing identity or generate new one ────────────────────────────────
async function loadOrInit({ dataDir = DEFAULT_DATA_DIR, groupHint = null } = {}) {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  const publicFile  = path.join(dataDir, 'identity.json');
  const keyStore    = selectKeyStore(path.join(dataDir, 'identity.key'));

  const identity = new Identity();

  if (fs.existsSync(publicFile) && keyStore.exists()) {
    // Existing identity — load and verify
    const publicRecord = JSON.parse(fs.readFileSync(publicFile, 'utf8'));
    const privateKeyPem = keyStore.load(publicRecord.uuid);
    identity.load(privateKeyPem, publicRecord);
    _log(`Identity loaded: ${identity.uuid} (via ${keyStore.type()})`);
  } else {
    // First run — generate
    identity.generate(groupHint);
    const privateKeyPem = identity._privateKey.export({ type: 'pkcs8', format: 'pem' });
    keyStore.save(identity.uuid, privateKeyPem);
    fs.writeFileSync(publicFile, JSON.stringify(identity.publicRecord(), null, 2));
    _log(`Identity generated: ${identity.uuid} (via ${keyStore.type()})`);
  }

  return identity;
}

// ── Reset identity (explicit only — new UUID) ─────────────────────────────────
async function resetIdentity({ dataDir = DEFAULT_DATA_DIR, groupHint = null, confirm = false } = {}) {
  if (!confirm) throw new Error('[bridge-identity] --reset-identity requires confirm:true');

  const publicFile = path.join(dataDir, 'identity.json');
  let oldUUID = null;

  if (fs.existsSync(publicFile)) {
    try { oldUUID = JSON.parse(fs.readFileSync(publicFile, 'utf8')).uuid; } catch {}
    fs.renameSync(publicFile, publicFile + '.old.' + Date.now());
  }

  const keyStorePath = path.join(dataDir, 'identity.key');
  if (fs.existsSync(keyStorePath)) fs.renameSync(keyStorePath, keyStorePath + '.old.' + Date.now());

  const identity = await loadOrInit({ dataDir, groupHint });
  _log(`Identity reset. Old UUID: ${oldUUID || 'none'}. New UUID: ${identity.uuid}`);
  return { identity, oldUUID };
}

// ── Migration assertion (same human, new key) ─────────────────────────────────
async function migrateIdentity({ dataDir, oldUUID, reason = 'reset', groupHint = null }) {
  const identity = await loadOrInit({ dataDir, groupHint });
  const assertion = identity.makeMigrationAssertion(oldUUID, reason);

  const lineageFile = path.join(dataDir, 'identity-lineage.json');
  let lineage = [];
  if (fs.existsSync(lineageFile)) {
    try { lineage = JSON.parse(fs.readFileSync(lineageFile, 'utf8')); } catch {}
  }
  lineage.push(assertion);
  fs.writeFileSync(lineageFile, JSON.stringify(lineage, null, 2));
  _log(`Migration recorded: ${oldUUID} → ${identity.uuid} (${reason})`);
  return { identity, assertion };
}

function _log(msg) {
  console.log(`[bridge-identity] ${msg}`);
}

module.exports = {
  loadOrInit,
  resetIdentity,
  migrateIdentity,
  verifyHandshake,
  deriveUUID,
  Identity,
};
