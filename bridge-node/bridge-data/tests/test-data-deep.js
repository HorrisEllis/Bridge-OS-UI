// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
'use strict';
/**
 * bridge-data/tests/test-data-deep.js
 * Deep test suite — universal data intake pipeline
 * §4.1 §1.2 §5.1
 */

const assert = require('assert');
const os     = require('os');
const path   = require('path');
const fs     = require('fs');
const { createDataBus } = require('../index');

let passed = 0, failed = 0;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
async function run() {
  console.log('\n[bridge-data] Deep Test Suite\n');
  for (const t of tests) {
    try { await t.fn(); console.log(`  ✓ ${t.name}`); passed++; }
    catch (e) { console.error(`  ✗ ${t.name}\n    ${e.message}`); failed++; }
  }
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

// ── push() basics ─────────────────────────────────────────────────────────────

test('push(): ok:true for valid payload', async () => {
  const bus = createDataBus({});
  const r = await bus.push({ uuid: 'u1', moduleUuid: 'mod-a', tag: 'event', payload: { x: 1 } });
  assert.ok(r.ok, JSON.stringify(r));
});
test('push(): id starts with dp_', async () => {
  const bus = createDataBus({});
  const r = await bus.push({ uuid: 'u2', moduleUuid: 'mod-a', tag: 'event', payload: {} });
  assert.ok(r.id.startsWith('dp_'));
});
test('push(): decision is allow when no gate', async () => {
  const bus = createDataBus({});
  const r = await bus.push({ uuid: 'u3', moduleUuid: 'mod', tag: 'event', payload: {} });
  assert.strictEqual(r.decision, 'allow');
});
test('push(): fidelity is numeric', async () => {
  const bus = createDataBus({});
  const r = await bus.push({ uuid: 'u4', moduleUuid: 'mod', tag: 'event', payload: {} });
  assert.ok(typeof r.fidelity === 'number');
});
test('push(): requires uuid — returns ok:false', async () => {
  const bus = createDataBus({});
  const r = await bus.push({ moduleUuid: 'mod', tag: 'event' });
  assert.ok(!r.ok);
  assert.match(r.error, /uuid required/);
});
test('push(): ok without moduleUuid (optional)', async () => {
  const bus = createDataBus({});
  const r = await bus.push({ uuid: 'u5', tag: 'event', payload: {} });
  assert.ok(r.ok);
});
test('push(): default tag is event', async () => {
  const emitted = [];
  const bus = createDataBus({ busEmit: (sig, d) => emitted.push({ sig, d }) });
  await bus.push({ uuid: 'u6', moduleUuid: 'mod' });
  const received = emitted.find(e => e.sig === 'data:received');
  assert.ok(received);
  assert.strictEqual(received.d.tag, 'event');
});
test('push(): large payload does not throw', async () => {
  const bus = createDataBus({});
  const big = { data: 'x'.repeat(100_000) };
  const r = await bus.push({ uuid: 'u7', moduleUuid: 'mod', tag: 'sensor', payload: big });
  assert.ok(r.ok);
});
test('push(): each call produces unique id', async () => {
  const bus = createDataBus({});
  const ids = new Set();
  for (let i = 0; i < 50; i++) {
    const r = await bus.push({ uuid: `uniq-${i}`, moduleUuid: 'mod', tag: 'event', payload: {} });
    ids.add(r.id);
  }
  assert.strictEqual(ids.size, 50);
});

// ── registerHook ──────────────────────────────────────────────────────────────

test('registerHook(): fires for matching moduleUuid', async () => {
  const bus = createDataBus({});
  const calls = [];
  bus.registerHook('mod-hook', d => calls.push(d));
  await bus.push({ uuid: 'u', moduleUuid: 'mod-hook', tag: 'sensor', payload: { v: 42 } });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].tag, 'sensor');
});
test('registerHook(): does NOT fire for different moduleUuid', async () => {
  const bus = createDataBus({});
  const calls = [];
  bus.registerHook('mod-x', () => calls.push(1));
  await bus.push({ uuid: 'u', moduleUuid: 'mod-y', tag: 'event', payload: {} });
  assert.strictEqual(calls.length, 0);
});
test('registerHook(): multiple hooks on same moduleUuid all fire', async () => {
  const bus = createDataBus({});
  const a = [], b = [];
  bus.registerHook('mod-multi', () => a.push(1));
  bus.registerHook('mod-multi', () => b.push(1));
  await bus.push({ uuid: 'u', moduleUuid: 'mod-multi', tag: 'event', payload: {} });
  assert.strictEqual(a.length, 1);
  assert.strictEqual(b.length, 1);
});
test('registerHook(): returns unsubscribe fn that stops future calls', async () => {
  const bus = createDataBus({});
  const calls = [];
  const unsub = bus.registerHook('mod-unsub', () => calls.push(1));
  await bus.push({ uuid: 'u', moduleUuid: 'mod-unsub', tag: 'event', payload: {} });
  unsub();
  await bus.push({ uuid: 'u', moduleUuid: 'mod-unsub', tag: 'event', payload: {} });
  assert.strictEqual(calls.length, 1);
});
test('registerHook(): hook receives id, uuid, moduleUuid, tag, payload, ts, fidelity', async () => {
  const bus = createDataBus({});
  let hookData;
  bus.registerHook('mod-fields', d => { hookData = d; });
  await bus.push({ uuid: 'hook-uuid', moduleUuid: 'mod-fields', tag: 'metric', payload: { k: 'v' } });
  assert.ok(hookData.id.startsWith('dp_'));
  assert.strictEqual(hookData.uuid, 'hook-uuid');
  assert.strictEqual(hookData.moduleUuid, 'mod-fields');
  assert.strictEqual(hookData.tag, 'metric');
  assert.deepStrictEqual(hookData.payload, { k: 'v' });
  assert.ok(hookData.ts > 0);
  assert.ok(typeof hookData.fidelity === 'number');
});
test('registerHook(): hook error does not crash push()', async () => {
  const bus = createDataBus({});
  bus.registerHook('crash-mod', () => { throw new Error('hook boom'); });
  const r = await bus.push({ uuid: 'u', moduleUuid: 'crash-mod', tag: 'event', payload: {} });
  assert.ok(r.ok);
});

// ── busEmit integration ───────────────────────────────────────────────────────

test('busEmit: data:received fired on successful push', async () => {
  const emitted = [];
  const bus = createDataBus({ busEmit: (sig, d) => emitted.push({ sig, d }) });
  await bus.push({ uuid: 'emit-u', moduleUuid: 'mod', tag: 'event', payload: {} });
  assert.ok(emitted.find(e => e.sig === 'data:received'));
});
test('busEmit: data:received contains correct uuid', async () => {
  const emitted = [];
  const bus = createDataBus({ busEmit: (sig, d) => emitted.push({ sig, d }) });
  await bus.push({ uuid: 'my-uuid', moduleUuid: 'mod', tag: 'event', payload: {} });
  const ev = emitted.find(e => e.sig === 'data:received');
  assert.strictEqual(ev.d.uuid, 'my-uuid');
});
test('busEmit: not called on uuid-missing push (fails early)', async () => {
  const emitted = [];
  const bus = createDataBus({ busEmit: (sig, d) => emitted.push({ sig, d }) });
  await bus.push({ moduleUuid: 'mod', tag: 'event' });
  assert.ok(!emitted.find(e => e.sig === 'data:received'));
});

// ── delta disk write ──────────────────────────────────────────────────────────

test('delta: writes JSONL file on push', async () => {
  const dir = path.join(os.tmpdir(), `delta-deep-${Date.now()}`);
  const bus = createDataBus({ deltaDir: dir });
  await bus.push({ uuid: 'delta-u', moduleUuid: 'mod', tag: 'log', payload: {} });
  const today = new Date().toISOString().slice(0, 10);
  const file = path.join(dir, `delta-${today}.jsonl`);
  assert.ok(fs.existsSync(file), 'Delta file should exist');
  fs.rmSync(dir, { recursive: true });
});
test('delta: written entry has required fields', async () => {
  const dir = path.join(os.tmpdir(), `delta-fields-${Date.now()}`);
  const bus = createDataBus({ deltaDir: dir });
  await bus.push({ uuid: 'dfield-u', moduleUuid: 'mod-delta', tag: 'metric', payload: { v: 1 } });
  const today = new Date().toISOString().slice(0, 10);
  const file = path.join(dir, `delta-${today}.jsonl`);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const entry = JSON.parse(lines[0]);
  assert.ok(entry.id.startsWith('dp_'));
  assert.strictEqual(entry.uuid, 'dfield-u');
  assert.strictEqual(entry.moduleUuid, 'mod-delta');
  assert.strictEqual(entry.tag, 'metric');
  assert.ok(entry.ts > 0);
  assert.ok(typeof entry.fidelity === 'number');
  assert.ok(typeof entry.payloadSize === 'number');
  fs.rmSync(dir, { recursive: true });
});
test('delta: multiple pushes append to same file', async () => {
  const dir = path.join(os.tmpdir(), `delta-multi-${Date.now()}`);
  const bus = createDataBus({ deltaDir: dir });
  await bus.push({ uuid: 'dm-1', moduleUuid: 'mod', tag: 'event', payload: {} });
  await bus.push({ uuid: 'dm-2', moduleUuid: 'mod', tag: 'event', payload: {} });
  await bus.push({ uuid: 'dm-3', moduleUuid: 'mod', tag: 'event', payload: {} });
  const today = new Date().toISOString().slice(0, 10);
  const file = path.join(dir, `delta-${today}.jsonl`);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
  assert.strictEqual(lines.length, 3);
  fs.rmSync(dir, { recursive: true });
});
test('delta: creates dir if not exists', async () => {
  const dir = path.join(os.tmpdir(), `delta-newdir-${Date.now()}`, 'nested', 'path');
  const bus = createDataBus({ deltaDir: dir });
  await bus.push({ uuid: 'new-dir-u', moduleUuid: 'mod', tag: 'event', payload: {} });
  assert.ok(fs.existsSync(dir));
  fs.rmSync(path.join(os.tmpdir(), `delta-newdir-${Date.now().toString().slice(0,-3)}00`), { recursive: true, force: true });
  fs.rmSync(dir.split('/').slice(0, -2).join('/'), { recursive: true, force: true });
});
test('delta: skipped when deltaDir is null (no crash)', async () => {
  const bus = createDataBus({ deltaDir: null });
  const r = await bus.push({ uuid: 'no-dir-u', moduleUuid: 'mod', tag: 'event', payload: {} });
  assert.ok(r.ok);
});

// ── route() HTTP handler ──────────────────────────────────────────────────────

test('route(): POST /data/push returns 200 json via res mock', async () => {
  const bus = createDataBus({});
  let status, body;
  const res = {
    headersSent: false,
    writeHead: (s) => { status = s; },
    end: (b) => { body = JSON.parse(b); },
  };
  await bus.route('POST', ['data', 'push'], { uuid: 'route-u', moduleUuid: 'mod', tag: 'event', payload: {} }, {}, res);
  assert.strictEqual(status, 200);
  assert.ok(body.ok);
});
test('route(): POST /data/push missing uuid returns 403', async () => {
  const bus = createDataBus({});
  let status;
  const res = {
    headersSent: false,
    writeHead: (s) => { status = s; },
    end: () => {},
  };
  await bus.route('POST', ['data', 'push'], { moduleUuid: 'mod', tag: 'event' }, {}, res);
  assert.strictEqual(status, 403);
});
test('route(): GET /data/delta returns ok:true, entries array', async () => {
  const dir = path.join(os.tmpdir(), `route-delta-${Date.now()}`);
  const bus = createDataBus({ deltaDir: dir });
  await bus.push({ uuid: 'rd-u', moduleUuid: 'mod', tag: 'event', payload: {} });
  let body;
  const res = {
    headersSent: false,
    writeHead: () => {},
    end: (b) => { body = JSON.parse(b); },
  };
  await bus.route('GET', ['data', 'delta'], {}, {}, res);
  assert.ok(body.ok);
  assert.ok(Array.isArray(body.entries));
  assert.ok(body.entries.length >= 1);
  fs.rmSync(dir, { recursive: true });
});
test('route(): GET /data/delta returns empty array when no dir', async () => {
  const bus = createDataBus({ deltaDir: null });
  let body;
  const res = {
    headersSent: false,
    writeHead: () => {},
    end: (b) => { body = JSON.parse(b); },
  };
  await bus.route('GET', ['data', 'delta'], {}, {}, res);
  assert.ok(body.ok);
  assert.deepStrictEqual(body.entries, []);
});
test('route(): unknown path returns 404', async () => {
  const bus = createDataBus({});
  let status;
  const res = {
    headersSent: false,
    writeHead: (s) => { status = s; },
    end: () => {},
  };
  await bus.route('GET', ['data', 'unknown-endpoint'], {}, {}, res);
  assert.strictEqual(status, 404);
});

run();
