// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
'use strict';
/**
 * bridge-identity/tests/test-identity.js
 * Tests: UUID derivation, sig verify, storage round-trip, mismatch detection,
 *        handshake verify, replay protection, migration assertions.
 */

const assert = require('assert');
const crypto = require('crypto');
const os     = require('os');
const path   = require('path');
const fs     = require('fs');
const { Identity, deriveUUID, verifyHandshake } = require('../identity');
const { FileKeyStore }                          = require('../keystore/index');
const { loadOrInit, resetIdentity }             = require('../index');

let passed = 0;
let failed = 0;
const tests = [];

function test(name, fn) { tests.push({ name, fn }); }

async function run() {
  console.log('\n[bridge-identity] Test Suite\n');
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  ✓ ${t.name}`);
      passed++;
    } catch (e) {
      console.log(`  ✗ ${t.name}\n    ${e.message}`);
      failed++;
    }
  }
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

// ── Suite 1: UUID Derivation ───────────────────────────────────────────────────

test('UUID derived from publicKey is deterministic', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const uuid1 = deriveUUID(der);
  const uuid2 = deriveUUID(der);
  assert.strictEqual(uuid1, uuid2);
});

test('UUID format is 8-4-4-4-12 hex', () => {
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  const der  = publicKey.export({ type: 'spki', format: 'der' });
  const uuid = deriveUUID(der);
  assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test('Different keypairs produce different UUIDs', () => {
  const k1 = crypto.generateKeyPairSync('ed25519').publicKey.export({ type:'spki', format:'der' });
  const k2 = crypto.generateKeyPairSync('ed25519').publicKey.export({ type:'spki', format:'der' });
  assert.notStrictEqual(deriveUUID(k1), deriveUUID(k2));
});

// ── Suite 2: Identity Generation ───────────────────────────────────────────────

test('generate() produces valid uuid', () => {
  const id = new Identity().generate();
  assert.ok(id.uuid);
  assert.match(id.uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test('generate() uuid matches SHA256(publicKey)', () => {
  const id  = new Identity().generate();
  const der = id.publicKey.export({ type: 'spki', format: 'der' });
  assert.strictEqual(id.uuid, deriveUUID(der));
});

test('generate() sets groupHint when provided', () => {
  const id = new Identity().generate('home-lab');
  assert.strictEqual(id.groupHint, 'home-lab');
});

test('publicRecord() contains no private key material', () => {
  const id     = new Identity().generate();
  const record = id.publicRecord();
  assert.ok(record.uuid);
  assert.ok(record.publicKey);
  assert.ok(!record.privateKey);
  assert.ok(!record._privateKey);
});

// ── Suite 3: Signing ──────────────────────────────────────────────────────────

test('sign() produces verifiable signature', () => {
  const id      = new Identity().generate();
  const payload = Buffer.from('test-payload');
  const sigB64  = id.sign(payload);
  const sig     = Buffer.from(sigB64, 'base64');
  const valid   = crypto.verify(null, payload, { key: id.publicKey, dsaEncoding: 'der' }, sig);
  assert.ok(valid);
});

test('sign() before generate() throws', () => {
  assert.throws(() => new Identity().sign('x'), /called before identity loaded/);
});

// ── Suite 4: Handshake ────────────────────────────────────────────────────────

test('handshake() produces valid payload', () => {
  const id = new Identity().generate();
  const hs = id.handshake();
  assert.ok(hs.uuid);
  assert.ok(hs.publicKey);
  assert.ok(hs.ts);
  assert.ok(hs.sig);
});

test('verifyHandshake() accepts valid handshake', () => {
  const id     = new Identity().generate();
  const hs     = id.handshake();
  const result = verifyHandshake(hs);
  assert.ok(result.ok, result.reason);
  assert.strictEqual(result.uuid, id.uuid);
});

test('verifyHandshake() rejects tampered signature', () => {
  const id = new Identity().generate();
  const hs = id.handshake();
  hs.sig = Buffer.from('bad-sig').toString('base64');
  const result = verifyHandshake(hs);
  assert.ok(!result.ok);
});

test('verifyHandshake() rejects mismatched UUID', () => {
  const id = new Identity().generate();
  const hs = id.handshake();
  hs.uuid = 'aaaaaaaa-0000-0000-0000-000000000000';
  const result = verifyHandshake(hs);
  assert.ok(!result.ok);
  assert.match(result.reason, /mismatch/i);
});

test('verifyHandshake() rejects stale timestamp', () => {
  const id = new Identity().generate();
  const hs = id.handshake();
  hs.ts = Date.now() - 60000; // 60s ago
  const result = verifyHandshake(hs);
  assert.ok(!result.ok);
  assert.match(result.reason, /stale/i);
});

test('verifyHandshake() rejects missing fields', () => {
  const result = verifyHandshake({});
  assert.ok(!result.ok);
});

// ── Suite 5: Load + Mismatch detection ────────────────────────────────────────

test('load() accepts valid keypair + matching record', () => {
  const id1 = new Identity().generate();
  const pem  = id1._privateKey.export({ type: 'pkcs8', format: 'pem' });
  const rec  = id1.publicRecord();

  const id2 = new Identity();
  id2.load(pem, rec);
  assert.strictEqual(id1.uuid, id2.uuid);
});

test('load() throws hard on UUID mismatch', () => {
  const id1 = new Identity().generate();
  const pem  = id1._privateKey.export({ type: 'pkcs8', format: 'pem' });
  const rec  = { ...id1.publicRecord(), uuid: 'tampered-00000000-0000-0000' };

  assert.throws(() => new Identity().load(pem, rec), /HARD STOP/);
});

// ── Suite 6: FileKeyStore round-trip ──────────────────────────────────────────

test('FileKeyStore saves and loads private key', () => {
  const tmpPath = path.join(os.tmpdir(), `id-test-${Date.now()}.key`);
  const store   = new FileKeyStore(tmpPath);
  const id      = new Identity().generate();
  const pem     = id._privateKey.export({ type: 'pkcs8', format: 'pem' });

  store.save(id.uuid, pem);
  const loaded = store.load(id.uuid);
  assert.strictEqual(pem, loaded);
  fs.unlinkSync(tmpPath);
});

test('FileKeyStore throws on UUID mismatch', () => {
  const tmpPath = path.join(os.tmpdir(), `id-test-${Date.now()}.key`);
  const store   = new FileKeyStore(tmpPath);
  const id      = new Identity().generate();
  const pem     = id._privateKey.export({ type: 'pkcs8', format: 'pem' });

  store.save(id.uuid, pem);
  assert.throws(() => store.load('wrong-uuid'), /UUID mismatch/);
  fs.unlinkSync(tmpPath);
});

// ── Suite 7: loadOrInit integration ──────────────────────────────────────────

test('loadOrInit() generates identity on first run', async () => {
  const dir = path.join(os.tmpdir(), `identity-test-${Date.now()}`);
  const id  = await loadOrInit({ dataDir: dir });
  assert.ok(id.uuid);
  assert.ok(id.isLoaded);
  fs.rmSync(dir, { recursive: true });
});

test('loadOrInit() loads same identity on second run', async () => {
  const dir  = path.join(os.tmpdir(), `identity-test-${Date.now()}`);
  const id1  = await loadOrInit({ dataDir: dir });
  const id2  = await loadOrInit({ dataDir: dir });
  assert.strictEqual(id1.uuid, id2.uuid);
  fs.rmSync(dir, { recursive: true });
});

test('resetIdentity() generates new UUID', async () => {
  const dir  = path.join(os.tmpdir(), `identity-test-${Date.now()}`);
  const id1  = await loadOrInit({ dataDir: dir });
  const { identity: id2 } = await resetIdentity({ dataDir: dir, confirm: true });
  assert.notStrictEqual(id1.uuid, id2.uuid);
  fs.rmSync(dir, { recursive: true });
});

test('resetIdentity() without confirm throws', async () => {
  await assert.rejects(() => resetIdentity({ confirm: false }), /requires confirm/);
});

// ── Suite 8: Migration assertion ──────────────────────────────────────────────

test('makeMigrationAssertion() produces valid signed assertion', () => {
  const id        = new Identity().generate();
  const oldUUID   = 'aaaaaaaa-0000-0000-0000-000000000000';
  const assertion = id.makeMigrationAssertion(oldUUID, 'reset');
  assert.strictEqual(assertion.ancestorUuid, oldUUID);
  assert.strictEqual(assertion.newUUID, id.uuid);
  assert.ok(assertion.selfSig);
  assert.ok(assertion.migratedAt);
});

test('makeMigrationAssertion() rejects unknown reason', () => {
  const id = new Identity().generate();
  assert.throws(() => id.makeMigrationAssertion('old', 'hacking'), /Unknown migration reason/);
});

run();
