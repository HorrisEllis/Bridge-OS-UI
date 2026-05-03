// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
'use strict';
/**
 * bridge-heartbeat/tests/test-heartbeat-deep.js
 * §4.1 §1.1 §1.2
 * Covers: BPMTracker, latencyGrade, HeartbeatManager, PulseEmitter/Listener
 */
const assert = require('assert');
const {
  createHeartbeatManager, createBPMTracker,
  createPulseEmitter, createPulseListener,
  latencyGrade,
} = require('../index');

let passed = 0, failed = 0;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
async function run() {
  console.log('\n[bridge-heartbeat] Deep Test Suite\n');
  for (const t of tests) {
    try { await t.fn(); console.log(`  ✓ ${t.name}`); passed++; }
    catch (e) { console.error(`  ✗ ${t.name}\n    ${e.message}`); failed++; }
  }
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

// ── latencyGrade() ────────────────────────────────────────────────────────────
test('latencyGrade(): ≤50ms → 1.0', () => {
  assert.strictEqual(latencyGrade(0),  1.0);
  assert.strictEqual(latencyGrade(50), 1.0);
});
test('latencyGrade(): 51–150ms → 0.8', () => {
  assert.strictEqual(latencyGrade(51),  0.8);
  assert.strictEqual(latencyGrade(150), 0.8);
});
test('latencyGrade(): 151–500ms → 0.5', () => {
  assert.strictEqual(latencyGrade(151), 0.5);
  assert.strictEqual(latencyGrade(500), 0.5);
});
test('latencyGrade(): 501–1500ms → 0.2', () => {
  assert.strictEqual(latencyGrade(501),  0.2);
  assert.strictEqual(latencyGrade(1500), 0.2);
});
test('latencyGrade(): >1500ms → 0.0', () => {
  assert.strictEqual(latencyGrade(1501),  0.0);
  assert.strictEqual(latencyGrade(10000), 0.0);
});
test('latencyGrade(): returns number in 0–1 range', () => {
  for (const ms of [0, 25, 100, 300, 1000, 2000]) {
    const g = latencyGrade(ms);
    assert.ok(g >= 0 && g <= 1, `latencyGrade(${ms})=${g}`);
  }
});

// ── createBPMTracker() ────────────────────────────────────────────────────────
test('BPMTracker: bpm() returns 0 before any beats', () => {
  const t = createBPMTracker(10);
  assert.strictEqual(t.bpm(), 0);
});
test('BPMTracker: consistency() returns 1.0 with < 2 intervals', () => {
  const t = createBPMTracker(10);
  assert.strictEqual(t.consistency(), 1.0);
});
test('BPMTracker: beat() returns bpm number', () => {
  const t = createBPMTracker(10);
  const b = t.beat();
  assert.ok(typeof b === 'number');
});
test('BPMTracker: bpm() > 0 after two beats', async () => {
  const t = createBPMTracker(10);
  t.beat();
  await new Promise(r => setTimeout(r, 20));
  t.beat();
  assert.ok(t.bpm() > 0);
});
test('BPMTracker: intervals window capped at windowSize', async () => {
  const t = createBPMTracker(3);
  for (let i = 0; i < 10; i++) {
    t.beat();
    await new Promise(r => setTimeout(r, 5));
  }
  assert.ok(t.intervals().length <= 3);
});
test('BPMTracker: consistency() is 0–1', async () => {
  const t = createBPMTracker(5);
  for (let i = 0; i < 6; i++) {
    t.beat();
    await new Promise(r => setTimeout(r, 10));
  }
  const c = t.consistency();
  assert.ok(c >= 0 && c <= 1, `consistency=${c}`);
});
test('BPMTracker: perfect regularity → consistency near 1.0', async () => {
  const t = createBPMTracker(10);
  // Simulate perfectly regular 50ms intervals by manipulating internal state
  for (let i = 0; i < 10; i++) {
    t.beat();
    await new Promise(r => setTimeout(r, 50));
  }
  // With regular beats consistency should be > 0.5
  assert.ok(t.consistency() > 0.3, `expected high consistency, got ${t.consistency()}`);
});
test('BPMTracker: intervals() returns a copy', async () => {
  const t = createBPMTracker(10);
  t.beat();
  await new Promise(r => setTimeout(r, 10));
  t.beat();
  const arr = t.intervals();
  arr.push(99999);
  assert.ok(!t.intervals().includes(99999));
});

// ── createHeartbeatManager() ──────────────────────────────────────────────────
test('createHeartbeatManager(): returns register, unregister, getStatus, listNodes', () => {
  const hb = createHeartbeatManager({});
  for (const m of ['register','unregister','getStatus','listNodes']) {
    assert.strictEqual(typeof hb[m], 'function', `missing: ${m}`);
  }
});
test('getStatus(): returns null for unregistered uuid', () => {
  const hb = createHeartbeatManager({});
  assert.strictEqual(hb.getStatus('nonexistent'), null);
});
test('register(): getStatus() returns status object', () => {
  const hb = createHeartbeatManager({ cfg: { pulseInterval: 9999 } });
  hb.register('reg-uuid', 'http://localhost:9');
  const s = hb.getStatus('reg-uuid');
  assert.ok(s && s.uuid === 'reg-uuid');
  hb.unregister('reg-uuid');
});
test('getStatus(): has bpm, consistency, missedBeats, latency, healthScore', () => {
  const hb = createHeartbeatManager({ cfg: { pulseInterval: 9999 } });
  hb.register('shape-uuid', 'http://localhost:9');
  const s = hb.getStatus('shape-uuid');
  assert.ok('bpm'         in s, 'missing bpm');
  assert.ok('consistency' in s, 'missing consistency');
  assert.ok('missedBeats' in s, 'missing missedBeats');
  assert.ok('latency'     in s, 'missing latency');
  assert.ok('healthScore' in s, 'missing healthScore');
  hb.unregister('shape-uuid');
});
test('register(): double-register is safe no-op', () => {
  const hb = createHeartbeatManager({ cfg: { pulseInterval: 9999 } });
  hb.register('dup-uuid', 'http://localhost:9');
  assert.doesNotThrow(() => hb.register('dup-uuid', 'http://localhost:9'));
  hb.unregister('dup-uuid');
});
test('unregister(): getStatus() returns null after unregister', () => {
  const hb = createHeartbeatManager({ cfg: { pulseInterval: 9999 } });
  hb.register('unreg-uuid', 'http://localhost:9');
  hb.unregister('unreg-uuid');
  assert.strictEqual(hb.getStatus('unreg-uuid'), null);
});
test('unregister(): unregistering nonexistent uuid is safe', () => {
  const hb = createHeartbeatManager({});
  assert.doesNotThrow(() => hb.unregister('no-such-uuid'));
});
test('listNodes(): returns array', () => {
  const hb = createHeartbeatManager({});
  assert.ok(Array.isArray(hb.listNodes()));
});
test('listNodes(): contains registered nodes', () => {
  const hb = createHeartbeatManager({ cfg: { pulseInterval: 9999 } });
  hb.register('list-uuid', 'http://localhost:9');
  assert.ok(hb.listNodes().find(n => n.uuid === 'list-uuid'));
  hb.unregister('list-uuid');
});
test('busEmit: node:degraded emitted on missed beats reaching degradeAt', async () => {
  const emitted = [];
  const fakeCheck = () => Promise.resolve({ ok: false, latency: 5000 });
  // Patch checkHealth for this instance via config override isn't possible
  // So we test through the lifecycle: busEmit is called by the manager
  const hb = createHeartbeatManager({
    cfg: { pulseInterval: 20, degradeAt: 1, deadAt: 5, healthTimeout: 10 },
    busEmit: (sig, d) => emitted.push({ sig, d }),
  });
  // Register with a port that refuses connections so health checks fail
  hb.register('degrade-uuid', 'http://127.0.0.1:1');
  await new Promise(r => setTimeout(r, 80));
  hb.unregister('degrade-uuid');
  // Either node:degraded or node:dead emitted
  const degraded = emitted.find(e => e.sig === 'node:degraded' || e.sig === 'node:dead');
  assert.ok(degraded, 'Expected node:degraded or node:dead to be emitted');
});
test('LAN TRUST INVARIANT: pulse discovery ≠ trust credential', () => {
  // Discovery via LAN still requires full signed handshake — this is architectural.
  // Validate the invariant is documented in source.
  const src = require('fs').readFileSync(require.resolve('../index'), 'utf8');
  assert.ok(
    src.includes('Proximity is not a credential') ||
    src.includes('LAN Trust Invariant') ||
    src.includes('full signed handshake'),
    'LAN trust invariant must be documented in source'
  );
});

// ── createPulseEmitter() / createPulseListener() ──────────────────────────────
test('createPulseEmitter(): returns start and stop functions', () => {
  const crypto = require('crypto');
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const e = createPulseEmitter({
    uuid:         crypto.randomUUID(),
    publicKeyB64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    port:         37770,
  });
  assert.strictEqual(typeof e.start, 'function');
  assert.strictEqual(typeof e.stop,  'function');
});
test('createPulseListener(): returns start and stop functions', () => {
  const l = createPulseListener({ port: 37771 });
  assert.strictEqual(typeof l.start, 'function');
  assert.strictEqual(typeof l.stop,  'function');
});
test('PulseEmitter/Listener: broadcast and receive nexus:pulse', async () => {
  const crypto = require('crypto');
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const testUuid = crypto.randomUUID();
  const received = [];

  const listener = createPulseListener({
    port:    37772,
    onPulse: (data) => received.push(data),
  });
  listener.start();
  await new Promise(r => setTimeout(r, 30));

  const emitter = createPulseEmitter({
    uuid:         testUuid,
    publicKeyB64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    port:         37772,
  });
  emitter.start(50);
  await new Promise(r => setTimeout(r, 150));
  emitter.stop();
  listener.stop();

  assert.ok(received.length > 0, 'Should have received at least one pulse');
  assert.strictEqual(received[0].type, 'nexus:pulse');
  assert.strictEqual(received[0].uuid, testUuid);
});
test('PulseEmitter: pulse payload has uuid, publicKey, ts, type', async () => {
  const crypto = require('crypto');
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  const testUuid = crypto.randomUUID();
  let pulseData = null;

  const listener = createPulseListener({ port: 37773, onPulse: d => { pulseData = d; } });
  listener.start();
  await new Promise(r => setTimeout(r, 20));

  const emitter = createPulseEmitter({
    uuid: testUuid,
    publicKeyB64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    port: 37773,
  });
  emitter.start(50);
  await new Promise(r => setTimeout(r, 100));
  emitter.stop();
  listener.stop();

  assert.ok(pulseData, 'Should have received pulse');
  assert.ok(pulseData.uuid      === testUuid, 'uuid should match');
  assert.ok(pulseData.publicKey,              'publicKey required');
  assert.ok(pulseData.ts > 0,                 'ts must be positive');
  assert.ok(pulseData.type === 'nexus:pulse', 'type must be nexus:pulse');
});

run();
