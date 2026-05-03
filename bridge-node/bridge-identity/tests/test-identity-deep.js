// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
'use strict';
/**
 * bridge-identity/tests/test-identity-deep.js
 * §4.1 §1.1 §1.2 §4.3
 * Covers: Identity class, deriveUUID, handshake, verifyHandshake,
 * sign, load, migration assertions, loadOrInit
 */
const assert = require('assert');
const crypto = require('crypto');
const os     = require('os');
const path   = require('path');
const fs     = require('fs');

const { Identity, deriveUUID, verifyHandshake, makeHandshake } = require('../identity');
const { loadOrInit, resetIdentity } = require('../index');

let passed = 0, failed = 0;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
async function run() {
  console.log('\n[bridge-identity] Deep Test Suite\n');
  for (const t of tests) {
    try { await t.fn(); console.log(`  ✓ ${t.name}`); passed++; }
    catch (e) { console.error(`  ✗ ${t.name}\n    ${e.message}`); failed++; }
  }
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

// ── deriveUUID() ──────────────────────────────────────────────────────────────
test('deriveUUID(): returns UUID-shaped string', () => {
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const uuid = deriveUUID(der);
  assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});
test('deriveUUID(): same key always gives same UUID', () => {
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  assert.strictEqual(deriveUUID(der), deriveUUID(der));
});
test('deriveUUID(): different keys give different UUIDs', () => {
  const k1 = crypto.generateKeyPairSync('ed25519').publicKey.export({ type:'spki', format:'der' });
  const k2 = crypto.generateKeyPairSync('ed25519').publicKey.export({ type:'spki', format:'der' });
  assert.notStrictEqual(deriveUUID(k1), deriveUUID(k2));
});
test('deriveUUID(): UUID is deterministic (SHA256 of DER)', () => {
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const hash = crypto.createHash('sha256').update(der).digest('hex');
  const h = hash.slice(0, 32);
  const expected = [h.slice(0,8), h.slice(8,12), h.slice(12,16), h.slice(16,20), h.slice(20,32)].join('-');
  assert.strictEqual(deriveUUID(der), expected);
});

// ── Identity.generate() ───────────────────────────────────────────────────────
test('generate(): sets uuid, publicKey, isLoaded', () => {
  const id = new Identity();
  id.generate();
  assert.ok(id.uuid);
  assert.ok(id.publicKey);
  assert.ok(id.isLoaded);
});
test('generate(): uuid matches deriveUUID(publicKey)', () => {
  const id = new Identity();
  id.generate();
  const der = id.publicKey.export({ type: 'spki', format: 'der' });
  assert.strictEqual(id.uuid, deriveUUID(der));
});
test('generate(): each call produces unique uuid', () => {
  const uuids = new Set();
  for (let i = 0; i < 10; i++) {
    const id = new Identity();
    id.generate();
    uuids.add(id.uuid);
  }
  assert.strictEqual(uuids.size, 10);
});
test('generate(): groupHint stored on identity', () => {
  const id = new Identity();
  id.generate('test-group');
  assert.strictEqual(id.groupHint, 'test-group');
});
test('generate(): createdAt is ISO string', () => {
  const id = new Identity();
  id.generate();
  assert.ok(id.createdAt);
  assert.doesNotThrow(() => new Date(id.createdAt));
});

// ── Identity.sign() ───────────────────────────────────────────────────────────
test('sign(): returns base64 string', () => {
  const id = new Identity();
  id.generate();
  const sig = id.sign('test-payload');
  assert.ok(/^[A-Za-z0-9+/=]+$/.test(sig));
});
test('sign(): different payloads produce different sigs', () => {
  const id = new Identity();
  id.generate();
  assert.notStrictEqual(id.sign('payload-a'), id.sign('payload-b'));
});
test('sign(): before generate() throws', () => {
  const id = new Identity();
  assert.throws(() => id.sign('x'), /sign\(\) called before identity loaded/);
});
test('sign(): Buffer payload works', () => {
  const id = new Identity();
  id.generate();
  assert.doesNotThrow(() => id.sign(Buffer.from('buffer-payload')));
});
test('sign(): signature verifiable with public key', () => {
  const id = new Identity();
  id.generate();
  const payload = Buffer.from('verify-me');
  const sigB64 = id.sign(payload);
  const sig = Buffer.from(sigB64, 'base64');
  const valid = crypto.verify(null, payload, { key: id.publicKey, dsaEncoding: 'der' }, sig);
  assert.ok(valid);
});

// ── Identity.handshake() ──────────────────────────────────────────────────────
test('handshake(): returns uuid, publicKey, ts, sig', () => {
  const id = new Identity();
  id.generate();
  const hs = id.handshake();
  assert.ok(hs.uuid && hs.publicKey && hs.ts && hs.sig);
});
test('handshake(): uuid matches identity uuid', () => {
  const id = new Identity();
  id.generate();
  assert.strictEqual(id.handshake().uuid, id.uuid);
});
test('handshake(): ts is recent (< 5s old)', () => {
  const id = new Identity();
  id.generate();
  const before = Date.now();
  const hs = id.handshake();
  assert.ok(hs.ts >= before && hs.ts <= Date.now() + 100);
});
test('handshake(): before generate() throws', () => {
  const id = new Identity();
  assert.throws(() => id.handshake(), /handshake\(\) called before identity loaded/);
});

// ── verifyHandshake() ─────────────────────────────────────────────────────────
test('verifyHandshake(): valid handshake returns ok:true', () => {
  const id = new Identity();
  id.generate();
  const hs = id.handshake();
  const r = verifyHandshake(hs);
  assert.ok(r.ok, r.reason);
});
test('verifyHandshake(): returns uuid on success', () => {
  const id = new Identity();
  id.generate();
  const hs = id.handshake();
  const r = verifyHandshake(hs);
  assert.strictEqual(r.uuid, id.uuid);
});
test('verifyHandshake(): missing fields → ok:false', () => {
  const r = verifyHandshake({ uuid: 'x' });
  assert.ok(!r.ok);
  assert.match(r.reason, /missing fields/);
});
test('verifyHandshake(): stale timestamp → ok:false', () => {
  const id = new Identity();
  id.generate();
  const hs = id.handshake();
  hs.ts = Date.now() - 31000; // 31 seconds ago
  const r = verifyHandshake(hs);
  assert.ok(!r.ok);
  assert.match(r.reason, /stale timestamp/);
});
test('verifyHandshake(): tampered uuid → UUID-publicKey mismatch', () => {
  const id = new Identity();
  id.generate();
  const hs = id.handshake();
  hs.uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const r = verifyHandshake(hs);
  assert.ok(!r.ok);
  assert.match(r.reason, /mismatch/);
});
test('verifyHandshake(): tampered sig → signature invalid', () => {
  const id = new Identity();
  id.generate();
  const hs = id.handshake();
  hs.sig = Buffer.alloc(64).toString('base64'); // all-zero sig
  const r = verifyHandshake(hs);
  assert.ok(!r.ok);
});
test('verifyHandshake(): invalid publicKey encoding → ok:false', () => {
  const id = new Identity();
  id.generate();
  const hs = id.handshake();
  hs.publicKey = 'not-valid-base64!!!';
  const r = verifyHandshake(hs);
  assert.ok(!r.ok);
});
test('verifyHandshake(): groupHint preserved in result', () => {
  const id = new Identity();
  id.generate('my-group');
  const hs = id.handshake();
  const r = verifyHandshake(hs);
  assert.strictEqual(r.groupHint, 'my-group');
});

// ── Identity.publicRecord() ───────────────────────────────────────────────────
test('publicRecord(): has uuid, publicKey, groupHint, createdAt', () => {
  const id = new Identity();
  id.generate('grp');
  const rec = id.publicRecord();
  assert.ok(rec.uuid);
  assert.ok(rec.publicKey);
  assert.ok(rec.createdAt);
  assert.strictEqual(rec.groupHint, 'grp');
});
test('publicRecord(): contains NO private key material', () => {
  const id = new Identity();
  id.generate();
  const rec = id.publicRecord();
  const str = JSON.stringify(rec);
  assert.ok(!str.includes('PRIVATE'), 'No private key material in public record');
  assert.ok(!str.includes('pkcs8'),   'No PKCS8 in public record');
});

// ── Identity.load() ───────────────────────────────────────────────────────────
test('load(): restores identity from PEM + publicRecord', () => {
  const id1 = new Identity();
  id1.generate();
  const pem = id1._privateKey.export({ type: 'pkcs8', format: 'pem' });
  const rec = id1.publicRecord();
  const id2 = new Identity();
  id2.load(pem, rec);
  assert.strictEqual(id2.uuid, id1.uuid);
  assert.ok(id2.isLoaded);
});
test('load(): UUID mismatch → hard stop', () => {
  const id1 = new Identity();
  id1.generate();
  const pem = id1._privateKey.export({ type: 'pkcs8', format: 'pem' });
  const rec = { ...id1.publicRecord(), uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' };
  const id2 = new Identity();
  assert.throws(() => id2.load(pem, rec), /HARD STOP.*mismatch/i);
});
test('load(): invalid PEM → HARD STOP', () => {
  const id = new Identity();
  assert.throws(() => id.load('not-a-pem', { uuid: 'x', publicKey: 'y' }), /HARD STOP/);
});
test('load(): loaded identity can sign', () => {
  const id1 = new Identity();
  id1.generate();
  const pem = id1._privateKey.export({ type: 'pkcs8', format: 'pem' });
  const id2 = new Identity();
  id2.load(pem, id1.publicRecord());
  assert.doesNotThrow(() => id2.sign('test'));
});
test('load(): loaded identity produces verifiable handshake', () => {
  const id1 = new Identity();
  id1.generate();
  const pem = id1._privateKey.export({ type: 'pkcs8', format: 'pem' });
  const id2 = new Identity();
  id2.load(pem, id1.publicRecord());
  const hs = id2.handshake();
  const r = verifyHandshake(hs);
  assert.ok(r.ok, r.reason);
});

// ── makeMigrationAssertion() ──────────────────────────────────────────────────
test('makeMigrationAssertion(): valid reason produces assertion', () => {
  const id = new Identity();
  id.generate();
  const a = id.makeMigrationAssertion('old-uuid', 'reset');
  assert.ok(a.ancestorUuid === 'old-uuid');
  assert.ok(a.newUUID === id.uuid);
  assert.ok(a.selfSig);
  assert.ok(a.migratedAt > 0);
});
test('makeMigrationAssertion(): invalid reason throws', () => {
  const id = new Identity();
  id.generate();
  assert.throws(() => id.makeMigrationAssertion('old', 'hack'), /Unknown migration reason/);
});
test('makeMigrationAssertion(): all valid reasons accepted', () => {
  const id = new Identity();
  id.generate();
  for (const r of ['tpm-loss', 'reset', 'clone-resolution', 'scheduled']) {
    assert.doesNotThrow(() => id.makeMigrationAssertion('old', r), `reason=${r}`);
  }
});

// ── loadOrInit() ──────────────────────────────────────────────────────────────
test('loadOrInit(): generates new identity on first run', async () => {
  const dir = path.join(os.tmpdir(), `id-init-${Date.now()}`);
  const id = await loadOrInit({ dataDir: dir });
  assert.ok(id.uuid);
  assert.ok(id.isLoaded);
  assert.ok(fs.existsSync(path.join(dir, 'identity.json')));
  fs.rmSync(dir, { recursive: true });
});
test('loadOrInit(): identity.json is a valid public record', async () => {
  const dir = path.join(os.tmpdir(), `id-json-${Date.now()}`);
  await loadOrInit({ dataDir: dir });
  const rec = JSON.parse(fs.readFileSync(path.join(dir, 'identity.json'), 'utf8'));
  assert.ok(rec.uuid && rec.publicKey && rec.createdAt);
  assert.ok(!JSON.stringify(rec).includes('PRIVATE'));
  fs.rmSync(dir, { recursive: true });
});
test('loadOrInit(): same UUID on second call (stable identity)', async () => {
  const dir = path.join(os.tmpdir(), `id-stable-${Date.now()}`);
  const id1 = await loadOrInit({ dataDir: dir });
  const id2 = await loadOrInit({ dataDir: dir });
  assert.strictEqual(id1.uuid, id2.uuid);
  fs.rmSync(dir, { recursive: true });
});
test('loadOrInit(): produces verifiable handshake', async () => {
  const dir = path.join(os.tmpdir(), `id-hs-${Date.now()}`);
  const id = await loadOrInit({ dataDir: dir });
  const hs = id.handshake();
  const r = verifyHandshake(hs);
  assert.ok(r.ok, r.reason);
  fs.rmSync(dir, { recursive: true });
});
test('loadOrInit(): groupHint preserved', async () => {
  const dir = path.join(os.tmpdir(), `id-grp-${Date.now()}`);
  const id = await loadOrInit({ dataDir: dir, groupHint: 'nexus' });
  assert.strictEqual(id.groupHint, 'nexus');
  fs.rmSync(dir, { recursive: true });
});

// ── resetIdentity() ───────────────────────────────────────────────────────────
test('resetIdentity(): requires confirm:true', async () => {
  await assert.rejects(
    () => resetIdentity({ dataDir: os.tmpdir(), confirm: false }),
    /confirm:true/
  );
});
test('resetIdentity(): produces new UUID', async () => {
  const dir = path.join(os.tmpdir(), `id-reset-${Date.now()}`);
  const id1 = await loadOrInit({ dataDir: dir });
  const { identity: id2 } = await resetIdentity({ dataDir: dir, confirm: true });
  assert.notStrictEqual(id1.uuid, id2.uuid);
  fs.rmSync(dir, { recursive: true });
});
test('resetIdentity(): old identity.json archived, not deleted', async () => {
  const dir = path.join(os.tmpdir(), `id-archive-${Date.now()}`);
  await loadOrInit({ dataDir: dir });
  await resetIdentity({ dataDir: dir, confirm: true });
  const files = fs.readdirSync(dir);
  assert.ok(files.some(f => f.includes('identity.json.old.')));
  fs.rmSync(dir, { recursive: true });
});

run();
