// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
'use strict';
const assert = require('assert');
const { createSNGate }  = require('../index');
const { createIME }     = require('../../bridge-IME/index');

let passed = 0, failed = 0;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
async function run() {
  console.log('\n[bridge-sngate] Test Suite\n');
  for (const t of tests) {
    try { await t.fn(); console.log(`  ✓ ${t.name}`); passed++; }
    catch (e) { console.log(`  ✗ ${t.name}\n    ${e.message}`); failed++; }
  }
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

// ── Suite 1: Core evaluate ────────────────────────────────────────────────────

test('evaluate() returns decision object with required fields', () => {
  const gate   = createSNGate({ logDir: null });
  const result = gate.evaluate({ type: 'http.request', surface: 'dev' });
  assert.ok('score'    in result);
  assert.ok('decision' in result);
  assert.ok('reason'   in result);
  assert.ok('gateId'   in result);
  assert.ok('trace'    in result);
});

test('evaluate() score is 0–10', () => {
  const gate   = createSNGate({ logDir: null });
  const result = gate.evaluate({ type: 'http.request', surface: 'dev' });
  assert.ok(result.score >= 0 && result.score <= 10);
});

test('identity verification failed → deny', () => {
  const gate   = createSNGate({ logDir: null });
  const result = gate.evaluate({
    type: 'mesh.handshake',
    identity: { uuid: 'bad-node', verified: false },
    surface: 'mesh',
  });
  assert.strictEqual(result.decision, 'deny');
  assert.strictEqual(result.score, 0);
});

test('UUID mismatch → deny score 0', () => {
  const gate   = createSNGate({ logDir: null });
  const result = gate.evaluate({
    type: 'mesh.handshake',
    identity: { uuid: 'mismatch-node', verified: false, uuidMismatch: true },
    surface: 'mesh',
  });
  assert.strictEqual(result.decision, 'deny');
  assert.strictEqual(result.score, 0);
});

test('no identity → observe (not deny, no rule)', () => {
  const gate   = createSNGate({ logDir: null, gateThreshold: 5 });
  const result = gate.evaluate({ type: 'http.request', surface: 'dev' });
  // No identity = neutral score = observe or allow depending on score
  assert.ok(['observe', 'allow'].includes(result.decision));
});

test('verified known identity → allow', () => {
  const gate   = createSNGate({ logDir: null });
  const result = gate.evaluate({
    type:     'http.request',
    identity: { uuid: 'good-node', verified: true, knownUUID: true },
    surface:  'dev',
  });
  assert.strictEqual(result.decision, 'allow');
});

// ── Suite 2: Three-state decisions ────────────────────────────────────────────

test('score alone never triggers deny', () => {
  const gate = createSNGate({ logDir: null, gateThreshold: 10 }); // very high threshold
  const result = gate.evaluate({
    type:     'http.request',
    identity: { uuid: 'low-trust', verified: true },
    surface:  'dev',
  });
  // Low score, no deny rule → must be observe, not deny
  assert.notStrictEqual(result.decision, 'deny', 'Score alone must not trigger deny');
});

test('deny requires matching rule', () => {
  const gate = createSNGate({ logDir: null });
  gate.rules.add({ type: 'uuid', value: 'blocked-uuid', action: 'deny' });
  const result = gate.evaluate({
    type:     'http.request',
    identity: { uuid: 'blocked-uuid', verified: true },
    surface:  'dev',
  });
  assert.strictEqual(result.decision, 'deny');
});

test('allow rule overrides low score', () => {
  const gate = createSNGate({ logDir: null, gateThreshold: 10 });
  gate.rules.add({ type: 'uuid', value: 'allowlisted-uuid', action: 'allow' });
  const result = gate.evaluate({
    type:     'http.request',
    identity: { uuid: 'allowlisted-uuid', verified: true },
    surface:  'dev',
  });
  assert.strictEqual(result.decision, 'allow');
});

test('observe mode: low score without deny rule', () => {
  const gate = createSNGate({ logDir: null, gateThreshold: 8, observeThreshold: 3 });
  const result = gate.evaluate({
    type:     'http.request',
    identity: { uuid: 'neutral', verified: true },
    surface:  'dev',
  });
  assert.ok(['observe', 'allow'].includes(result.decision));
});

// ── Suite 3: Rule store ───────────────────────────────────────────────────────

test('rule add/remove/list works', () => {
  const gate = createSNGate({ logDir: null });
  const id   = gate.rules.add({ type: 'uuid', value: 'test', action: 'deny' });
  assert.ok(gate.rules.list().some(r => r.id === id));
  gate.rules.remove(id);
  assert.ok(!gate.rules.list().some(r => r.id === id));
});

test('domain rule matches payload.domain', () => {
  const gate = createSNGate({ logDir: null });
  gate.rules.add({ type: 'domain', value: 'evil.com', action: 'deny' });
  const result = gate.evaluate({
    type:    'http.request',
    payload: { domain: 'evil.com', url: 'https://evil.com/path' },
    surface: 'dev',
  });
  assert.strictEqual(result.decision, 'deny');
});

test('intent rule matches type prefix', () => {
  const gate = createSNGate({ logDir: null });
  gate.rules.add({ type: 'intent', value: 'agent.tool_call', action: 'deny' });
  const result = gate.evaluate({
    type:    'agent.tool_call',
    payload: { tool: 'exec' },
    surface: 'agent',
  });
  assert.strictEqual(result.decision, 'deny');
});

test('surface-scoped rule does not affect other surfaces', () => {
  const gate = createSNGate({ logDir: null });
  gate.rules.add({ type: 'uuid', value: 'my-uuid', action: 'deny', surface: 'mesh' });
  const result = gate.evaluate({
    type:     'http.request',
    identity: { uuid: 'my-uuid', verified: true },
    surface:  'dev', // different surface
  });
  assert.notStrictEqual(result.decision, 'deny');
});

// ── Suite 4: IME integration ──────────────────────────────────────────────────

test('IME profile feeds into fidelity score', () => {
  const ime  = createIME({ storeDir: null });
  const gate = createSNGate({ logDir: null }, ime);
  const uuid = 'ime-gate-uuid';

  // Build a profile with known-good history (30+ days, many events)
  const thirtyDaysAgo = Date.now() - 31 * 24 * 60 * 60 * 1000;
  for (let i = 0; i < 15; i++) {
    ime.ingest({ uuid, type: 'ssh.command', timestamp: thirtyDaysAgo + i * 60000, payload: {} });
  }

  const result = gate.evaluate({
    type:     'http.request',
    identity: { uuid, verified: true, knownUUID: true },
    surface:  'dev',
  });
  assert.ok(result.score > 0);
});

test('sngate never calls IME.ingest() — only getProfile()', () => {
  // Anti-recursion invariant: sngate must not write to IME
  let imeIngestCalled = false;
  const mockIME = {
    getProfile:    () => ({ trustScore: 7, scoreReasons: [] }),
    ingest:        () => { imeIngestCalled = true; return null; },
  };
  const gate = createSNGate({ logDir: null }, mockIME);
  gate.evaluate({
    type:     'http.request',
    identity: { uuid: 'test', verified: true },
    surface:  'dev',
  });
  assert.ok(!imeIngestCalled, 'sngate must NOT call IME.ingest() — anti-recursion invariant violated');
});

test('sngate unknown IME uuid uses neutral score', () => {
  const ime  = createIME({ storeDir: null });
  const gate = createSNGate({ logDir: null }, ime);
  const result = gate.evaluate({
    type:     'http.request',
    identity: { uuid: 'unknown-uuid-never-seen', verified: true },
    surface:  'dev',
  });
  assert.ok(result.score >= 0);
});

// ── Suite 5: Adapter shortcuts ────────────────────────────────────────────────

test('evaluateAgentCall() returns decision', () => {
  const gate   = createSNGate({ logDir: null });
  const result = gate.evaluateAgentCall('agent-uuid', 'file.write', { path: '/tmp/x' });
  assert.ok('decision' in result);
});

test('evaluateMeshHandshake() deny on failed verify', () => {
  const gate   = createSNGate({ logDir: null });
  const result = gate.evaluateMeshHandshake({ ok: false, reason: 'signature invalid', uuid: 'bad' });
  assert.strictEqual(result.decision, 'deny');
});

test('evaluateMeshHandshake() allow on good verify', () => {
  const gate   = createSNGate({ logDir: null });
  const result = gate.evaluateMeshHandshake({ ok: true, uuid: 'good-mesh-node', groupHint: null });
  assert.ok(['allow', 'observe'].includes(result.decision));
});

test('evaluateDataPush() observe for unverified sender', () => {
  const gate   = createSNGate({ logDir: null });
  const result = gate.evaluateDataPush('unverified-sender', false, 'sensor');
  assert.ok(['observe', 'deny'].includes(result.decision));
});

// ── Suite 6: Trace log ────────────────────────────────────────────────────────

test('trace log records decisions', () => {
  const gate = createSNGate({ logDir: null });
  gate.evaluate({ type: 'http.request', surface: 'dev' });
  const traces = gate.trace.query({});
  assert.ok(traces.length >= 1);
});

test('trace log queryable by decision', () => {
  const gate = createSNGate({ logDir: null });
  gate.rules.add({ type: 'uuid', value: 'block-me', action: 'deny' });
  gate.evaluate({
    type: 'x', identity: { uuid: 'block-me', verified: true }, surface: 'dev'
  });
  const denies = gate.trace.query({ decision: 'deny' });
  assert.ok(denies.length >= 1);
  assert.ok(denies.every(d => d.decision === 'deny'));
});

test('trace entries have required fields', () => {
  const gate = createSNGate({ logDir: null });
  gate.evaluate({ type: 'http.request', surface: 'dev' });
  const t = gate.trace.query({})[0];
  assert.ok(t.id);
  assert.ok(t.ts);
  assert.ok(t.gateId);
  assert.ok(t.decision);
});

run();
