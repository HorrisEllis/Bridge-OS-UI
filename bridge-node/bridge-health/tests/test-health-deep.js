// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
'use strict';
/**
 * bridge-health/tests/test-health-deep.js
 */
const assert  = require('assert');
const os      = require('os');
const path    = require('path');
const fs      = require('fs');
const { createMeshHealth, computeNodeScore, createDeltaReplayEngine } = require('../index');

let passed = 0, failed = 0;
const tests = [];
function test(n, fn) { tests.push({ n, fn }); }
async function run() {
  console.log('\n[bridge-health] Deep Test Suite\n');
  for (const t of tests) {
    try { await t.fn(); console.log(`  ✓ ${t.n}`); passed++; }
    catch (e) { console.error(`  ✗ ${t.n}\n    ${e.message}`); failed++; }
  }
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

// ── computeNodeScore ──────────────────────────────────────────────────────────
test('computeNodeScore(): perfect conditions → 1.0', () => {
  const s = computeNodeScore({ bpmConsistency: 1, latencyGrade: 1, trustScore: 10, causalEventsPerMin: 60, sngateAllowRate: 1 });
  assert.ok(Math.abs(s - 1.0) < 0.01, `expected ~1.0, got ${s}`);
});

test('computeNodeScore(): all zeros → 0.0', () => {
  const s = computeNodeScore({ bpmConsistency: 0, latencyGrade: 0, trustScore: 0, causalEventsPerMin: 0, sngateAllowRate: 0 });
  assert.strictEqual(s, 0.0);
});

test('computeNodeScore(): default (no args) → valid range', () => {
  const s = computeNodeScore();
  assert.ok(s >= 0 && s <= 1, `score ${s} not in 0-1`);
});

test('computeNodeScore(): high trust raises score significantly', () => {
  const low  = computeNodeScore({ trustScore: 0 });
  const high = computeNodeScore({ trustScore: 10 });
  assert.ok(high > low);
});

test('computeNodeScore(): latency grade 0 drops score', () => {
  const good = computeNodeScore({ latencyGrade: 1 });
  const bad  = computeNodeScore({ latencyGrade: 0 });
  assert.ok(good > bad);
});

test('computeNodeScore(): always 0–1', () => {
  const combos = [
    { trustScore: 10, bpmConsistency: 0.5, latencyGrade: 0.8 },
    { trustScore: 0,  bpmConsistency: 1,   sngateAllowRate: 0.1 },
    { causalEventsPerMin: 300 }, // very high — should clamp
  ];
  for (const c of combos) {
    const s = computeNodeScore(c);
    assert.ok(s >= 0 && s <= 1, `score=${s} out of range for ${JSON.stringify(c)}`);
  }
});

// ── createDeltaReplayEngine ───────────────────────────────────────────────────
test('replayEngine: appendDelta + reconstruct returns state', async () => {
  const dir = path.join(os.tmpdir(), `health-replay-${Date.now()}`);
  const engine = createDeltaReplayEngine({ logDir: dir });
  engine.appendDelta({ type: 'cfr:node:upsert', id: 'node-1', label: 'Test', type2: 'canvas' });
  engine.appendDelta({ type: 'CFR_UPDATE', detail: JSON.stringify({ structure: 0.75 }) });
  const state = engine.reconstruct(null);
  assert.ok(state.field.structure === 0.75);
  assert.ok(state.nodes.length >= 1);
  fs.rmSync(dir, { recursive: true });
});

test('replayEngine: reconstruct at past timestamp excludes future deltas', async () => {
  const dir = path.join(os.tmpdir(), `health-replay2-${Date.now()}`);
  const engine = createDeltaReplayEngine({ logDir: dir });
  const past = Date.now() - 1000;
  engine.appendDelta({ type: 'CFR_UPDATE', detail: JSON.stringify({ structure: 0.3 }), _ts: past });
  await new Promise(r => setTimeout(r, 20)); // ensure different timestamp
  engine.appendDelta({ type: 'CFR_UPDATE', detail: JSON.stringify({ structure: 0.9 }) });
  // Reconstruct at 'past' should get structure 0.3 (before the 0.9 update)
  const state = engine.reconstruct(past + 100);
  assert.ok(state.field.structure <= 0.5, `expected pre-update structure, got ${state.field.structure}`);
  fs.rmSync(dir, { recursive: true });
});

test('replayEngine: empty log returns default field state', () => {
  const dir = path.join(os.tmpdir(), `health-empty-${Date.now()}`);
  const engine = createDeltaReplayEngine({ logDir: dir });
  const state = engine.reconstruct(null);
  assert.ok(state.field.structure === 0.5); // default
  assert.ok(Array.isArray(state.nodes));
  fs.rmSync(dir, { recursive: true });
});

// ── createMeshHealth ──────────────────────────────────────────────────────────
test('createMeshHealth(): returns install, route, stop, diagnostics', () => {
  const h = createMeshHealth({ logDir: path.join(os.tmpdir(), `mh-${Date.now()}`) });
  for (const m of ['install', 'route', 'stop', 'diagnostics']) assert.strictEqual(typeof h[m], 'function');
  h.stop();
});

test('updateNodeScore(): updates overall score', () => {
  const h = createMeshHealth({ logDir: path.join(os.tmpdir(), `mh2-${Date.now()}`) });
  h.updateNodeScore('node-a', { bpmConsistency: 1, latencyGrade: 1, trustScore: 9 });
  const d = h.diagnostics();
  assert.ok(d.overallScore > 0);
  h.stop();
});

test('route GET /mesh: returns ok:true with score and nodes', () => {
  const h = createMeshHealth({ logDir: path.join(os.tmpdir(), `mh3-${Date.now()}`) });
  h.updateNodeScore('test-uuid', { trustScore: 7, bpmConsistency: 0.9, latencyGrade: 0.8 });
  let status, body;
  const res = { writeHead: (s) => { status = s; }, end: (b) => { body = JSON.parse(b); } };
  h.route('GET', ['health', 'mesh'], null, null, res);
  assert.strictEqual(status, 200);
  assert.ok(body.ok);
  assert.ok(typeof body.overallScore === 'number');
  h.stop();
});

test('route POST /replay: returns ok:true with field and nodes', () => {
  const dir = path.join(os.tmpdir(), `mh-replay-${Date.now()}`);
  const h = createMeshHealth({ logDir: dir });
  let status, body;
  const res = { writeHead: (s) => { status = s; }, end: (b) => { body = JSON.parse(b); } };
  h.route('POST', ['health', 'replay'], { at: null }, null, res);
  assert.strictEqual(status, 200);
  assert.ok(body.ok);
  assert.ok(body.field);
  h.stop();
  fs.rmSync(dir, { recursive: true });
});

test('route GET /divergence: returns ok:true with events array', () => {
  const h = createMeshHealth({ logDir: path.join(os.tmpdir(), `mh4-${Date.now()}`) });
  let status, body;
  const res = { writeHead: (s) => { status = s; }, end: (b) => { body = JSON.parse(b); } };
  h.route('GET', ['health', 'divergence'], null, null, res);
  assert.strictEqual(status, 200);
  assert.ok(body.ok);
  assert.ok(Array.isArray(body.events));
  h.stop();
});

test('route POST /heal: returns 202 accepted', () => {
  const h = createMeshHealth({ logDir: path.join(os.tmpdir(), `mh5-${Date.now()}`) });
  let status, body;
  const res = { writeHead: (s) => { status = s; }, end: (b) => { body = JSON.parse(b); } };
  h.route('POST', ['health', 'heal'], { nodeUuid: 'dead-node-uuid' }, null, res);
  assert.strictEqual(status, 202);
  assert.ok(body.ok);
  h.stop();
});

test('route POST /heal: requires nodeUuid', () => {
  const h = createMeshHealth({ logDir: path.join(os.tmpdir(), `mh6-${Date.now()}`) });
  let status, body;
  const res = { writeHead: (s) => { status = s; }, end: (b) => { body = JSON.parse(b); } };
  h.route('POST', ['health', 'heal'], {}, null, res);
  assert.strictEqual(status, 400);
  h.stop();
});

test('diagnostics(): returns uuid, version, overallScore, nodeCount', () => {
  const h = createMeshHealth({ logDir: path.join(os.tmpdir(), `mh7-${Date.now()}`) });
  const d = h.diagnostics();
  assert.ok(d.uuid && d.version && typeof d.overallScore === 'number');
  h.stop();
});

run();
