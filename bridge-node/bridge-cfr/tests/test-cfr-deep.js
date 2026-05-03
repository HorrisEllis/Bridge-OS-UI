// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
'use strict';
/**
 * bridge-cfr/tests/test-cfr-deep.js
 * Deep test suite — CFR Constraint Field Runtime module
 * Tests real route() behaviour, field state, node registry, delta ring,
 * delta classification, and simulation handlers.
 * §4.1 §1.2 §1.1
 */

const assert = require('assert');
const cfr    = require('../index');

// Reset installed state between re-require calls isn't possible without
// full module cache clearing — so we test the exported functions directly
// as a stateful module after a synthetic install.

let passed = 0, failed = 0;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
async function run() {
  console.log('\n[bridge-cfr] Deep Test Suite\n');
  for (const t of tests) {
    try { await t.fn(); console.log(`  ✓ ${t.name}`); passed++; }
    catch (e) { console.error(`  ✗ ${t.name}\n    ${e.message}`); failed++; }
  }
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

// ── Synthetic context for install() ──────────────────────────────────────────

function makeBus() {
  const listeners = new Map();
  const wildcard  = [];
  const emitted   = [];
  return {
    emitted,
    on(sig, fn)  {
      if (!listeners.has(sig)) listeners.set(sig, []);
      listeners.get(sig).push(fn);
    },
    emit(sig, data) {
      emitted.push({ sig, data });
      (listeners.get(sig) || []).forEach(fn => { try { fn(data); } catch {} });
      wildcard.forEach(fn => { try { fn(sig, data); } catch {} });
    },
    onAny: null, // force fallback path
  };
}

function makeCtx(overrides = {}) {
  const bus = makeBus();
  return {
    bus,
    busEmit: (sig, data, level) => bus.emit(sig, data),
    identity: { uuid: 'test-node-uuid-1234' },
    nodeRegistry: { list: () => [] },
    trustMesh: null,
    causal: null,
    gate: null,
    ime: null,
    wsGateway: null,
    ...overrides,
  };
}

// Install once for all tests
const ctx = makeCtx();
cfr.install(ctx);

// ── Module identity ───────────────────────────────────────────────────────────

test('MODULE_UUID is a non-empty string', () => {
  assert.ok(typeof cfr.MODULE_UUID === 'string' && cfr.MODULE_UUID.length > 0);
});
test('MODULE_VERSION is semver-like', () => {
  assert.match(cfr.MODULE_VERSION, /^\d+\.\d+\.\d+$/);
});

// ── diagnostics() ─────────────────────────────────────────────────────────────

test('diagnostics(): returns installed:true after install()', () => {
  const d = cfr.diagnostics();
  assert.ok(d.installed);
});
test('diagnostics(): uuid matches MODULE_UUID', () => {
  const d = cfr.diagnostics();
  assert.strictEqual(d.uuid, cfr.MODULE_UUID);
});
test('diagnostics(): version matches MODULE_VERSION', () => {
  const d = cfr.diagnostics();
  assert.strictEqual(d.version, cfr.MODULE_VERSION);
});
test('diagnostics(): nodes is a non-negative number', () => {
  const d = cfr.diagnostics();
  assert.ok(typeof d.nodes === 'number' && d.nodes >= 0);
});
test('diagnostics(): deltas is a non-negative number', () => {
  const d = cfr.diagnostics();
  assert.ok(typeof d.deltas === 'number' && d.deltas >= 0);
});
test('diagnostics(): field has structure, entropy, attention, damping, curl, speed', () => {
  const f = cfr.diagnostics().field;
  const keys = ['structure', 'entropy', 'attention', 'damping', 'curl', 'speed'];
  for (const k of keys) {
    assert.ok(typeof f[k] === 'number', `field.${k} must be a number`);
  }
});

// ── install() side-effects ────────────────────────────────────────────────────

test('install(): registers sovereign-node identity as canvas node', () => {
  const r = cfr.route('GET', ['cfr', 'nodes'], {}, {}, {});
  assert.ok(r.ok);
  const selfNode = r.nodes.find(n => n.label === 'sovereign-node' || n.type === 'foundation');
  assert.ok(selfNode, 'Sovereign node should be in canvas nodes');
});
test('install(): emits cfr:module:ready delta on boot', () => {
  const r = cfr.route('GET', ['cfr', 'deltas'], {}, { url: '/cfr/deltas?limit=500' }, {});
  assert.ok(r.ok);
  const ready = r.deltas.find(d => d.type === 'cfr:module:ready');
  assert.ok(ready, 'cfr:module:ready delta should exist');
});
test('install(): cfr:module:ready delta has cls=ok', () => {
  const r = cfr.route('GET', ['cfr', 'deltas'], {}, { url: '/cfr/deltas?limit=500' }, {});
  const ready = r.deltas.find(d => d.type === 'cfr:module:ready');
  assert.strictEqual(ready.cls, 'ok');
});

// ── GET /cfr/health ───────────────────────────────────────────────────────────

test('route GET /cfr/health: ok:true', () => {
  const r = cfr.route('GET', ['cfr', 'health'], {}, {}, {});
  assert.ok(r.ok);
});
test('route GET /cfr/health: installed:true', () => {
  const r = cfr.route('GET', ['cfr', 'health'], {}, {}, {});
  assert.ok(r.installed);
});
test('route GET /cfr/health: module UUID present', () => {
  const r = cfr.route('GET', ['cfr', 'health'], {}, {}, {});
  assert.strictEqual(r.module, cfr.MODULE_UUID);
});
test('route GET /cfr/health: nodes count is non-negative', () => {
  const r = cfr.route('GET', ['cfr', 'health'], {}, {}, {});
  assert.ok(typeof r.nodes === 'number' && r.nodes >= 0);
});
test('route GET /cfr/health: deltas count is non-negative', () => {
  const r = cfr.route('GET', ['cfr', 'health'], {}, {}, {});
  assert.ok(typeof r.deltas === 'number' && r.deltas >= 0);
});
test('route GET /cfr/health: field object present with keys', () => {
  const r = cfr.route('GET', ['cfr', 'health'], {}, {}, {});
  assert.ok(r.field && typeof r.field.structure === 'number');
});

// ── GET /cfr/nodes ────────────────────────────────────────────────────────────

test('route GET /cfr/nodes: ok:true', () => {
  const r = cfr.route('GET', ['cfr', 'nodes'], {}, {}, {});
  assert.ok(r.ok);
});
test('route GET /cfr/nodes: nodes is array', () => {
  const r = cfr.route('GET', ['cfr', 'nodes'], {}, {}, {});
  assert.ok(Array.isArray(r.nodes));
});
test('route GET /cfr/nodes: count matches nodes.length', () => {
  const r = cfr.route('GET', ['cfr', 'nodes'], {}, {}, {});
  assert.strictEqual(r.count, r.nodes.length);
});
test('route GET /cfr/nodes: each node has id, label, type, updatedAt', () => {
  cfr.upsertNode('test-node-a', { label: 'TestA', type: 'bridge' });
  const r = cfr.route('GET', ['cfr', 'nodes'], {}, {}, {});
  const n = r.nodes.find(n => n.id === 'test-node-a');
  assert.ok(n, 'test-node-a should be in nodes');
  assert.ok(n.id && n.label && n.type && n.updatedAt);
});

// ── POST /cfr/node ────────────────────────────────────────────────────────────

test('route POST /cfr/node: requires id', () => {
  const r = cfr.route('POST', ['cfr', 'node'], { label: 'X' }, {}, {});
  assert.ok(!r.ok);
  assert.match(r.error, /id required/);
});
test('route POST /cfr/node: creates node', () => {
  const r = cfr.route('POST', ['cfr', 'node'], { id: 'post-node-1', label: 'PostNode', type: 'vault' }, {}, {});
  assert.ok(r.ok);
  assert.ok(r.node.id === 'post-node-1');
});
test('route POST /cfr/node: node appears in /cfr/nodes', () => {
  cfr.route('POST', ['cfr', 'node'], { id: 'post-node-2', label: 'Verify', type: 'canvas' }, {}, {});
  const r = cfr.route('GET', ['cfr', 'nodes'], {}, {}, {});
  assert.ok(r.nodes.find(n => n.id === 'post-node-2'));
});
test('route POST /cfr/node: updates existing node', () => {
  cfr.route('POST', ['cfr', 'node'], { id: 'update-node', label: 'Original', type: 'default' }, {}, {});
  cfr.route('POST', ['cfr', 'node'], { id: 'update-node', label: 'Updated', type: 'vault' }, {}, {});
  const r = cfr.route('GET', ['cfr', 'nodes'], {}, {}, {});
  const n = r.nodes.find(n => n.id === 'update-node');
  assert.strictEqual(n.label, 'Updated');
});

// ── GET /cfr/deltas ───────────────────────────────────────────────────────────

test('route GET /cfr/deltas: ok:true', () => {
  const r = cfr.route('GET', ['cfr', 'deltas'], {}, { url: '/cfr/deltas' }, {});
  assert.ok(r.ok);
});
test('route GET /cfr/deltas: deltas is array', () => {
  const r = cfr.route('GET', ['cfr', 'deltas'], {}, { url: '/cfr/deltas' }, {});
  assert.ok(Array.isArray(r.deltas));
});
test('route GET /cfr/deltas: total is number', () => {
  const r = cfr.route('GET', ['cfr', 'deltas'], {}, { url: '/cfr/deltas' }, {});
  assert.ok(typeof r.total === 'number');
});
test('route GET /cfr/deltas: each delta has id, ts, type, cls, msg', () => {
  const r = cfr.route('GET', ['cfr', 'deltas'], {}, { url: '/cfr/deltas?limit=50' }, {});
  for (const d of r.deltas) {
    assert.ok(d.id,  `delta missing id`);
    assert.ok(d.ts,  `delta missing ts`);
    assert.ok(d.type, `delta missing type`);
    assert.ok(['ok','warn','err','cfr'].includes(d.cls), `delta.cls invalid: ${d.cls}`);
  }
});
test('route GET /cfr/deltas: limit query param respected', () => {
  // Emit some events to ensure we have deltas
  for (let i = 0; i < 10; i++) {
    cfr.route('POST', ['cfr', 'emit'], { sig: `test:delta:${i}`, data: {}, level: 'INFO' }, {}, {});
  }
  const r = cfr.route('GET', ['cfr', 'deltas'], {}, { url: '/cfr/deltas?limit=3' }, {});
  assert.ok(r.deltas.length <= 3);
});

// ── GET /cfr/field ────────────────────────────────────────────────────────────

test('route GET /cfr/field: ok:true', () => {
  const r = cfr.route('GET', ['cfr', 'field'], {}, {}, {});
  assert.ok(r.ok);
});
test('route GET /cfr/field: field values are in 0–1 range', () => {
  const f = cfr.route('GET', ['cfr', 'field'], {}, {}, {}).field;
  for (const k of ['structure', 'entropy', 'attention', 'damping', 'curl', 'speed']) {
    assert.ok(f[k] >= 0 && f[k] <= 1, `field.${k}=${f[k]} out of range`);
  }
});
test('route GET /cfr/field: snrConfig is present', () => {
  const f = cfr.route('GET', ['cfr', 'field'], {}, {}, {}).field;
  assert.ok(f.snrConfig && typeof f.snrConfig.threshold === 'number');
});

// ── POST /cfr/field ───────────────────────────────────────────────────────────

test('route POST /cfr/field: updates structure', () => {
  cfr.route('POST', ['cfr', 'field'], { structure: 0.75 }, {}, {});
  const f = cfr.route('GET', ['cfr', 'field'], {}, {}, {}).field;
  assert.ok(Math.abs(f.structure - 0.75) < 0.001);
});
test('route POST /cfr/field: clamps values to 0–1', () => {
  cfr.route('POST', ['cfr', 'field'], { entropy: 5.0, attention: -2.0 }, {}, {});
  const f = cfr.route('GET', ['cfr', 'field'], {}, {}, {}).field;
  assert.strictEqual(f.entropy, 1.0);
  assert.strictEqual(f.attention, 0.0);
});
test('route POST /cfr/field: ignores unknown keys', () => {
  const before = cfr.route('GET', ['cfr', 'field'], {}, {}, {}).field.structure;
  cfr.route('POST', ['cfr', 'field'], { randomKey: 0.99 }, {}, {});
  const after = cfr.route('GET', ['cfr', 'field'], {}, {}, {}).field.structure;
  assert.strictEqual(before, after);
});
test('route POST /cfr/field: empty body returns ok with unchanged field', () => {
  const r = cfr.route('POST', ['cfr', 'field'], {}, {}, {});
  assert.ok(r.ok);
  assert.ok(r.field);
});

// ── GET /cfr/state ────────────────────────────────────────────────────────────

test('route GET /cfr/state: ok:true', () => {
  const r = cfr.route('GET', ['cfr', 'state'], {}, {}, {});
  assert.ok(r.ok);
});
test('route GET /cfr/state: state.schema is 1', () => {
  const s = cfr.route('GET', ['cfr', 'state'], {}, {}, {}).state;
  assert.strictEqual(s.schema, 1);
});
test('route GET /cfr/state: state.field present', () => {
  const s = cfr.route('GET', ['cfr', 'state'], {}, {}, {}).state;
  assert.ok(s.field && typeof s.field.structure === 'number');
});
test('route GET /cfr/state: state.nodes is array', () => {
  const s = cfr.route('GET', ['cfr', 'state'], {}, {}, {}).state;
  assert.ok(Array.isArray(s.nodes));
});
test('route GET /cfr/state: state.nodeId present', () => {
  const s = cfr.route('GET', ['cfr', 'state'], {}, {}, {}).state;
  assert.ok(typeof s.nodeId === 'string' || s.nodeId === null);
});
test('route GET /cfr/state: state.uptime is positive number', () => {
  const s = cfr.route('GET', ['cfr', 'state'], {}, {}, {}).state;
  assert.ok(typeof s.uptime === 'number' && s.uptime >= 0);
});

// ── POST /cfr/emit ────────────────────────────────────────────────────────────

test('route POST /cfr/emit: ok:true for valid sig', () => {
  const r = cfr.route('POST', ['cfr', 'emit'], { sig: 'test:emit', data: { x: 1 }, level: 'INFO' }, {}, {});
  assert.ok(r.ok);
});
test('route POST /cfr/emit: returns ts', () => {
  const r = cfr.route('POST', ['cfr', 'emit'], { sig: 'test:emit:ts', data: {}, level: 'INFO' }, {}, {});
  assert.ok(typeof r.ts === 'number' && r.ts > 0);
});
test('route POST /cfr/emit: sig missing → ok:false', () => {
  const r = cfr.route('POST', ['cfr', 'emit'], { data: {} }, {}, {});
  assert.ok(!r.ok);
  assert.match(r.error, /sig required/);
});
test('route POST /cfr/emit: emitted event appears in deltas', () => {
  const sig = `emit:delta:verify:${Date.now()}`;
  cfr.route('POST', ['cfr', 'emit'], { sig, data: {}, level: 'INFO' }, {}, {});
  const r = cfr.route('GET', ['cfr', 'deltas'], {}, { url: '/cfr/deltas?limit=500' }, {});
  assert.ok(r.deltas.find(d => d.type === sig), 'Emitted sig should appear in deltas');
});

// ── POST /cfr/simulate ────────────────────────────────────────────────────────

test('route POST /cfr/simulate route: ok:true with 2 nodes', () => {
  cfr.upsertNode('sim-from', { label: 'From', type: 'bridge' });
  cfr.upsertNode('sim-to',   { label: 'To',   type: 'vault'  });
  const r = cfr.route('POST', ['cfr', 'simulate'], { type: 'route', fromId: 'sim-from', toId: 'sim-to', intensity: 5 }, {}, {});
  assert.ok(r.ok, JSON.stringify(r));
});
test('route POST /cfr/simulate route: requires fromId and toId', () => {
  const r = cfr.route('POST', ['cfr', 'simulate'], { type: 'route' }, {}, {});
  assert.ok(!r.ok);
  assert.match(r.error, /fromId and toId required/);
});
test('route POST /cfr/simulate failure: ok:true with fromId', () => {
  cfr.upsertNode('sim-fail', { label: 'FailNode', type: 'canvas' });
  const r = cfr.route('POST', ['cfr', 'simulate'], { type: 'failure', fromId: 'sim-fail' }, {}, {});
  assert.ok(r.ok);
});
test('route POST /cfr/simulate failure: requires fromId', () => {
  const r = cfr.route('POST', ['cfr', 'simulate'], { type: 'failure' }, {}, {});
  assert.ok(!r.ok);
});
test('route POST /cfr/simulate heal: ok:true', () => {
  cfr.upsertNode('sim-heal', { label: 'HealNode', type: 'canvas' });
  const r = cfr.route('POST', ['cfr', 'simulate'], { type: 'heal', fromId: 'sim-heal' }, {}, {});
  assert.ok(r.ok);
});
test('route POST /cfr/simulate snr_block: ok:true', () => {
  const r = cfr.route('POST', ['cfr', 'simulate'], { type: 'snr_block' }, {}, {});
  assert.ok(r.ok);
});
test('route POST /cfr/simulate broadcast: ok:true', () => {
  cfr.upsertNode('sim-broadcast', { label: 'BroadcastNode', type: 'bridge' });
  const r = cfr.route('POST', ['cfr', 'simulate'], { type: 'broadcast', fromId: 'sim-broadcast' }, {}, {});
  assert.ok(r.ok);
});
test('route POST /cfr/simulate unknown type: ok:false', () => {
  const r = cfr.route('POST', ['cfr', 'simulate'], { type: 'invalid_type_xyz' }, {}, {});
  assert.ok(!r.ok);
});

// ── upsertNode() ──────────────────────────────────────────────────────────────

test('upsertNode(): creates node accessible via /cfr/nodes', () => {
  cfr.upsertNode('upsert-test-1', { label: 'UpsertOne', type: 'guardian' });
  const r = cfr.route('GET', ['cfr', 'nodes'], {}, {}, {});
  assert.ok(r.nodes.find(n => n.id === 'upsert-test-1'));
});
test('upsertNode(): updates label on second call', () => {
  cfr.upsertNode('upsert-update', { label: 'First', type: 'bridge' });
  cfr.upsertNode('upsert-update', { label: 'Second', type: 'bridge' });
  const r = cfr.route('GET', ['cfr', 'nodes'], {}, {}, {});
  const n = r.nodes.find(n => n.id === 'upsert-update');
  assert.strictEqual(n.label, 'Second');
});
test('upsertNode(): null id is safe no-op', () => {
  assert.doesNotThrow(() => cfr.upsertNode(null, { label: 'X' }));
});
test('upsertNode(): undefined id is safe no-op', () => {
  assert.doesNotThrow(() => cfr.upsertNode(undefined, { label: 'X' }));
});
test('upsertNode(): node gets updatedAt timestamp', () => {
  cfr.upsertNode('upsert-ts', { label: 'TSNode', type: 'canvas' });
  const r = cfr.route('GET', ['cfr', 'nodes'], {}, {}, {});
  const n = r.nodes.find(n => n.id === 'upsert-ts');
  assert.ok(n.updatedAt > 0);
});

// ── Delta classification ──────────────────────────────────────────────────────

test('delta classification: bridge:boot → ok', () => {
  cfr.route('POST', ['cfr', 'emit'], { sig: 'bridge:boot', data: {}, level: 'INFO' }, {}, {});
  const r = cfr.route('GET', ['cfr', 'deltas'], {}, { url: '/cfr/deltas?limit=200' }, {});
  const d = r.deltas.find(d => d.type === 'bridge:boot');
  assert.strictEqual(d?.cls, 'ok');
});
test('delta classification: node:dead → err', () => {
  cfr.route('POST', ['cfr', 'emit'], { sig: 'node:dead', data: {}, level: 'WARN' }, {}, {});
  const r = cfr.route('GET', ['cfr', 'deltas'], {}, { url: '/cfr/deltas?limit=200' }, {});
  const d = r.deltas.find(d => d.type === 'node:dead');
  assert.strictEqual(d?.cls, 'err');
});
test('delta classification: bridge:shutdown → warn', () => {
  cfr.route('POST', ['cfr', 'emit'], { sig: 'bridge:shutdown', data: {}, level: 'WARN' }, {}, {});
  const r = cfr.route('GET', ['cfr', 'deltas'], {}, { url: '/cfr/deltas?limit=200' }, {});
  const d = r.deltas.find(d => d.type === 'bridge:shutdown');
  assert.strictEqual(d?.cls, 'warn');
});
test('delta classification: causal:kernel:ready → cfr', () => {
  cfr.route('POST', ['cfr', 'emit'], { sig: 'causal:kernel:ready', data: {}, level: 'INFO' }, {}, {});
  const r = cfr.route('GET', ['cfr', 'deltas'], {}, { url: '/cfr/deltas?limit=200' }, {});
  const d = r.deltas.find(d => d.type === 'causal:kernel:ready');
  assert.strictEqual(d?.cls, 'cfr');
});
test('delta classification: unknown sig with "error" in name → err', () => {
  cfr.route('POST', ['cfr', 'emit'], { sig: 'custom:error:event', data: {}, level: 'ERROR' }, {}, {});
  const r = cfr.route('GET', ['cfr', 'deltas'], {}, { url: '/cfr/deltas?limit=200' }, {});
  const d = r.deltas.find(d => d.type === 'custom:error:event');
  assert.strictEqual(d?.cls, 'err');
});

// ── Unhandled routes ──────────────────────────────────────────────────────────

test('route: unknown sub returns null (let boot handle 404)', () => {
  const r = cfr.route('GET', ['cfr', 'nonexistent'], {}, {}, {});
  assert.strictEqual(r, null);
});
test('route: wrong top-level with non-matching sub returns null', () => {
  // CFR route() matches on sub (urlParts[1]), not top-level — this is the actual contract
  const r = cfr.route('GET', ['canvas', 'nonexistent-sub-xyz'], {}, {}, {});
  assert.strictEqual(r, null);
});

run();
