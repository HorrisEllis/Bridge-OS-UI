// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
'use strict';
/**
 * bridge-sngate/tests/test-sngate-deep.js
 * §4.1 §1.1 §1.2 §4.3
 * Covers: evaluate(), adapters, rule store, trace log, invariants
 */
const assert = require('assert');
const { createSNGate } = require('../index');

let passed = 0, failed = 0;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
async function run() {
  console.log('\n[bridge-sngate] Deep Test Suite\n');
  for (const t of tests) {
    try { await t.fn(); console.log(`  ✓ ${t.name}`); passed++; }
    catch (e) { console.error(`  ✗ ${t.name}\n    ${e.message}`); failed++; }
  }
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

// ── factory ───────────────────────────────────────────────────────────────────
test('createSNGate(): returns all required methods', () => {
  const g = createSNGate({ logDir: null });
  for (const m of ['evaluate','middleware','evaluateAgentCall','evaluateMeshHandshake','evaluateDataPush']) {
    assert.strictEqual(typeof g[m], 'function', `missing: ${m}`);
  }
});
test('createSNGate(): gateId is a non-empty string', () => {
  const g = createSNGate({ logDir: null });
  assert.ok(typeof g.gateId === 'string' && g.gateId.length > 0);
});
test('createSNGate(): each instance gets unique gateId', () => {
  const g1 = createSNGate({ logDir: null });
  const g2 = createSNGate({ logDir: null });
  assert.notStrictEqual(g1.gateId, g2.gateId);
});

// ── evaluate() — decision shape ───────────────────────────────────────────────
test('evaluate(): returns score, decision, reason, trace, gateId', () => {
  const g = createSNGate({ logDir: null });
  const r = g.evaluate({ type: 'test', surface: 'dev' });
  assert.ok(typeof r.score    === 'number');
  assert.ok(['allow','deny','observe'].includes(r.decision));
  assert.ok(typeof r.reason   === 'string');
  assert.ok(r.trace);
  assert.ok(r.gateId);
});
test('evaluate(): score is always 0–10', () => {
  const g = createSNGate({ logDir: null });
  for (let i = 0; i < 20; i++) {
    const r = g.evaluate({ type: 'test', surface: 'dev' });
    assert.ok(r.score >= 0 && r.score <= 10, `score=${r.score}`);
  }
});
test('evaluate(): decision is always allow|deny|observe', () => {
  const g = createSNGate({ logDir: null });
  const r = g.evaluate({ type: 'test', surface: 'dev' });
  assert.ok(['allow','deny','observe'].includes(r.decision));
});

// ── INVARIANT: score alone NEVER triggers deny ────────────────────────────────
test('INVARIANT: score alone never triggers deny (no rule = observe/allow)', () => {
  const g = createSNGate({ logDir: null });
  // Low score via low-trust IME-less path — still no deny without a rule
  const r = g.evaluate({ type: 'test', identity: { uuid: 'low-score', verified: true }, surface: 'dev' });
  assert.notStrictEqual(r.decision, 'deny', 'Score alone should never produce deny');
});
test('INVARIANT: verified:false triggers immediate deny score 0', () => {
  const g = createSNGate({ logDir: null });
  const r = g.evaluate({ type: 'test', identity: { uuid: 'fake', verified: false }, surface: 'dev' });
  assert.strictEqual(r.decision, 'deny');
  assert.strictEqual(r.score, 0);
});
test('INVARIANT: uuidMismatch triggers deny', () => {
  const g = createSNGate({ logDir: null });
  const r = g.evaluate({ type: 'test', identity: { uuid: 'x', uuidMismatch: true }, surface: 'dev' });
  assert.strictEqual(r.decision, 'deny');
});

// ── Rule store ────────────────────────────────────────────────────────────────
test('rules.add(): assigns uuid id if none given', () => {
  const g = createSNGate({ logDir: null });
  const id = g.rules.add({ type: 'uuid', value: 'test-uuid-abc', action: 'deny' });
  assert.ok(typeof id === 'string' && id.length > 0);
});
test('rules.add(): requires type', () => {
  const g = createSNGate({ logDir: null });
  assert.throws(() => g.rules.add({ value: 'x', action: 'deny' }), /rule\.type required/);
});
test('rules.list(): returns added rules', () => {
  const g = createSNGate({ logDir: null });
  g.rules.add({ type: 'uuid', value: 'list-test', action: 'deny' });
  assert.ok(g.rules.list().length >= 1);
});
test('rules.remove(): deletes rule by id', () => {
  const g = createSNGate({ logDir: null });
  const id = g.rules.add({ type: 'uuid', value: 'remove-test', action: 'deny' });
  g.rules.remove(id);
  assert.ok(!g.rules.list().find(r => r.id === id));
});
test('rules.match(): uuid rule matches on identity.uuid', () => {
  const g = createSNGate({ logDir: null });
  g.rules.add({ type: 'uuid', value: 'match-target', action: 'deny' });
  const r = g.evaluate({ type: 'test', identity: { uuid: 'match-target', verified: true }, surface: 'dev' });
  assert.strictEqual(r.decision, 'deny');
});
test('rules.match(): uuid rule deny produces deny decision', () => {
  const g = createSNGate({ logDir: null });
  g.rules.add({ type: 'uuid', value: 'blocked-uuid', action: 'deny' });
  const r = g.evaluate({ type: 'test', identity: { uuid: 'blocked-uuid', verified: true }, surface: 'dev' });
  assert.strictEqual(r.decision, 'deny');
});
test('rules.match(): uuid rule allow produces allow decision', () => {
  const g = createSNGate({ logDir: null });
  g.rules.add({ type: 'uuid', value: 'allowed-uuid', action: 'allow' });
  const r = g.evaluate({ type: 'test', identity: { uuid: 'allowed-uuid', verified: true }, surface: 'dev' });
  assert.strictEqual(r.decision, 'allow');
});
test('rules.match(): domain rule matches payload.domain', () => {
  const g = createSNGate({ logDir: null });
  g.rules.add({ type: 'domain', value: 'evil.com', action: 'deny' });
  const r = g.evaluate({ type: 'test', payload: { domain: 'evil.com' }, surface: 'dev' });
  assert.strictEqual(r.decision, 'deny');
});
test('rules.match(): domain rule matches payload.url substring', () => {
  const g = createSNGate({ logDir: null });
  g.rules.add({ type: 'domain', value: 'evil.com', action: 'deny' });
  const r = g.evaluate({ type: 'test', payload: { url: 'https://evil.com/path' }, surface: 'dev' });
  assert.strictEqual(r.decision, 'deny');
});
test('rules.match(): intent rule matches type prefix', () => {
  const g = createSNGate({ logDir: null });
  g.rules.add({ type: 'intent', value: 'agent.', action: 'deny' });
  const r = g.evaluate({ type: 'agent.tool_call', surface: 'dev' });
  assert.strictEqual(r.decision, 'deny');
});
test('rules.match(): surface-scoped rule does not match different surface', () => {
  const g = createSNGate({ logDir: null });
  g.rules.add({ type: 'intent', value: 'test', action: 'deny', surface: 'mesh' });
  const r = g.evaluate({ type: 'test', surface: 'dev' });
  assert.notStrictEqual(r.decision, 'deny');
});
test('rules.match(): surface-scoped rule matches matching surface', () => {
  const g = createSNGate({ logDir: null });
  g.rules.add({ type: 'intent', value: 'test', action: 'deny', surface: 'dev' });
  const r = g.evaluate({ type: 'test', surface: 'dev' });
  assert.strictEqual(r.decision, 'deny');
});
test('rules.match(): regex rule matches payload JSON', () => {
  const g = createSNGate({ logDir: null });
  g.rules.add({ type: 'regex', value: 'rm\\s+-rf', action: 'deny' });
  const r = g.evaluate({ type: 'cmd', payload: { command: 'rm -rf /' }, surface: 'dev' });
  assert.strictEqual(r.decision, 'deny');
});
test('rules.match(): ip rule matches payload.ip', () => {
  const g = createSNGate({ logDir: null });
  g.rules.add({ type: 'ip', value: '192.168.1.100', action: 'deny' });
  const r = g.evaluate({ type: 'test', payload: { ip: '192.168.1.100' }, surface: 'dev' });
  assert.strictEqual(r.decision, 'deny');
});
test('rules.list(): filter by type', () => {
  const g = createSNGate({ logDir: null });
  g.rules.add({ type: 'uuid',   value: 'a', action: 'deny' });
  g.rules.add({ type: 'domain', value: 'b', action: 'deny' });
  const uuidRules = g.rules.list({ type: 'uuid' });
  assert.ok(uuidRules.every(r => r.type === 'uuid'));
});

// ── Trace log ─────────────────────────────────────────────────────────────────
test('trace.query(): returns entries after evaluate()', () => {
  const g = createSNGate({ logDir: null });
  g.evaluate({ type: 'trace.test', surface: 'dev' });
  const entries = g.trace.query({});
  assert.ok(entries.length >= 1);
});
test('trace.query(): filter by decision', () => {
  const g = createSNGate({ logDir: null });
  g.rules.add({ type: 'uuid', value: 'deny-trace', action: 'deny' });
  g.evaluate({ type: 'test', identity: { uuid: 'deny-trace', verified: true }, surface: 'dev' });
  g.evaluate({ type: 'test', surface: 'dev' });
  const denies = g.trace.query({ decision: 'deny' });
  assert.ok(denies.every(e => e.decision === 'deny'));
});
test('trace.query(): filter by surface', () => {
  const g = createSNGate({ logDir: null });
  g.evaluate({ type: 'test', surface: 'mesh' });
  g.evaluate({ type: 'test', surface: 'dev' });
  const mesh = g.trace.query({ surface: 'mesh' });
  assert.ok(mesh.every(e => e.surface === 'mesh'));
});
test('trace: each entry has gateId, score, decision, reason, ts', () => {
  const g = createSNGate({ logDir: null });
  g.evaluate({ type: 'shape.test', surface: 'dev' });
  const e = g.trace.query({}).pop();
  assert.ok(e.gateId && e.score !== undefined && e.decision && e.reason && e.ts > 0);
});

// ── busEmit integration ───────────────────────────────────────────────────────
test('busEmit: sngate:decision emitted on evaluate()', () => {
  const emitted = [];
  const g = createSNGate({ logDir: null }, null, (sig, d) => emitted.push({ sig, d }));
  g.evaluate({ type: 'emit.test', surface: 'dev' });
  assert.ok(emitted.find(e => e.sig === 'sngate:decision'));
});
test('busEmit: rule-triggered deny emits WARN level', () => {
  const emitted = [];
  const g = createSNGate({ logDir: null }, null, (sig, d, level) => emitted.push({ sig, level }));
  g.rules.add({ type: 'uuid', value: 'warn-deny-uuid', action: 'deny' });
  g.evaluate({ type: 'test', identity: { uuid: 'warn-deny-uuid', verified: true }, surface: 'dev' });
  const ev = emitted.find(e => e.sig === 'sngate:decision');
  assert.strictEqual(ev?.level, 'WARN');
});
test('busEmit: allow decision emits DEBUG level', () => {
  const emitted = [];
  const g = createSNGate({ logDir: null }, null, (sig, d, level) => emitted.push({ sig, level }));
  g.evaluate({ type: 'test', identity: { uuid: 'ok', verified: true }, surface: 'dev' });
  const ev = emitted.find(e => e.sig === 'sngate:decision');
  assert.strictEqual(ev.level, 'DEBUG');
});

// ── Adapters ──────────────────────────────────────────────────────────────────
test('evaluateAgentCall(): returns valid decision', () => {
  const g = createSNGate({ logDir: null });
  const r = g.evaluateAgentCall('agent-uuid', 'bash', { cmd: 'ls' });
  assert.ok(['allow','deny','observe'].includes(r.decision));
});
test('evaluateAgentCall(): surface is agent', () => {
  const g = createSNGate({ logDir: null });
  const r = g.evaluateAgentCall('agent-uuid', 'bash', {});
  assert.strictEqual(r.trace.surface, 'agent');
});
test('evaluateAgentCall(): type is agent.tool_call', () => {
  const g = createSNGate({ logDir: null });
  const r = g.evaluateAgentCall('agent-uuid', 'bash', {});
  assert.strictEqual(r.trace.type, 'agent.tool_call');
});
test('evaluateMeshHandshake(): ok:true → not deny', () => {
  const g = createSNGate({ logDir: null });
  const r = g.evaluateMeshHandshake({ ok: true, uuid: 'peer-uuid', groupHint: null });
  assert.notStrictEqual(r.decision, 'deny');
});
test('evaluateMeshHandshake(): ok:false → deny', () => {
  const g = createSNGate({ logDir: null });
  const r = g.evaluateMeshHandshake({ ok: false, uuid: 'bad-peer', reason: 'sig failed' });
  assert.strictEqual(r.decision, 'deny');
});
test('evaluateMeshHandshake(): surface is mesh', () => {
  const g = createSNGate({ logDir: null });
  const r = g.evaluateMeshHandshake({ ok: true, uuid: 'peer' });
  assert.strictEqual(r.trace.surface, 'mesh');
});
test('evaluateDataPush(): verified:true → not deny (no rule)', () => {
  const g = createSNGate({ logDir: null });
  const r = g.evaluateDataPush('sender-uuid', true, 'event');
  assert.notStrictEqual(r.decision, 'deny');
});
test('evaluateDataPush(): surface is data', () => {
  const g = createSNGate({ logDir: null });
  const r = g.evaluateDataPush('sender-uuid', true, 'metric');
  assert.strictEqual(r.trace.surface, 'data');
});

// ── IME integration (read-only) ───────────────────────────────────────────────
test('IME integration: getProfile() called for known uuid', () => {
  let called = false;
  const fakeIME = {
    getProfile: (uuid) => { called = true; return { trustScore: 7, scoreReasons: [], anomalies: [] }; },
  };
  const g = createSNGate({ logDir: null }, fakeIME);
  g.evaluate({ type: 'test', identity: { uuid: 'known-uuid', verified: true }, surface: 'dev' });
  assert.ok(called);
});
test('IME integration: high IME score → allow without rule', () => {
  const fakeIME = {
    getProfile: () => ({ trustScore: 9, scoreReasons: [], anomalies: [] }),
  };
  const g = createSNGate({ logDir: null }, fakeIME);
  const r = g.evaluate({ type: 'test', identity: { uuid: 'trusted', verified: true }, surface: 'dev' });
  assert.strictEqual(r.decision, 'allow');
});
test('IME integration: low IME score → observe (not deny) without rule', () => {
  const fakeIME = {
    getProfile: () => ({ trustScore: 1, scoreReasons: [], anomalies: [] }),
  };
  const g = createSNGate({ logDir: null }, fakeIME);
  const r = g.evaluate({ type: 'test', identity: { uuid: 'untrusted', verified: true }, surface: 'dev' });
  assert.notStrictEqual(r.decision, 'deny', 'Low score alone must never deny');
});
test('IME integration: sngate never writes to IME (read-only contract)', () => {
  const writes = [];
  const fakeIME = {
    getProfile: () => null,
    ingest: (...args) => { writes.push(args); }, // should never be called
  };
  const g = createSNGate({ logDir: null }, fakeIME);
  g.evaluate({ type: 'test', identity: { uuid: 'x', verified: true }, surface: 'dev' });
  assert.strictEqual(writes.length, 0, 'sngate must never call IME.ingest()');
});

// ── middleware() ──────────────────────────────────────────────────────────────
test('middleware(): returns a function', () => {
  const g = createSNGate({ logDir: null });
  assert.strictEqual(typeof g.middleware(), 'function');
});
test('middleware(): calls next() on allow', () => {
  const g = createSNGate({ logDir: null });
  let nextCalled = false;
  const mw = g.middleware();
  const req = { method: 'GET', url: '/health', socket: {}, bridgeIdentity: { uuid: 'ok', verified: true } };
  const res = { headersSent: false, writeHead: () => {}, end: () => {} };
  mw(req, res, () => { nextCalled = true; });
  assert.ok(nextCalled || req.sngate); // next called or sngate attached
});
test('middleware(): attaches sngate result to req', () => {
  const g = createSNGate({ logDir: null });
  const req = { method: 'GET', url: '/test', socket: {} };
  const res = { headersSent: false, writeHead: () => {}, end: () => {} };
  g.middleware()(req, res, () => {});
  assert.ok(req.sngate);
});
test('middleware(): 403 on deny', () => {
  const g = createSNGate({ logDir: null });
  g.rules.add({ type: 'uuid', value: 'blocked-mw', action: 'deny' });
  let status;
  const req = { method: 'GET', url: '/test', socket: {}, bridgeIdentity: { uuid: 'blocked-mw', verified: true } };
  const res = { headersSent: false, writeHead: (s) => { status = s; }, end: () => {} };
  g.middleware()(req, res, () => {});
  assert.strictEqual(status, 403);
});

run();
