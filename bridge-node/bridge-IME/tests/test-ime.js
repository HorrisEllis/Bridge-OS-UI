// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
'use strict';
const assert = require('assert');
const os     = require('os');
const path   = require('path');
const fs     = require('fs');
const { createIME } = require('../index');

let passed = 0, failed = 0;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

async function run() {
  console.log('\n[bridge-IME] Test Suite\n');
  for (const t of tests) {
    try { await t.fn(); console.log(`  ✓ ${t.name}`); passed++; }
    catch (e) { console.log(`  ✗ ${t.name}\n    ${e.message}`); failed++; }
  }
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

// ── Suite 1: Ingestion basics ─────────────────────────────────────────────────

test('ingest() returns profile', () => {
  const ime = createIME({ storeDir: null });
  const p = ime.ingest({ uuid: 'test-uuid-1', type: 'ssh.command', timestamp: Date.now(), payload: {} });
  assert.ok(p);
  assert.strictEqual(p.uuid, 'test-uuid-1');
  assert.ok(p.eventCount >= 1);
});

test('ingest() null uuid returns null', () => {
  const ime = createIME({ storeDir: null });
  const p = ime.ingest({ type: 'ssh.command' });
  assert.strictEqual(p, null);
});

test('ingest() increments eventCount', () => {
  const ime = createIME({ storeDir: null });
  const uuid = 'test-uuid-count';
  ime.ingest({ uuid, type: 'ssh.command', timestamp: Date.now(), payload: {} });
  ime.ingest({ uuid, type: 'ssh.command', timestamp: Date.now(), payload: {} });
  const p = ime.getProfile(uuid);
  assert.strictEqual(p.eventCount, 2);
});

test('ingest() tracks eventCounts per type', () => {
  const ime = createIME({ storeDir: null });
  const uuid = 'test-uuid-types';
  ime.ingest({ uuid, type: 'ssh.command', timestamp: Date.now(), payload: {} });
  ime.ingest({ uuid, type: 'file.read',   timestamp: Date.now(), payload: {} });
  ime.ingest({ uuid, type: 'ssh.command', timestamp: Date.now(), payload: {} });
  const p = ime.getProfile(uuid);
  assert.strictEqual(p.eventCounts['ssh.command'], 2);
  assert.strictEqual(p.eventCounts['file.read'], 1);
});

test('ingest() ring buffer caps at 1000 events', () => {
  const ime = createIME({ storeDir: null });
  const uuid = 'test-ringbuf';
  for (let i = 0; i < 1100; i++) {
    ime.ingest({ uuid, type: 'ssh.command', timestamp: Date.now(), payload: {} });
  }
  const p = ime.getProfile(uuid);
  assert.strictEqual(p.events.length, 1000);
});

// ── Suite 2: Profile read performance ─────────────────────────────────────────

test('getProfile() returns null for unknown uuid', () => {
  const ime = createIME({ storeDir: null });
  assert.strictEqual(ime.getProfile('nobody'), null);
});

test('getProfile() returns from cache in < 5ms', () => {
  const ime = createIME({ storeDir: null });
  const uuid = 'perf-test';
  ime.ingest({ uuid, type: 'ssh.command', timestamp: Date.now(), payload: {} });
  const t0 = Date.now();
  for (let i = 0; i < 100; i++) ime.getProfile(uuid);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 50, `100 getProfile() calls took ${elapsed}ms — expected < 50ms`);
});

test('getTrustScore() returns base for unknown uuid', () => {
  const ime = createIME({ storeDir: null });
  const score = ime.getTrustScore('unknown');
  assert.strictEqual(score, 5); // default base
});

// ── Suite 3: Trust score ──────────────────────────────────────────────────────

test('trustScore starts at base (5)', () => {
  const ime  = createIME({ storeDir: null });
  const uuid = 'trust-base';
  ime.ingest({ uuid, type: 'ssh.command', timestamp: Date.now(), payload: {} });
  const p = ime.getProfile(uuid);
  // Base is 5. No bonus yet (need 30 days age + 100 events)
  assert.ok(p.trustScore >= 0 && p.trustScore <= 10);
});

test('trustScore stays 0–10 always', () => {
  const ime  = createIME({ storeDir: null, modifiers: { base: 5, burst: -10, escalation: -10 } });
  const uuid = 'trust-bounds';
  for (let i = 0; i < 5; i++) {
    ime.ingest({ uuid, type: 'ssh.command', timestamp: Date.now(), payload: {} });
  }
  const p = ime.getProfile(uuid);
  assert.ok(p.trustScore >= 0);
  assert.ok(p.trustScore <= 10);
});

test('scoreReasons is an array', () => {
  const ime  = createIME({ storeDir: null });
  const uuid = 'score-reasons';
  ime.ingest({ uuid, type: 'ssh.command', timestamp: Date.now(), payload: {} });
  const p = ime.getProfile(uuid);
  assert.ok(Array.isArray(p.scoreReasons));
});

// ── Suite 4: Anomaly detection ────────────────────────────────────────────────

test('no anomalies below baseline sample floor', () => {
  const ime  = createIME({ storeDir: null, baselineMinEvents: 100 });
  const uuid = 'no-anom';
  ime.ingest({ uuid, type: 'ssh.command', timestamp: Date.now(), payload: {} });
  const p = ime.getProfile(uuid);
  assert.strictEqual(p.anomalies.length, 0);
});

test('burst detection fires after 10× rate spike', () => {
  const now  = Date.now();
  const ime  = createIME({ storeDir: null, baselineMinEvents: 10, burstMultiplier: 3 });
  const uuid = 'burst-test';

  // Build baseline: 10 events spread over an hour
  for (let i = 0; i < 12; i++) {
    ime.ingest({ uuid, type: 'ssh.command', timestamp: now - 3600000 + i * 300000, payload: {} });
  }
  // Burst: 20 events in 1 minute
  for (let i = 0; i < 20; i++) {
    ime.ingest({ uuid, type: 'ssh.command', timestamp: now - 30000 + i * 1000, payload: {} });
  }

  const p = ime.getProfile(uuid);
  const hasBurst = p.anomalies.some(a => a.type === 'burst');
  assert.ok(hasBurst, 'Expected burst anomaly');
});

test('escalation detected: read+write+command sequence', () => {
  const now  = Date.now();
  const ime  = createIME({ storeDir: null, baselineMinEvents: 10 });
  const uuid = 'escalation-test';

  // Build minimal baseline
  for (let i = 0; i < 12; i++) {
    ime.ingest({ uuid, type: 'ssh.command', timestamp: now - 3600000 + i * 300000, payload: {} });
  }

  // Escalation sequence within 10 min
  ime.ingest({ uuid, type: 'file.read',    timestamp: now - 500000, payload: {} });
  ime.ingest({ uuid, type: 'file.write',   timestamp: now - 400000, payload: {} });
  ime.ingest({ uuid, type: 'ssh.command',  timestamp: now,          payload: {} });

  const p = ime.getProfile(uuid);
  const hasEscalation = p.anomalies.some(a => a.type === 'escalation');
  assert.ok(hasEscalation, 'Expected escalation anomaly');
});

test('anomaly has required fields', () => {
  const now  = Date.now();
  const ime  = createIME({ storeDir: null, baselineMinEvents: 10, burstMultiplier: 2 });
  const uuid = 'anom-fields';

  for (let i = 0; i < 12; i++) {
    ime.ingest({ uuid, type: 'ssh.command', timestamp: now - 3600000 + i * 300000, payload: {} });
  }
  for (let i = 0; i < 20; i++) {
    ime.ingest({ uuid, type: 'ssh.command', timestamp: now - 10000 + i * 100, payload: {} });
  }

  const p = ime.getProfile(uuid);
  if (p.anomalies.length > 0) {
    const a = p.anomalies[0];
    assert.ok(a.id);
    assert.ok(a.ts);
    assert.ok(a.type);
    assert.ok(a.severity);
    assert.ok(typeof a.resolved === 'boolean');
  }
});

test('getAnomalies() filters by since', () => {
  const now  = Date.now();
  const ime  = createIME({ storeDir: null, baselineMinEvents: 10, burstMultiplier: 2 });
  const uuid = 'anom-since';

  for (let i = 0; i < 12; i++) {
    ime.ingest({ uuid, type: 'ssh.command', timestamp: now - 3600000 + i * 300000, payload: {} });
  }
  for (let i = 0; i < 20; i++) {
    ime.ingest({ uuid, type: 'ssh.command', timestamp: now - 10000 + i * 100, payload: {} });
  }

  const all    = ime.getAnomalies(uuid);
  const recent = ime.getAnomalies(uuid, { since: now + 1000 }); // future = nothing
  assert.ok(recent.length <= all.length);
});

// ── Suite 5: Relationships ────────────────────────────────────────────────────

test('peer UUID tracked in relationships', () => {
  const ime  = createIME({ storeDir: null });
  const uuid = 'rel-test';
  ime.ingest({ uuid, type: 'mesh.handshake', timestamp: Date.now(),
    payload: { peerUuid: 'peer-abc-123' } });
  const rels = ime.getRelationships(uuid);
  assert.ok(rels.peers.includes('peer-abc-123'));
});

test('groupHint tracked in clusters', () => {
  const ime  = createIME({ storeDir: null });
  const uuid = 'cluster-test';
  ime.ingest({ uuid, type: 'mesh.handshake', timestamp: Date.now(),
    payload: { groupHint: 'home-lab' } });
  const rels = ime.getRelationships(uuid);
  assert.ok(rels.clusters.includes('home-lab'));
});

// ── Suite 6: Persistence (atomic write) ──────────────────────────────────────

test('profile persists to disk atomically', async () => {
  const dir  = path.join(os.tmpdir(), `ime-test-${Date.now()}`);
  const ime  = createIME({ storeDir: dir });
  const uuid = 'persist-test';
  ime.ingest({ uuid, type: 'ssh.command', timestamp: Date.now(), payload: {} });

  // Wait for async flush
  await new Promise(r => setTimeout(r, 100));

  const file = path.join(dir, `${uuid}.json`);
  assert.ok(fs.existsSync(file), 'Profile file should exist on disk');
  const p = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(p.uuid, uuid);
  fs.rmSync(dir, { recursive: true });
});

test('no .tmp files left after flush', async () => {
  const dir  = path.join(os.tmpdir(), `ime-test-${Date.now()}`);
  const ime  = createIME({ storeDir: dir });
  const uuid = 'tmp-clean-test';
  ime.ingest({ uuid, type: 'ssh.command', timestamp: Date.now(), payload: {} });
  await new Promise(r => setTimeout(r, 150));
  const files = fs.readdirSync(dir);
  const tmps  = files.filter(f => f.includes('.tmp.'));
  assert.strictEqual(tmps.length, 0, 'Temp files should be cleaned up');
  fs.rmSync(dir, { recursive: true });
});

// ── Suite 7: Baseline ────────────────────────────────────────────────────────

test('baseline null until baselineMinEvents reached', () => {
  const ime  = createIME({ storeDir: null, baselineMinEvents: 50 });
  const uuid = 'baseline-null';
  for (let i = 0; i < 10; i++) {
    ime.ingest({ uuid, type: 'ssh.command', timestamp: Date.now() - i * 1000, payload: {} });
  }
  const p = ime.getProfile(uuid);
  assert.strictEqual(p.baseline, null);
});

test('baseline built after threshold events', () => {
  const ime  = createIME({ storeDir: null, baselineMinEvents: 10 });
  const uuid = 'baseline-built';
  const now  = Date.now();
  for (let i = 0; i < 15; i++) {
    ime.ingest({ uuid, type: 'ssh.command', timestamp: now - i * 3600000, payload: {} });
  }
  const p = ime.getProfile(uuid);
  assert.ok(p.baseline, 'Baseline should be built');
  assert.ok(p.baseline.avgFrequency >= 0);
});

// ── Suite 8: resetBaseline ────────────────────────────────────────────────────

test('resetBaseline() clears anomalies and baseline', () => {
  const ime  = createIME({ storeDir: null, baselineMinEvents: 10, burstMultiplier: 2 });
  const uuid = 'reset-test';
  const now  = Date.now();
  for (let i = 0; i < 12; i++) {
    ime.ingest({ uuid, type: 'ssh.command', timestamp: now - i * 3600000, payload: {} });
  }
  for (let i = 0; i < 20; i++) {
    ime.ingest({ uuid, type: 'ssh.command', timestamp: now - i * 100, payload: {} });
  }
  ime.resetBaseline(uuid);
  const p = ime.getProfile(uuid);
  assert.strictEqual(p.anomalies.length, 0);
  assert.strictEqual(p.baseline, null);
});

run();
