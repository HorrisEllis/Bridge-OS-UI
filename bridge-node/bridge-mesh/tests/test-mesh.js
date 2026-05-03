// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
'use strict';
const assert  = require('assert');
const crypto  = require('crypto');
const { createMeshNode, generateSessionKeypair, deriveSessionKey, encrypt, decrypt } = require('../index');
const { createPeerRegistry }       = require('../mesh/peer-discovery');
const { createTrustSignalHandler, DIVERGENCE_THRESHOLD } = require('../mesh/trust-signal');
const { createHostRotator }        = require('../network/host-rotation');
const { createPortRegistry, isPortFree } = require('../network/port-registry');
const { loadOrInit }               = require('../../bridge-identity/index');
const { createIME }                = require('../../bridge-IME/index');
const { createSNGate }             = require('../../bridge-sngate/index');
const os   = require('os');
const path = require('path');
const fs   = require('fs');

let passed = 0, failed = 0;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
async function run() {
  console.log('\n[bridge-mesh] Test Suite\n');
  for (const t of tests) {
    try { await t.fn(); console.log(`  ✓ ${t.name}`); passed++; }
    catch (e) { console.log(`  ✗ ${t.name}\n    ${e.message}`); failed++; }
  }
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

// ── Suite 1: ECDH session keys ────────────────────────────────────────────────

test('generateSessionKeypair() produces public key buffer', () => {
  const { publicKeyBuffer, publicKeyB64 } = generateSessionKeypair();
  assert.ok(Buffer.isBuffer(publicKeyBuffer));
  assert.ok(publicKeyB64.length > 0);
});

test('Two nodes derive same session key from ECDH exchange', () => {
  const kpA = generateSessionKeypair();
  const kpB = generateSessionKeypair();
  const keyA = deriveSessionKey(kpA.privateKey, kpB.publicKeyBuffer);
  const keyB = deriveSessionKey(kpB.privateKey, kpA.publicKeyBuffer);
  assert.deepStrictEqual(keyA, keyB);
});

test('Different keypairs produce different session keys', () => {
  const kpA = generateSessionKeypair();
  const kpB = generateSessionKeypair();
  const kpC = generateSessionKeypair();
  const keyAB = deriveSessionKey(kpA.privateKey, kpB.publicKeyBuffer);
  const keyAC = deriveSessionKey(kpA.privateKey, kpC.publicKeyBuffer);
  assert.notDeepStrictEqual(keyAB, keyAC);
});

// ── Suite 2: AES-256-GCM encrypt/decrypt ────────────────────────────────────

test('encrypt() + decrypt() round-trips object', () => {
  const key   = crypto.randomBytes(32);
  const plain = { action: 'click', selector: '#btn', ts: Date.now() };
  const ct    = encrypt(key, plain);
  const rt    = decrypt(key, ct);
  assert.deepStrictEqual(rt, plain);
});

test('decrypt() throws on tampered ciphertext', () => {
  const key = crypto.randomBytes(32);
  const ct  = encrypt(key, { x: 1 });
  ct.enc    = Buffer.from('tampered').toString('base64');
  assert.throws(() => decrypt(key, ct), /Decryption failed/);
});

test('encrypt() produces different ciphertext each call (random IV)', () => {
  const key = crypto.randomBytes(32);
  const ct1 = encrypt(key, { x: 1 });
  const ct2 = encrypt(key, { x: 1 });
  assert.notStrictEqual(ct1.iv, ct2.iv);
});

test('secure channel send/receive round-trip', () => {
  const kpA = generateSessionKeypair();
  const kpB = generateSessionKeypair();
  const key = deriveSessionKey(kpA.privateKey, kpB.publicKeyBuffer);
  const { createSecureChannel } = require('../mesh/channel');
  const chanA = createSecureChannel({ peerUuid: 'node-B', sessionKey: key });
  const chanB = createSecureChannel({ peerUuid: 'node-A', sessionKey: key });
  const ct = chanA.send({ msg: 'hello from A' });
  const rt = chanB.receive(ct);
  assert.deepStrictEqual(rt, { msg: 'hello from A' });
});

// ── Suite 3: Peer registry + handshake ────────────────────────────────────────

test('registerFromHandshake() accepts valid handshake', async () => {
  const dir    = path.join(os.tmpdir(), `mesh-test-${Date.now()}`);
  const id     = await loadOrInit({ dataDir: dir });
  const events = [];
  const reg    = createPeerRegistry({ busEmit: (s, d) => events.push({ s, d }) });

  const hs     = id.handshake();
  const result = reg.registerFromHandshake(hs, '192.168.1.5', 'lan');
  assert.ok(result.ok, result.reason);
  assert.strictEqual(result.peer.uuid, id.uuid);
  assert.strictEqual(result.peer.discoveredVia, 'lan');
  fs.rmSync(dir, { recursive: true });
});

test('registerFromHandshake() rejects tampered signature', async () => {
  const dir  = path.join(os.tmpdir(), `mesh-test-${Date.now()}`);
  const id   = await loadOrInit({ dataDir: dir });
  const reg  = createPeerRegistry({});
  const hs   = id.handshake();
  hs.sig     = 'badbadbadbad==';
  const r    = reg.registerFromHandshake(hs, '10.0.0.1', 'manual');
  assert.ok(!r.ok);
  fs.rmSync(dir, { recursive: true });
});

test('registerFromHandshake() rejects mismatched UUID', async () => {
  const dir  = path.join(os.tmpdir(), `mesh-test-${Date.now()}`);
  const id   = await loadOrInit({ dataDir: dir });
  const reg  = createPeerRegistry({});
  const hs   = id.handshake();
  hs.uuid    = 'aaaaaaaa-0000-0000-0000-000000000000';
  const r    = reg.registerFromHandshake(hs, '10.0.0.1', 'manual');
  assert.ok(!r.ok);
  fs.rmSync(dir, { recursive: true });
});

test('registerFromHandshake() emits mesh:peer:registered event', async () => {
  const dir    = path.join(os.tmpdir(), `mesh-test-${Date.now()}`);
  const id     = await loadOrInit({ dataDir: dir });
  const events = [];
  const reg    = createPeerRegistry({ busEmit: (s, d) => events.push({ s, d }) });
  reg.registerFromHandshake(id.handshake(), '10.0.0.1', 'manual');
  assert.ok(events.some(e => e.s === 'mesh:peer:registered'));
  fs.rmSync(dir, { recursive: true });
});

test('LAN discovery does not grant trust bonus (trustTier stays unverified)', async () => {
  const dir  = path.join(os.tmpdir(), `mesh-test-${Date.now()}`);
  const id   = await loadOrInit({ dataDir: dir });
  const reg  = createPeerRegistry({});
  const r    = reg.registerFromHandshake(id.handshake(), '192.168.1.5', 'lan');
  assert.strictEqual(r.peer.trustTier, 'unverified');
  assert.strictEqual(r.peer.discoveredVia, 'lan');
  fs.rmSync(dir, { recursive: true });
});

test('sngate deny blocks peer registration', async () => {
  const dir  = path.join(os.tmpdir(), `mesh-test-${Date.now()}`);
  const id   = await loadOrInit({ dataDir: dir });
  const gate = createSNGate({ logDir: null });
  gate.rules.add({ type: 'uuid', value: id.uuid, action: 'deny', surface: 'mesh' });
  const reg  = createPeerRegistry({ gate });
  const r    = reg.registerFromHandshake(id.handshake(), '10.0.0.1', 'manual');
  assert.ok(!r.ok);
  assert.match(r.reason, /sngate denied/);
  fs.rmSync(dir, { recursive: true });
});

test('peer.seen() updates lastSeen', async () => {
  const dir  = path.join(os.tmpdir(), `mesh-test-${Date.now()}`);
  const id   = await loadOrInit({ dataDir: dir });
  const reg  = createPeerRegistry({});
  reg.registerFromHandshake(id.handshake(), '10.0.0.1', 'manual');
  const before = reg.get(id.uuid).lastSeen;
  await new Promise(r => setTimeout(r, 10));
  reg.seen(id.uuid);
  assert.ok(reg.get(id.uuid).lastSeen >= before);
  fs.rmSync(dir, { recursive: true });
});

test('stalePeers() returns peers not seen recently', async () => {
  const dir  = path.join(os.tmpdir(), `mesh-test-${Date.now()}`);
  const id   = await loadOrInit({ dataDir: dir });
  const reg  = createPeerRegistry({});
  reg.registerFromHandshake(id.handshake(), '10.0.0.1', 'manual');
  const peer = reg.get(id.uuid);
  peer.lastSeen = Date.now() - 120000; // 2 min ago
  const stale = reg.stalePeers(60000);
  assert.ok(stale.some(p => p.uuid === id.uuid));
  fs.rmSync(dir, { recursive: true });
});

// ── Suite 4: Trust signal protocol ───────────────────────────────────────────

test('DIVERGENCE_THRESHOLD is 4', () => {
  assert.strictEqual(DIVERGENCE_THRESHOLD, 4);
});

test('receiveSignal() flags divergence above threshold', () => {
  const ime     = createIME({ storeDir: null });
  const events  = [];
  const handler = createTrustSignalHandler({ ime, busEmit: (s, d) => events.push({ s, d }) });

  // Our score for some UUID is ~5 (base)
  const signal = { aboutUuid: 'disputed-node', myScore: 10, senderUuid: 'peer-X' };
  const r      = handler.receiveSignal(signal);
  assert.ok(r.disputed);
  assert.ok(events.some(e => e.s === 'mesh:trust:divergence'));
});

test('receiveSignal() no flag when scores close', () => {
  const ime     = createIME({ storeDir: null });
  const handler = createTrustSignalHandler({ ime });
  const signal  = { aboutUuid: 'close-node', myScore: 6, senderUuid: 'peer-Y' };
  const r       = handler.receiveSignal(signal);
  assert.ok(!r.disputed);
});

test('resolveDispute() marks dispute resolved', () => {
  const ime     = createIME({ storeDir: null });
  const handler = createTrustSignalHandler({ ime });
  handler.receiveSignal({ aboutUuid: 'uuid-X', myScore: 10, senderUuid: 'p' });
  const disputes = handler.listDisputes();
  assert.ok(disputes.length >= 1);
  const r = handler.resolveDispute(disputes[0].id, 'admin');
  assert.ok(r.ok);
  assert.ok(handler.listDisputes()[0].resolved);
});

test('trust signal never auto-resolves — human required', () => {
  const ime     = createIME({ storeDir: null });
  const handler = createTrustSignalHandler({ ime });
  handler.receiveSignal({ aboutUuid: 'auto-check', myScore: 10, senderUuid: 'p' });
  const d = handler.listDisputes()[0];
  assert.strictEqual(d.resolved, false);
  assert.strictEqual(d.action, 'flag');
});

// ── Suite 5: Host rotation ────────────────────────────────────────────────────

test('createHostRotator() current() returns null when empty', () => {
  const r = createHostRotator({});
  assert.strictEqual(r.current(), null);
});

test('add() and current() work', () => {
  const r = createHostRotator({});
  r.add('1.2.3.4', 3747);
  assert.deepStrictEqual(r.current(), { host: '1.2.3.4', port: 3747, lastTried: null, failures: 0 });
});

test('reportFailure() rotates to next address', () => {
  const r = createHostRotator({});
  r.add('1.2.3.4', 3747);
  r.add('5.6.7.8', 3748);
  r.reportFailure('1.2.3.4', 3747);
  assert.strictEqual(r.current().host, '5.6.7.8');
});

test('isExhausted() true when all addresses failed 3+ times', () => {
  const r = createHostRotator({});
  r.add('1.2.3.4', 3747);
  r.reportFailure('1.2.3.4', 3747);
  r.reportFailure('1.2.3.4', 3747);
  r.reportFailure('1.2.3.4', 3747);
  assert.ok(r.isExhausted());
});

test('reportSuccess() resets failures', () => {
  const r = createHostRotator({});
  r.add('1.2.3.4', 3747);
  r.reportFailure('1.2.3.4', 3747);
  r.reportSuccess('1.2.3.4', 3747);
  assert.strictEqual(r.current().failures, 0);
});

// ── Suite 6: Port registry ────────────────────────────────────────────────────

test('isPortFree() returns boolean', async () => {
  const free = await isPortFree(19999);
  assert.ok(typeof free === 'boolean');
});

test('createPortRegistry() claim returns free port', async () => {
  const reg  = createPortRegistry();
  const port = await reg.claim('bridge');
  assert.ok(port >= 3747);
  reg.release('bridge');
});

test('createPortRegistry() list() shows claimed ports', async () => {
  const reg  = createPortRegistry();
  await reg.claim('bridge');
  const list = reg.list();
  assert.ok('bridge' in list);
  reg.release('bridge');
});

// ── Suite 7: MeshNode HTTP routes ─────────────────────────────────────────────

test('/mesh/peers returns empty list initially', () => {
  const node = createMeshNode({});
  const res  = mockRes();
  node.route('GET', ['mesh', 'peers'], null, null, res);
  assert.strictEqual(res._status, 200);
  assert.strictEqual(res._json.count, 0);
});

test('/mesh/handshake returns 400 without handshake', () => {
  const node = createMeshNode({});
  const res  = mockRes();
  node.route('POST', ['mesh', 'handshake'], {}, null, res);
  assert.strictEqual(res._status, 400);
});

test('/mesh/disputes returns empty array', () => {
  const node = createMeshNode({});
  const res  = mockRes();
  node.route('GET', ['mesh', 'disputes'], null, null, res);
  assert.strictEqual(res._status, 200);
  assert.ok(Array.isArray(res._json.disputes));
});

test('/mesh/ports returns claimed ports', async () => {
  const node = createMeshNode({});
  const res  = mockRes();
  node.route('GET', ['mesh', 'ports'], null, null, res);
  assert.strictEqual(res._status, 200);
  assert.ok(typeof res._json.ports === 'object');
});

function mockRes() {
  const r = { _status: null, _json: null };
  r.writeHead = (s) => { r._status = s; };
  r.end = (d) => { try { r._json = JSON.parse(d); } catch { r._raw = d; } };
  return r;
}

run();
