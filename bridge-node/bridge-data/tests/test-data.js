// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
'use strict';
const assert = require('assert');
const os     = require('os');
const path   = require('path');
const fs     = require('fs');
const { createDataBus }  = require('../index');
const { createSNGate }   = require('../../bridge-sngate/index');
const { createIME }      = require('../../bridge-IME/index');

let passed = 0, failed = 0;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
async function run() {
  console.log('\n[bridge-data] Test Suite\n');
  for (const t of tests) {
    try { await t.fn(); console.log(`  ✓ ${t.name}`); passed++; }
    catch (e) { console.log(`  ✗ ${t.name}\n    ${e.message}`); failed++; }
  }
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

test('push() returns ok for valid push', async () => {
  const bus = createDataBus({});
  const r   = await bus.push({ uuid: 'mod-uuid-1', moduleUuid: 'mod-a', tag: 'event', payload: { x: 1 } });
  assert.ok(r.ok, JSON.stringify(r));
  assert.ok(r.id.startsWith('dp_'));
});

test('push() requires uuid', async () => {
  const bus = createDataBus({});
  const r   = await bus.push({ moduleUuid: 'mod-a', tag: 'event' });
  assert.ok(!r.ok);
  assert.match(r.error, /uuid required/);
});

test('push() calls registered hook for moduleUuid', async () => {
  const bus    = createDataBus({});
  const calls  = [];
  bus.registerHook('mod-hook', (data) => calls.push(data));
  await bus.push({ uuid: 'sender', moduleUuid: 'mod-hook', tag: 'sensor', payload: { v: 42 } });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].tag, 'sensor');
});

test('push() hook not called for different moduleUuid', async () => {
  const bus   = createDataBus({});
  const calls = [];
  bus.registerHook('mod-x', () => calls.push(1));
  await bus.push({ uuid: 'sender', moduleUuid: 'mod-y', tag: 'event', payload: {} });
  assert.strictEqual(calls.length, 0);
});

test('hook unsubscribe stops future calls', async () => {
  const bus   = createDataBus({});
  const calls = [];
  const unsub = bus.registerHook('mod-unsub', () => calls.push(1));
  await bus.push({ uuid: 'u', moduleUuid: 'mod-unsub', tag: 'event', payload: {} });
  unsub();
  await bus.push({ uuid: 'u', moduleUuid: 'mod-unsub', tag: 'event', payload: {} });
  assert.strictEqual(calls.length, 1);
});

test('push() with deny rule → blocked', async () => {
  const gate = createSNGate({ logDir: null });
  gate.rules.add({ type: 'uuid', value: 'blocked-sender', action: 'deny' });
  const bus  = createDataBus({ gate });
  const r    = await bus.push({ uuid: 'blocked-sender', moduleUuid: 'mod', tag: 'event', payload: {} });
  assert.ok(!r.ok);
  assert.strictEqual(r.error, 'blocked');
});

test('push() emits data:received on bus', async () => {
  const emitted = [];
  const bus = createDataBus({ busEmit: (sig, data) => emitted.push({ sig, data }) });
  await bus.push({ uuid: 'u', moduleUuid: 'mod', tag: 'metric', payload: {} });
  const received = emitted.filter(e => e.sig === 'data:received');
  assert.ok(received.length >= 1);
});

test('push() feeds IME', async () => {
  const ime     = createIME({ storeDir: null });
  const bus     = createDataBus({ ime });
  const uuid    = 'ime-feed-uuid';
  await bus.push({ uuid, moduleUuid: 'mod', tag: 'event', payload: {} });
  const profile = ime.getProfile(uuid);
  assert.ok(profile, 'IME should have profile after push');
  assert.ok(profile.eventCount >= 1);
});

test('push() writes delta to disk', async () => {
  const dir = path.join(os.tmpdir(), `delta-test-${Date.now()}`);
  const bus = createDataBus({ deltaDir: dir });
  await bus.push({ uuid: 'u', moduleUuid: 'mod', tag: 'log', payload: {} });
  const today = new Date().toISOString().slice(0, 10);
  const file  = path.join(dir, `delta-${today}.jsonl`);
  assert.ok(fs.existsSync(file), 'Delta file should exist');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.ok(lines.length >= 1);
  const entry = JSON.parse(lines[0]);
  assert.ok(entry.id);
  assert.ok(entry.uuid);
  fs.rmSync(dir, { recursive: true });
});

test('hook error does not crash push()', async () => {
  const bus = createDataBus({});
  bus.registerHook('crash-mod', () => { throw new Error('hook boom'); });
  const r = await bus.push({ uuid: 'u', moduleUuid: 'crash-mod', tag: 'event', payload: {} });
  assert.ok(r.ok);
});

run();
