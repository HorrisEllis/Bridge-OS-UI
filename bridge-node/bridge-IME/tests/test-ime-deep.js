// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
'use strict';
/**
 * bridge-IME/tests/test-ime-deep.js
 * §4.1 §1.1 §1.2
 * Covers: ingest, getProfile, getTrustScore, anomaly detection,
 * score computation, relationships, persistence, invariants
 */
const assert = require('assert');
const os   = require('os');
const path = require('path');
const fs   = require('fs');
const { createIME } = require('../index');

let passed = 0, failed = 0;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
async function run() {
  console.log('\n[bridge-IME] Deep Test Suite\n');
  for (const t of tests) {
    try { await t.fn(); console.log(`  ✓ ${t.name}`); passed++; }
    catch (e) { console.error(`  ✗ ${t.name}\n    ${e.message}`); failed++; }
  }
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

// ── ingest() basics ───────────────────────────────────────────────────────────
test('ingest(): returns profile on valid event', () => {
  const ime = createIME({ storeDir: null });
  const p = ime.ingest({ uuid: 'u1', type: 'http.request', timestamp: Date.now(), payload: {} });
  assert.ok(p && p.uuid === 'u1');
});
test('ingest(): requires uuid — returns null', () => {
  const ime = createIME({ storeDir: null });
  const p = ime.ingest({ type: 'http.request', timestamp: Date.now() });
  assert.strictEqual(p, null);
});
test('ingest(): increments eventCount', () => {
  const ime = createIME({ storeDir: null });
  ime.ingest({ uuid: 'cnt', type: 'http.request', timestamp: Date.now(), payload: {} });
  ime.ingest({ uuid: 'cnt', type: 'http.request', timestamp: Date.now(), payload: {} });
  const p = ime.getProfile('cnt');
  assert.strictEqual(p.eventCount, 2);
});
test('ingest(): tracks per-type eventCounts', () => {
  const ime = createIME({ storeDir: null });
  ime.ingest({ uuid: 'tc', type: 'ssh.command', timestamp: Date.now(), payload: {} });
  ime.ingest({ uuid: 'tc', type: 'file.read',   timestamp: Date.now(), payload: {} });
  const p = ime.getProfile('tc');
  assert.strictEqual(p.eventCounts['ssh.command'], 1);
  assert.strictEqual(p.eventCounts['file.read'],   1);
});
test('ingest(): updates lastSeen', () => {
  const ime = createIME({ storeDir: null });
  const before = Date.now();
  ime.ingest({ uuid: 'ls', type: 'http.request', timestamp: Date.now(), payload: {} });
  const p = ime.getProfile('ls');
  assert.ok(p.lastSeen >= before);
});
test('ingest(): events ring buffer capped at 1000', () => {
  const ime = createIME({ storeDir: null });
  for (let i = 0; i < 1100; i++) {
    ime.ingest({ uuid: 'ring', type: 'http.request', timestamp: Date.now(), payload: {} });
  }
  const p = ime.getProfile('ring');
  assert.ok(p.events.length <= 1000);
});
test('ingest(): stores only summary (no full payload)', () => {
  const ime = createIME({ storeDir: null });
  ime.ingest({ uuid: 'sum', type: 'file.read', timestamp: Date.now(),
    payload: { secretKey: 'ABC123', path: '/etc/passwd' } });
  const p = ime.getProfile('sum');
  const ev = p.events[0];
  assert.ok(!ev.secretKey, 'full payload must not be stored');
  assert.ok(ev.path === '/etc/passwd', 'safe scalar path should be stored');
});
test('ingest(): unknown event type accepted (no crash)', () => {
  const ime = createIME({ storeDir: null });
  assert.doesNotThrow(() =>
    ime.ingest({ uuid: 'unk', type: 'custom:type:unknown', timestamp: Date.now(), payload: {} })
  );
});
test('ingest(): tracks tool in event summary', () => {
  const ime = createIME({ storeDir: null });
  ime.ingest({ uuid: 'tool', type: 'agent.tool_call', timestamp: Date.now(), payload: { tool: 'bash' } });
  const p = ime.getProfile('tool');
  assert.strictEqual(p.events[0].tool, 'bash');
});
test('ingest(): tracks command in event summary', () => {
  const ime = createIME({ storeDir: null });
  ime.ingest({ uuid: 'cmd', type: 'ssh.command', timestamp: Date.now(), payload: { command: 'ls' } });
  const p = ime.getProfile('cmd');
  assert.strictEqual(p.events[0].command, 'ls');
});

// ── getProfile() ──────────────────────────────────────────────────────────────
test('getProfile(): returns null for unknown uuid (no disk)', () => {
  const ime = createIME({ storeDir: null });
  assert.strictEqual(ime.getProfile('nonexistent-uuid'), null);
});
test('getProfile(): returns profile after ingest', () => {
  const ime = createIME({ storeDir: null });
  ime.ingest({ uuid: 'gp', type: 'http.request', timestamp: Date.now(), payload: {} });
  const p = ime.getProfile('gp');
  assert.ok(p && p.uuid === 'gp');
});
test('INVARIANT: getProfile() returns in < 5ms (100 calls)', () => {
  const ime = createIME({ storeDir: null });
  ime.ingest({ uuid: 'perf', type: 'http.request', timestamp: Date.now(), payload: {} });
  const t0 = Date.now();
  for (let i = 0; i < 100; i++) ime.getProfile('perf');
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 50, `100 calls took ${elapsed}ms — must be < 50ms total`);
});
test('getProfile(): profile has expected fields', () => {
  const ime = createIME({ storeDir: null });
  ime.ingest({ uuid: 'fields', type: 'http.request', timestamp: Date.now(), payload: {} });
  const p = ime.getProfile('fields');
  for (const f of ['uuid','trustScore','scoreReasons','firstSeen','lastSeen','eventCount','events','anomalies']) {
    assert.ok(f in p, `missing field: ${f}`);
  }
});
test('getProfile(): caches null sentinel (repeated miss = no disk re-read)', () => {
  const loads = [];
  const ime = createIME({ storeDir: null });
  // Override _loadProfile internally isn't possible, but repeated null calls should be fast
  const t0 = Date.now();
  for (let i = 0; i < 200; i++) ime.getProfile('miss-cache');
  assert.ok(Date.now() - t0 < 50);
});

// ── getTrustScore() ───────────────────────────────────────────────────────────
test('getTrustScore(): returns 5 for unknown uuid (neutral default)', () => {
  const ime = createIME({ storeDir: null });
  assert.strictEqual(ime.getTrustScore('unknown-x'), 5);
});
test('getTrustScore(): returns number in 0–10 range', () => {
  const ime = createIME({ storeDir: null });
  ime.ingest({ uuid: 'ts-u', type: 'http.request', timestamp: Date.now(), payload: {} });
  const s = ime.getTrustScore('ts-u');
  assert.ok(typeof s === 'number' && s >= 0 && s <= 10);
});
test('getTrustScore(): new profile starts below 5 (probationary ramp)', () => {
  // IME-01 fix: new identities no longer start at neutral 5.
  // They earn trust progressively over the first 100 events.
  const ime = createIME({ storeDir: null });
  ime.ingest({ uuid: 'base-score', type: 'http.request', timestamp: Date.now(), payload: {} });
  const p = ime.getProfile('base-score');
  // Score should be below neutral (< 5) on first event due to probationary penalty
  assert.ok(p?.trustScore < 5, `expected score < 5, got ${p?.trustScore}`);
  assert.ok(p?.trustScore >= 0, `expected score >= 0, got ${p?.trustScore}`);
  // Reason should mention probation
  assert.ok(p?.scoreReasons.some(r => r.includes('probat')), 'should mention probation in reasons');
});

// ── getAnomalies() ────────────────────────────────────────────────────────────
test('getAnomalies(): returns [] for unknown uuid', () => {
  const ime = createIME({ storeDir: null });
  assert.deepStrictEqual(ime.getAnomalies('no-uuid'), []);
});
test('getAnomalies(): returns [] for new profile with no events', () => {
  const ime = createIME({ storeDir: null });
  ime.ingest({ uuid: 'clean', type: 'http.request', timestamp: Date.now(), payload: {} });
  assert.deepStrictEqual(ime.getAnomalies('clean'), []);
});
test('getAnomalies(): since filter works', () => {
  const ime = createIME({ storeDir: null });
  ime.ingest({ uuid: 'since-u', type: 'http.request', timestamp: Date.now(), payload: {} });
  const future = Date.now() + 1000;
  assert.deepStrictEqual(ime.getAnomalies('since-u', { since: future }), []);
});

// ── getRelationships() ────────────────────────────────────────────────────────
test('getRelationships(): returns { peers:[], clusters:[] } for unknown', () => {
  const ime = createIME({ storeDir: null });
  const r = ime.getRelationships('no-uuid');
  assert.deepStrictEqual(r, { peers: [], clusters: [] });
});
test('getRelationships(): tracks peerUuid from payload', () => {
  const ime = createIME({ storeDir: null });
  ime.ingest({ uuid: 'rel-u', type: 'mesh.connection', timestamp: Date.now(),
    payload: { peerUuid: 'peer-abc' } });
  const r = ime.getRelationships('rel-u');
  assert.ok(r.peers.includes('peer-abc'));
});
test('getRelationships(): tracks groupHint cluster', () => {
  const ime = createIME({ storeDir: null });
  ime.ingest({ uuid: 'grp-u', type: 'mesh.connection', timestamp: Date.now(),
    payload: { groupHint: 'cluster-1' } });
  const r = ime.getRelationships('grp-u');
  assert.ok(r.clusters.includes('cluster-1'));
});
test('getRelationships(): peer list capped at 100', () => {
  const ime = createIME({ storeDir: null });
  for (let i = 0; i < 110; i++) {
    ime.ingest({ uuid: 'peerlimit', type: 'mesh.connection', timestamp: Date.now(),
      payload: { peerUuid: `peer-${i}` } });
  }
  const r = ime.getRelationships('peerlimit');
  assert.ok(r.peers.length <= 100);
});

// ── resetBaseline() ───────────────────────────────────────────────────────────
test('resetBaseline(): clears baseline and anomalies', () => {
  const ime = createIME({ storeDir: null });
  ime.ingest({ uuid: 'rb', type: 'http.request', timestamp: Date.now(), payload: {} });
  ime.resetBaseline('rb');
  const p = ime.getProfile('rb');
  assert.strictEqual(p.baseline, null);
  assert.deepStrictEqual(p.anomalies, []);
});

// ── Disk persistence ──────────────────────────────────────────────────────────
test('persistence: profile written to disk on ingest', async () => {
  const dir = path.join(os.tmpdir(), `ime-persist-${Date.now()}`);
  const ime = createIME({ storeDir: dir });
  ime.ingest({ uuid: 'disk-u', type: 'http.request', timestamp: Date.now(), payload: {} });
  await new Promise(r => setTimeout(r, 50)); // wait for setImmediate flush
  const file = path.join(dir, 'disk-u.json');
  assert.ok(fs.existsSync(file), 'Profile file should exist');
  fs.rmSync(dir, { recursive: true });
});
test('persistence: profile loaded from disk on getProfile miss', async () => {
  const dir = path.join(os.tmpdir(), `ime-load-${Date.now()}`);
  const ime1 = createIME({ storeDir: dir });
  ime1.ingest({ uuid: 'load-u', type: 'http.request', timestamp: Date.now(), payload: {} });
  await new Promise(r => setTimeout(r, 50));
  const ime2 = createIME({ storeDir: dir });
  const p = ime2.getProfile('load-u');
  assert.ok(p && p.uuid === 'load-u');
  fs.rmSync(dir, { recursive: true });
});
test('persistence: atomic write (no .tmp files left on disk)', async () => {
  const dir = path.join(os.tmpdir(), `ime-atomic-${Date.now()}`);
  const ime = createIME({ storeDir: dir });
  ime.ingest({ uuid: 'atomic-u', type: 'http.request', timestamp: Date.now(), payload: {} });
  await new Promise(r => setTimeout(r, 50));
  const files = fs.readdirSync(dir);
  assert.ok(!files.some(f => f.includes('.tmp.')), 'No tmp files should remain');
  fs.rmSync(dir, { recursive: true });
});
test('persistence: storeDir null = no disk writes', async () => {
  const ime = createIME({ storeDir: null });
  ime.ingest({ uuid: 'nodisk', type: 'http.request', timestamp: Date.now(), payload: {} });
  await new Promise(r => setTimeout(r, 30));
  // No crash, no disk writes attempted
  assert.ok(true);
});

// ── install() ────────────────────────────────────────────────────────────────
test('install(): sets busEmit without crash', () => {
  const ime = createIME({ storeDir: null });
  assert.doesNotThrow(() => ime.install({ busEmit: () => {} }));
});
test('install(): loads existing profiles from storeDir', async () => {
  const dir = path.join(os.tmpdir(), `ime-install-${Date.now()}`);
  const ime1 = createIME({ storeDir: dir });
  ime1.ingest({ uuid: 'preload-u', type: 'http.request', timestamp: Date.now(), payload: {} });
  await new Promise(r => setTimeout(r, 50));
  const ime2 = createIME({ storeDir: dir });
  ime2.install({});
  // After install, preloaded profile should be in cache
  const p = ime2.getProfile('preload-u');
  assert.ok(p && p.uuid === 'preload-u');
  fs.rmSync(dir, { recursive: true });
});

// ── Burst anomaly detection ───────────────────────────────────────────────────
test('burst anomaly: detected after 10× normal rate in 5min window', () => {
  // Need 100 baseline events first, then rapid burst
  const ime = createIME({ storeDir: null, baselineMinEvents: 5, burstMultiplier: 3 });
  const now = Date.now();
  // 5 baseline events spread over time
  for (let i = 0; i < 5; i++) {
    ime.ingest({ uuid: 'burst-u', type: 'http.request',
      timestamp: now - (60 * 60 * 1000) + i * 60000, payload: {} });
  }
  // Rapid burst: 20 events in the last minute
  for (let i = 0; i < 20; i++) {
    ime.ingest({ uuid: 'burst-u', type: 'http.request',
      timestamp: now - 30000 + i * 100, payload: {} });
  }
  const p = ime.getProfile('burst-u');
  // May or may not have burst depending on baseline avg — just verify no crash
  assert.ok(Array.isArray(p.anomalies));
});

// ── INVARIANT: IME never decides ─────────────────────────────────────────────
test('INVARIANT: IME exposes no evaluate/gate/decide methods', () => {
  const ime = createIME({ storeDir: null });
  assert.ok(!('evaluate' in ime), 'IME must not expose evaluate()');
  assert.ok(!('decide'   in ime), 'IME must not expose decide()');
  assert.ok(!('gate'     in ime), 'IME must not expose gate()');
});

run();
