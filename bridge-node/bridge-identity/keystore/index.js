// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
'use strict';
/**
 * bridge-identity/keystore/index.js
 * KeyStore abstraction: selects best available backend.
 *
 * TPM → DPAPI → File (AES-256-GCM)
 * The application never specifies which backend is used.
 * Same interface regardless of backend.
 */

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');

// ── Backend: File (AES-256-GCM, machine-fingerprint derived key) ───────────────
class FileKeyStore {
  constructor(storePath) {
    this._path = storePath || path.join(process.cwd(), 'data', 'identity.key');
    this._dir  = path.dirname(this._path);
  }

  _machineKey() {
    // Derive a deterministic machine key from stable identifiers
    // This is the weakest backend — dev/fallback only
    const parts = [
      os.hostname(),
      os.platform(),
      os.arch(),
      process.env.USERNAME || process.env.USER || 'unknown',
    ];
    return crypto.createHash('sha256').update(parts.join('|')).digest();
  }

  save(uuid, privateKeyPem) {
    if (!fs.existsSync(this._dir)) fs.mkdirSync(this._dir, { recursive: true });

    const key   = this._machineKey();
    const iv    = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc   = Buffer.concat([cipher.update(privateKeyPem), cipher.final()]);
    const tag   = cipher.getAuthTag();

    const record = JSON.stringify({
      uuid,
      backend: 'file',
      iv:  iv.toString('hex'),
      tag: tag.toString('hex'),
      enc: enc.toString('base64'),
    });

    fs.writeFileSync(this._path, record, { mode: 0o600 });
    return true;
  }

  load(uuid) {
    if (!fs.existsSync(this._path)) throw new Error(`[FileKeyStore] Key file not found: ${this._path}`);

    const record = JSON.parse(fs.readFileSync(this._path, 'utf8'));
    if (record.uuid !== uuid) throw new Error(`[FileKeyStore] UUID mismatch: expected ${uuid}, found ${record.uuid}`);

    const key    = this._machineKey();
    const iv     = Buffer.from(record.iv,  'hex');
    const tag    = Buffer.from(record.tag, 'hex');
    const enc    = Buffer.from(record.enc, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);

    try {
      return Buffer.concat([decipher.update(enc), decipher.final()]).toString();
    } catch {
      throw new Error('[FileKeyStore] Decryption failed — machine changed or file corrupted');
    }
  }

  exists() { return fs.existsSync(this._path); }
  type()   { return 'file'; }
}

// ── Backend: DPAPI (Windows machine-bound) ─────────────────────────────────────
class DPAPIKeyStore {
  constructor(storePath) {
    this._path = storePath || path.join(process.cwd(), 'data', 'identity.dpapi');
  }

  save(uuid, privateKeyPem) {
    // dpapi is optional dep — only loaded if available
    const dpapi = this._loadDPAPI();
    if (!dpapi) throw new Error('[DPAPIKeyStore] DPAPI not available');

    const encrypted = dpapi.protectData(Buffer.from(privateKeyPem), null, 'LocalMachine');
    const record = JSON.stringify({ uuid, backend: 'dpapi', enc: encrypted.toString('base64') });
    fs.writeFileSync(this._path, record, { mode: 0o600 });
    return true;
  }

  load(uuid) {
    const dpapi = this._loadDPAPI();
    if (!dpapi) throw new Error('[DPAPIKeyStore] DPAPI not available');

    const record = JSON.parse(fs.readFileSync(this._path, 'utf8'));
    if (record.uuid !== uuid) throw new Error(`[DPAPIKeyStore] UUID mismatch`);

    const enc = Buffer.from(record.enc, 'base64');
    return dpapi.unprotectData(enc, null, 'LocalMachine').toString();
  }

  _loadDPAPI() {
    try { return require('node-dpapi'); } catch { return null; }
  }

  exists() { return fs.existsSync(this._path) && !!this._loadDPAPI(); }
  type()   { return 'dpapi'; }
}

// ── Backend: TPM stub (requires tpm2-tools or node-tpm) ───────────────────────
class TPMKeyStore {
  // TPM backend — hardware-signed, key never leaves chip
  // v1: stubbed — wire when node-tpm available
  save()   { throw new Error('[TPMKeyStore] Not yet implemented — use DPAPI or File'); }
  load()   { throw new Error('[TPMKeyStore] Not yet implemented — use DPAPI or File'); }
  exists() { return false; }
  type()   { return 'tpm'; }
}

// ── Selector: picks best available backend ─────────────────────────────────────
function selectKeyStore(storePath) {
  // 1. TPM (not yet available in v1)
  // 2. DPAPI (Windows only)
  if (process.platform === 'win32') {
    const dpapi = new DPAPIKeyStore(storePath);
    try {
      require('node-dpapi');
      return dpapi;
    } catch { /* fall through */ }
  }
  // 3. File (dev/fallback)
  return new FileKeyStore(storePath);
}

module.exports = { FileKeyStore, DPAPIKeyStore, TPMKeyStore, selectKeyStore };
