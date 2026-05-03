// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
'use strict';
const assert = require('assert');
const { Event, Gate, Stream, StreamLog, createBus, createCalltoRegistry, createNodeRegistry, NON_DOM_CALLTOS } = require('../index');

let passed = 0, failed = 0;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
async function run() {
  console.log('\n[bridge-core] Test Suite\n');
  for (const t of tests) {
    try { await t.fn(); console.log(`  ✓ ${t.name}`); passed++; }
    catch (e) { console.log(`  ✗ ${t.name}\n    ${e.message}`); failed++; }
  }
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

// ── Suite 1: SISO Event ───────────────────────────────────────────────────────

test('Event requires non-empty sig', () => {
  assert.throws(() => new Event(''), /sig must be a non-empty string/);
  assert.throws(() => new Event(null), /sig must be a non-empty string/);
});

test('Event is frozen (immutable)', () => {
  const e = new Event('test', { x: 1 });
  assert.throws(() => { e.sig = 'other'; }, /Cannot assign/);
});

test('Event has ts', () => {
  const e = new Event('test.sig', { val: 42 });
  assert.ok(e.ts > 0);
  assert.strictEqual(e.sig, 'test.sig');
  assert.deepStrictEqual(e.data, { val: 42 });
});

// ── Suite 2: SISO Gate ────────────────────────────────────────────────────────

test('Gate requires sig and transform function', () => {
  assert.throws(() => new Gate('', () => {}), /sig required/);
  assert.throws(() => new Gate('x', 'notfn'), /transform must be a function/);
});

// ── Suite 3: SISO Stream ──────────────────────────────────────────────────────

test('Stream emits pending for unregistered sig', () => {
  const s = new Stream();
  const r = s.emit(new Event('unregistered'));
  assert.strictEqual(r.status, 'pending');
});

test('Stream routes to registered gate', () => {
  const s = new Stream();
  let called = false;
  s.addGate(new Gate('test.event', (data) => { called = true; return data; }));
  const r = s.emit(new Event('test.event', { x: 1 }));
  assert.strictEqual(r.status, 'ok');
  assert.ok(called);
});

test('Stream signature collision is hard error', () => {
  const s = new Stream();
  s.addGate(new Gate('dup.sig', () => {}));
  assert.throws(() => s.addGate(new Gate('dup.sig', () => {})), /Signature collision/);
});

test('Stream removeGate allows re-registration', () => {
  const s = new Stream();
  s.addGate(new Gate('removable', () => {}));
  s.removeGate('removable');
  assert.doesNotThrow(() => s.addGate(new Gate('removable', () => {})));
});

test('Stream transform error returns error status', () => {
  const s = new Stream();
  s.addGate(new Gate('error.event', () => { throw new Error('boom'); }));
  const r = s.emit(new Event('error.event'));
  assert.strictEqual(r.status, 'error');
  assert.ok(r.error.message === 'boom');
});

test('Stream sub-stream shares parent log', () => {
  const log = new StreamLog('EVENTS');
  const s   = new Stream(log);
  const sub = s.sub();
  sub.addGate(new Gate('sub.event', d => d));
  sub.emit(new Event('sub.event'));
  const entries = log.query({ sig: 'sub.event' });
  assert.ok(entries.length >= 1);
});

test('Stream eventCount increments', () => {
  const s = new Stream();
  s.addGate(new Gate('count.test', d => d));
  s.emit(new Event('count.test'));
  s.emit(new Event('count.test'));
  assert.strictEqual(s.eventCount, 2);
});

// ── Suite 4: StreamLog ────────────────────────────────────────────────────────

test('StreamLog OFF level records nothing', () => {
  const log = new StreamLog('OFF');
  const s   = new Stream(log);
  s.addGate(new Gate('log.test', d => d));
  s.emit(new Event('log.test'));
  assert.strictEqual(log.entries.length, 0);
});

test('StreamLog EVENTS records emit/ok/pending', () => {
  const log = new StreamLog('EVENTS');
  const s   = new Stream(log);
  s.addGate(new Gate('log.ok', d => d));
  s.emit(new Event('log.ok'));
  s.emit(new Event('log.pending.unregistered'));
  assert.ok(log.entries.length >= 2);
});

test('StreamLog listener fires on each entry', () => {
  const log   = new StreamLog('EVENTS');
  const fired = [];
  log.on(e => fired.push(e));
  const s = new Stream(log);
  s.addGate(new Gate('listener.test', d => d));
  s.emit(new Event('listener.test'));
  assert.ok(fired.length >= 1);
});

test('StreamLog query filters by sig', () => {
  const log = new StreamLog('EVENTS');
  const s   = new Stream(log);
  s.addGate(new Gate('query.a', d => d));
  s.addGate(new Gate('query.b', d => d));
  s.emit(new Event('query.a'));
  s.emit(new Event('query.b'));
  const results = log.query({ sig: 'query.a' });
  assert.ok(results.every(r => r.sig === 'query.a'));
});

// ── Suite 5: Bus ──────────────────────────────────────────────────────────────

test('bus.emit() triggers on() listener', () => {
  const bus   = createBus();
  const heard = [];
  bus.on('test:event', (data) => heard.push(data));
  bus.emit('test:event', { x: 1 });
  assert.strictEqual(heard.length, 1);
  assert.strictEqual(heard[0].x, 1);
});

test('bus.on() returns unsubscribe function', () => {
  const bus   = createBus();
  const heard = [];
  const unsub = bus.on('unsub:test', (d) => heard.push(d));
  bus.emit('unsub:test', { n: 1 });
  unsub();
  bus.emit('unsub:test', { n: 2 });
  assert.strictEqual(heard.length, 1);
});

test('bus.once() fires exactly once', () => {
  const bus   = createBus();
  const heard = [];
  bus.once('once:test', (d) => heard.push(d));
  bus.emit('once:test', { n: 1 });
  bus.emit('once:test', { n: 2 });
  assert.strictEqual(heard.length, 1);
});

test('bus.onAll() receives every event', () => {
  const bus   = createBus();
  const sigs  = [];
  bus.onAll((sig) => sigs.push(sig));
  bus.emit('event.a', {});
  bus.emit('event.b', {});
  assert.ok(sigs.includes('event.a'));
  assert.ok(sigs.includes('event.b'));
});

test('bus enriches events with _busId, _seq, _ts', () => {
  const bus   = createBus();
  const heard = [];
  bus.on('enrich:test', (d) => heard.push(d));
  bus.emit('enrich:test', { val: 1 });
  assert.ok(heard[0]._busId);
  assert.ok(typeof heard[0]._seq === 'number');
  assert.ok(heard[0]._ts > 0);
});

test('bus listener error does not crash other listeners', () => {
  const bus = createBus();
  const ok  = [];
  bus.on('err:test', () => { throw new Error('listener boom'); });
  bus.on('err:test', (d) => ok.push(d));
  assert.doesNotThrow(() => bus.emit('err:test', { x: 1 }));
  assert.strictEqual(ok.length, 1);
});

// ── Suite 6: Callto Registry ──────────────────────────────────────────────────

test('callto register assigns uuid', () => {
  const reg = createCalltoRegistry();
  const c   = reg.register({ action: 'click', selector: '#btn', origin: 'claude.ai', sessionId: 's1' });
  assert.ok(c.uuid.startsWith('ct_'));
});

test('callto get/resolve works', () => {
  const reg = createCalltoRegistry();
  const c   = reg.register({ action: 'type', selector: 'input', origin: 'claude.ai', sessionId: 's1' });
  reg.resolve(c.uuid, { result: { ok: true }, method: 'ws' });
  const r = reg.get(c.uuid);
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.method, 'ws');
});

test('callto list filters by origin', () => {
  const reg = createCalltoRegistry();
  reg.register({ action: 'click', selector: '#a', origin: 'site-a.com', sessionId: 's1' });
  reg.register({ action: 'click', selector: '#b', origin: 'site-b.com', sessionId: 's2' });
  const a = reg.list({ origin: 'site-a.com' });
  assert.ok(a.every(c => c.origin === 'site-a.com'));
});

test('NON_DOM calltos flagged as requiresCDP', () => {
  const reg = createCalltoRegistry();
  const c   = reg.register({ action: 'browser.download', selector: null, origin: 'x', sessionId: 's' });
  assert.ok(c.requiresCDP);
});

test('DOM calltos not flagged as requiresCDP', () => {
  const reg = createCalltoRegistry();
  const c   = reg.register({ action: 'click', selector: '#btn', origin: 'x', sessionId: 's' });
  assert.ok(!c.requiresCDP);
});

test('NON_DOM_CALLTOS list is populated', () => {
  assert.ok(Array.isArray(NON_DOM_CALLTOS));
  assert.ok(NON_DOM_CALLTOS.includes('browser.download'));
  assert.ok(NON_DOM_CALLTOS.includes('browser.auth.popup'));
});

// ── Suite 7: Node Registry ────────────────────────────────────────────────────

test('node register and get', () => {
  const reg  = createNodeRegistry();
  const uuid = 'node-test-uuid';
  reg.register({ uuid, address: '127.0.0.1', port: 3747 });
  const n = reg.get(uuid);
  assert.strictEqual(n.uuid, uuid);
  assert.ok(n.healthy);
});

test('missedBeat marks unhealthy at 10 misses', () => {
  const reg  = createNodeRegistry();
  const uuid = 'beat-test';
  reg.register({ uuid });
  for (let i = 0; i < 10; i++) reg.missedBeat(uuid);
  assert.ok(!reg.get(uuid).healthy);
});

test('seen() resets missedBeats', () => {
  const reg  = createNodeRegistry();
  const uuid = 'seen-test';
  reg.register({ uuid });
  for (let i = 0; i < 5; i++) reg.missedBeat(uuid);
  reg.seen(uuid);
  assert.strictEqual(reg.get(uuid).missedBeats, 0);
});

test('updateTrust clamps 0–10', () => {
  const reg  = createNodeRegistry();
  const uuid = 'trust-clamp';
  reg.register({ uuid });
  reg.updateTrust(uuid, 999);
  assert.strictEqual(reg.get(uuid).trustScore, 10);
  reg.updateTrust(uuid, -5);
  assert.strictEqual(reg.get(uuid).trustScore, 0);
});

run();
