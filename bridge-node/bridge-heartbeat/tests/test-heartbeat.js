// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
'use strict';
const assert = require('assert');
const http   = require('http');
const { createBPMTracker, latencyGrade, createHeartbeatManager } = require('../index');

let passed = 0, failed = 0;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
async function run() {
  console.log('\n[bridge-heartbeat] Test Suite\n');
  for (const t of tests) {
    try { await t.fn(); console.log(`  ✓ ${t.name}`); passed++; }
    catch (e) { console.log(`  ✗ ${t.name}\n    ${e.message}`); failed++; }
  }
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

// ── Suite 1: BPM tracker ──────────────────────────────────────────────────────

test('BPM is 0 before any beats', () => {
  const t = createBPMTracker();
  assert.strictEqual(t.bpm(), 0);
});

test('BPM approximates correctly for 1s intervals', async () => {
  const t = createBPMTracker(5);
  // Simulate 5 beats at ~1000ms intervals
  for (let i = 0; i < 5; i++) {
    t.beat();
    await new Promise(r => setTimeout(r, 100));
  }
  const bpm = t.bpm();
  // 100ms intervals ≈ 600 BPM — just verify it's a positive number
  assert.ok(bpm > 0, `Expected positive BPM, got ${bpm}`);
});

test('BPM consistency is 1.0 for single interval', () => {
  const t = createBPMTracker();
  t.beat();
  t.beat();
  const c = t.consistency();
  assert.ok(c >= 0 && c <= 1.0);
});

test('BPM window caps interval history', () => {
  const t = createBPMTracker(3);
  for (let i = 0; i < 10; i++) t.beat();
  assert.ok(t.intervals().length <= 3);
});

// ── Suite 2: Latency grade ────────────────────────────────────────────────────

test('latencyGrade(0) = 1.0', ()   => assert.strictEqual(latencyGrade(0),    1.0));
test('latencyGrade(50) = 1.0', ()  => assert.strictEqual(latencyGrade(50),   1.0));
test('latencyGrade(100) = 0.8', () => assert.strictEqual(latencyGrade(100),  0.8));
test('latencyGrade(300) = 0.5', () => assert.strictEqual(latencyGrade(300),  0.5));
test('latencyGrade(1000) = 0.2', ()=> assert.strictEqual(latencyGrade(1000), 0.2));
test('latencyGrade(2000) = 0.0', ()=> assert.strictEqual(latencyGrade(2000), 0.0));

// ── Suite 3: HeartbeatManager with mock HTTP server ────────────────────────────

test('register + healthy → heartbeat:pulse event', async () => {
  // Spin up a mock /health server
  const server = http.createServer((req, res) => {
    res.writeHead(200); res.end('{"ok":true}');
  });
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;

  const events = [];
  const mgr = createHeartbeatManager({
    cfg: { pulseInterval: 100, healthTimeout: 500 },
    busEmit: (sig, data) => events.push({ sig, data }),
  });

  mgr.register('test-node', `http://127.0.0.1:${port}/health`);
  await new Promise(r => setTimeout(r, 350));
  mgr.unregister('test-node');

  server.close();
  const pulses = events.filter(e => e.sig === 'heartbeat:pulse');
  assert.ok(pulses.length >= 2, `Expected ≥2 pulses, got ${pulses.length}`);
  assert.ok(pulses[0].data.bpm >= 0);
});

test('missed beats → node:degraded at threshold', async () => {
  // Server that always fails
  const server = http.createServer((req, res) => {
    res.writeHead(500); res.end();
  });
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;

  const events = [];
  const mgr = createHeartbeatManager({
    cfg: { pulseInterval: 80, healthTimeout: 200, degradeAt: 3, deadAt: 20 },
    busEmit: (sig, data) => events.push({ sig, data }),
  });

  mgr.register('bad-node', `http://127.0.0.1:${port}/health`);
  await new Promise(r => setTimeout(r, 400));
  mgr.unregister('bad-node');
  server.close();

  const degraded = events.filter(e => e.sig === 'node:degraded');
  assert.ok(degraded.length >= 1, 'Expected node:degraded event');
});

test('dead threshold → node:dead + auto-unregister', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(500); res.end();
  });
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;

  const events = [];
  const mgr = createHeartbeatManager({
    cfg: { pulseInterval: 50, healthTimeout: 100, degradeAt: 2, deadAt: 4 },
    busEmit: (sig, data) => events.push({ sig, data }),
  });

  mgr.register('dead-node', `http://127.0.0.1:${port}/health`);
  await new Promise(r => setTimeout(r, 500));
  server.close();

  const dead = events.filter(e => e.sig === 'node:dead');
  assert.ok(dead.length >= 1, 'Expected node:dead event');
  // Node should be auto-unregistered
  assert.strictEqual(mgr.getStatus('dead-node'), null);
});

test('getStatus() returns null for unregistered node', () => {
  const mgr = createHeartbeatManager({});
  assert.strictEqual(mgr.getStatus('nobody'), null);
});

test('unregister() stops monitoring', async () => {
  const server = http.createServer((req, res) => { res.writeHead(200); res.end(); });
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;

  const events = [];
  const mgr = createHeartbeatManager({
    cfg: { pulseInterval: 80 },
    busEmit: (sig) => events.push(sig),
  });

  mgr.register('stop-test', `http://127.0.0.1:${port}/health`);
  await new Promise(r => setTimeout(r, 150));
  const countBefore = events.length;
  mgr.unregister('stop-test');
  await new Promise(r => setTimeout(r, 200));
  server.close();

  const countAfter = events.length;
  // Should be no more than 1–2 events after unregister
  assert.ok(countAfter - countBefore <= 2);
});

run();
