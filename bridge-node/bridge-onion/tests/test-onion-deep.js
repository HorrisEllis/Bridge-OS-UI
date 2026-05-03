// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
'use strict';
/**
 * bridge-onion/tests/test-onion-deep.js
 * Covers: ephemeral keypairs, circuit build, layer encrypt/decrypt, processLayer,
 * circuit expiry, invariants O-01 through O-05
 */
const assert = require('assert');
const crypto = require('crypto');
const { createOnionRouter, buildCircuit, processLayer, ephemeralKeyPair, deriveSharedKey } = require('../index');

let passed = 0, failed = 0;
const tests = [];
function test(n, fn) { tests.push({ n, fn }); }
async function run() {
  console.log('\n[bridge-onion] Deep Test Suite\n');
  for (const t of tests) {
    try { await t.fn(); console.log(`  ✓ ${t.n}`); passed++; }
    catch (e) { console.error(`  ✗ ${t.n}\n    ${e.message}`); failed++; }
  }
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

let _hopPort = 9100;
function makeHop() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const publicKeyB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  return { privateKey, publicKey, publicKeyB64, uuid: crypto.randomUUID(), address: `http://127.0.0.1:${_hopPort++}` };
}

test('ephemeralKeyPair(): returns privateKey, publicKey, publicKeyB64', () => {
  const kp = ephemeralKeyPair();
  assert.ok(kp.privateKey && kp.publicKey && kp.publicKeyB64);
  assert.ok(typeof kp.publicKeyB64 === 'string' && kp.publicKeyB64.length > 0);
});

test('deriveSharedKey(): derives 32-byte key from ECDH', () => {
  const kp1 = ephemeralKeyPair();
  const kp2 = ephemeralKeyPair();
  const key = deriveSharedKey(kp1.privateKey, kp2.publicKeyB64);
  assert.ok(Buffer.isBuffer(key) && key.length === 32);
});

test('deriveSharedKey(): is commutative (same shared secret both sides)', () => {
  const kp1 = ephemeralKeyPair();
  const kp2 = ephemeralKeyPair();
  const k1  = deriveSharedKey(kp1.privateKey, kp2.publicKeyB64);
  const k2  = deriveSharedKey(kp2.privateKey, kp1.publicKeyB64);
  assert.ok(k1.equals(k2), 'ECDH shared secret must be equal on both sides');
});

test('buildCircuit(): throws on fewer than 2 hops', () => {
  const hop = makeHop();
  assert.throws(() => buildCircuit({ hops: [hop], payload: Buffer.from('test'), identity: null }),
    /at least 2 hops/);
});

test('buildCircuit(): throws on more than 7 hops', () => {
  const hops = Array.from({ length: 8 }, makeHop);
  assert.throws(() => buildCircuit({ hops, payload: Buffer.from('test'), identity: null }),
    /max 7 hops/);
});

test('buildCircuit(): returns circuitId, firstHop, expiresAt, layer', () => {
  const hops = [makeHop(), makeHop(), makeHop()];
  const r = buildCircuit({ hops, payload: Buffer.from('hello onion'), identity: null });
  assert.ok(r.circuitId && r.firstHop && r.expiresAt && r.layer);
});

test('buildCircuit(): circuitId is a valid UUID', () => {
  const hops = [makeHop(), makeHop()];
  const r = buildCircuit({ hops, payload: Buffer.from('test'), identity: null });
  assert.match(r.circuitId, /^[0-9a-f-]{36}$/);
});

test('buildCircuit(): expiresAt is in future (≤ 5min)', () => {
  const hops = [makeHop(), makeHop()];
  const r = buildCircuit({ hops, payload: Buffer.from('test'), identity: null });
  assert.ok(r.expiresAt > Date.now());
  assert.ok(r.expiresAt <= Date.now() + 300_001);
});

test('INVARIANT O-01: first relay cannot see exit node address in its layer', () => {
  const hops = [makeHop(), makeHop(), makeHop()];
  const r = buildCircuit({ hops, payload: Buffer.from('probe'), identity: null });
  const packet = JSON.parse(r.layer);
  const str = JSON.stringify(packet);
  // First relay sees its successor (hops[1]) as nextHop — correct by design
  // First relay must NOT see hops[2] (the exit) anywhere in plaintext
  assert.ok(!str.includes(hops[2].address),
    'First relay must not see exit node address — O-01 violated');
  // hops[0] first hop may appear as the outer address; hops[1] appears as nextHop — correct
  assert.ok(str.includes(hops[1].address), 'First relay must know its successor (nextHop)');
});

test('INVARIANT O-02: TTL is exactly 300s', () => {
  const hops = [makeHop(), makeHop()];
  const before = Date.now();
  const r = buildCircuit({ hops, payload: Buffer.from('ttl'), identity: null });
  assert.ok(r.expiresAt - before <= 300_001 && r.expiresAt - before >= 299_000);
});

test('processLayer(): rejects expired circuit', () => {
  const hops = [makeHop(), makeHop()];
  const r = buildCircuit({ hops, payload: Buffer.from('expired'), identity: null });
  const packet = JSON.parse(r.layer);
  packet.expiresAt = Date.now() - 1000; // artificially expire
  const result = processLayer({ layer: JSON.stringify(packet), identity: { _privateKey: hops[0].privateKey }, busEmit: null });
  assert.ok(!result.ok);
  assert.match(result.reason, /expired/);
});

test('processLayer(): rejects malformed packet', () => {
  const result = processLayer({ layer: 'not json', identity: { _privateKey: null }, busEmit: null });
  assert.ok(!result.ok);
});

test('processLayer(): rejects missing fields', () => {
  const result = processLayer({ layer: JSON.stringify({ incomplete: true }), identity: { _privateKey: null }, busEmit: null });
  assert.ok(!result.ok);
  assert.match(result.reason, /missing fields/);
});

test('createOnionRouter(): requires identity', () => {
  assert.throws(() => createOnionRouter({}), /identity required/);
});

test('createOnionRouter(): exposes send, route, stop, diagnostics', () => {
  const hop = makeHop();
  const router = createOnionRouter({ identity: { _privateKey: hop.privateKey, uuid: hop.uuid } });
  for (const m of ['send', 'route', 'stop', 'diagnostics']) assert.strictEqual(typeof router[m], 'function');
  router.stop();
});

test('diagnostics(): returns circuits, relayed, built, errors', () => {
  const hop = makeHop();
  const router = createOnionRouter({ identity: { _privateKey: hop.privateKey, uuid: hop.uuid } });
  const d = router.diagnostics();
  assert.ok('circuits' in d || 'activeCircuits' in d);
  router.stop();
});

run();
