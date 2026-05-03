// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
'use strict';
/**
 * bridge-core/tests/test-core-deep.js
 * Deep test suite — SISO primitives, Bus, NodeRegistry, CalltoRegistry
 * §4.1 A system that cannot be tested cannot be trusted.
 * §1.2 Nothing silently fails.
 */

const assert = require('assert');
const { Event, Gate, Stream, StreamLog, createBus, createCalltoRegistry, createNodeRegistry, NON_DOM_CALLTOS } = require('../index');

let passed = 0, failed = 0;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
async function run() {
  console.log('\n[bridge-core] Deep Test Suite\n');
  for (const t of tests) {
    try { await t.fn(); console.log(`  ✓ ${t.name}`); passed++; }
    catch (e) { console.error(`  ✗ ${t.name}\n    ${e.message}`); failed++; }
  }
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

// ── SISO: Event ───────────────────────────────────────────────────────────────

test('Event: empty sig throws', () => {
  assert.throws(() => new Event(''), /sig must be a non-empty string/);
});
test('Event: null sig throws', () => {
  assert.throws(() => new Event(null), /sig must be a non-empty string/);
});
test('Event: is frozen — sig immutable', () => {
  const e = new Event('test', { x: 1 });
  assert.throws(() => { 'use strict'; e.sig = 'other'; }, /Cannot assign/);
});
test('Event: is frozen — data immutable', () => {
  const e = new Event('test', { x: 1 });
  assert.throws(() => { 'use strict'; e.data = {}; }, /Cannot assign/);
});
test('Event: ts is positive integer', () => {
  const before = Date.now();
  const e = new Event('ts.test');
  assert.ok(e.ts >= before && e.ts <= Date.now());
});
test('Event: preserves data payload', () => {
  const e = new Event('data.test', { a: 1, b: 'hello', c: [1, 2] });
  assert.deepStrictEqual(e.data, { a: 1, b: 'hello', c: [1, 2] });
});
test('Event: empty data defaults to {}', () => {
  const e = new Event('empty.data');
  assert.deepStrictEqual(e.data, {});
});

// ── SISO: Gate ────────────────────────────────────────────────────────────────

test('Gate: empty sig throws', () => {
  assert.throws(() => new Gate('', () => {}), /sig required/);
});
test('Gate: non-function transform throws', () => {
  assert.throws(() => new Gate('x', 'notfn'), /transform must be a function/);
});
test('Gate: null transform throws', () => {
  assert.throws(() => new Gate('x', null), /transform must be a function/);
});
test('Gate: stores sig and transform', () => {
  const fn = () => {};
  const g = new Gate('test.gate', fn);
  assert.strictEqual(g.sig, 'test.gate');
  assert.strictEqual(g.transform, fn);
});

// ── SISO: Stream ──────────────────────────────────────────────────────────────

test('Stream: pending for unregistered sig', () => {
  const s = new Stream();
  const r = s.emit(new Event('no.gate'));
  assert.strictEqual(r.status, 'pending');
  assert.ok(r.residue);
});
test('Stream: ok for registered gate', () => {
  const s = new Stream();
  s.addGate(new Gate('ok.test', d => d));
  const r = s.emit(new Event('ok.test', { x: 1 }));
  assert.strictEqual(r.status, 'ok');
});
test('Stream: transform receives data and event', () => {
  const s = new Stream();
  let capturedData, capturedEvent;
  s.addGate(new Gate('capture.test', (data, event) => { capturedData = data; capturedEvent = event; return data; }));
  s.emit(new Event('capture.test', { x: 99 }));
  assert.strictEqual(capturedData.x, 99);
  assert.ok(capturedEvent instanceof Event);
});
test('Stream: transform return value is result', () => {
  const s = new Stream();
  s.addGate(new Gate('result.test', () => ({ transformed: true })));
  const r = s.emit(new Event('result.test'));
  assert.deepStrictEqual(r.result, { transformed: true });
});
test('Stream: signature collision is hard error', () => {
  const s = new Stream();
  s.addGate(new Gate('dup.sig', () => {}));
  assert.throws(() => s.addGate(new Gate('dup.sig', () => {})), /Signature collision/);
});
test('Stream: removeGate allows re-registration', () => {
  const s = new Stream();
  s.addGate(new Gate('removable', () => {}));
  s.removeGate('removable');
  assert.doesNotThrow(() => s.addGate(new Gate('removable', () => {})));
});
test('Stream: removing nonexistent gate is safe', () => {
  const s = new Stream();
  assert.doesNotThrow(() => s.removeGate('nonexistent'));
});
test('Stream: transform error returns error status', () => {
  const s = new Stream();
  s.addGate(new Gate('err.gate', () => { throw new Error('gate boom'); }));
  const r = s.emit(new Event('err.gate'));
  assert.strictEqual(r.status, 'error');
  assert.strictEqual(r.error.message, 'gate boom');
});
test('Stream: eventCount increments on every emit (hit or miss)', () => {
  const s = new Stream();
  s.addGate(new Gate('count.gate', d => d));
  s.emit(new Event('count.gate'));
  s.emit(new Event('count.gate'));
  s.emit(new Event('no.gate.here'));
  assert.strictEqual(s.eventCount, 3);
});
test('Stream: size reflects registered gates', () => {
  const s = new Stream();
  assert.strictEqual(s.size, 0);
  s.addGate(new Gate('g1', () => {}));
  s.addGate(new Gate('g2', () => {}));
  assert.strictEqual(s.size, 2);
  s.removeGate('g1');
  assert.strictEqual(s.size, 1);
});
test('Stream: sub() shares parent log', () => {
  const log = new StreamLog('EVENTS');
  const s = new Stream(log);
  const sub = s.sub();
  sub.addGate(new Gate('sub.event', d => d));
  sub.emit(new Event('sub.event'));
  const entries = log.query({ sig: 'sub.event' });
  assert.ok(entries.length >= 1);
});
test('Stream: emit requires Event instance', () => {
  const s = new Stream();
  assert.throws(() => s.emit({ sig: 'fake', data: {} }), /emit requires an Event instance/);
});
test('Stream: multiple gates coexist, each routes independently', () => {
  const s = new Stream();
  const hits = {};
  s.addGate(new Gate('multi.a', () => { hits.a = true; }));
  s.addGate(new Gate('multi.b', () => { hits.b = true; }));
  s.emit(new Event('multi.a'));
  s.emit(new Event('multi.b'));
  assert.ok(hits.a && hits.b);
});

// ── SISO: StreamLog ───────────────────────────────────────────────────────────

test('StreamLog: OFF records nothing', () => {
  const log = new StreamLog('OFF');
  const s = new Stream(log);
  s.addGate(new Gate('log.off', d => d));
  s.emit(new Event('log.off'));
  assert.strictEqual(log.entries.length, 0);
});
test('StreamLog: EVENTS records emit/ok/pending entries', () => {
  const log = new StreamLog('EVENTS');
  const s = new Stream(log);
  s.addGate(new Gate('log.ev', d => d));
  s.emit(new Event('log.ev'));
  s.emit(new Event('log.pending.miss'));
  assert.ok(log.entries.length >= 2);
});
test('StreamLog: listener fires on each entry', () => {
  const log = new StreamLog('EVENTS');
  const fired = [];
  log.on(e => fired.push(e));
  const s = new Stream(log);
  s.addGate(new Gate('listener.ev', d => d));
  s.emit(new Event('listener.ev'));
  assert.ok(fired.length >= 1);
});
test('StreamLog: off() removes listener', () => {
  const log = new StreamLog('EVENTS');
  const fired = [];
  const fn = e => fired.push(e);
  log.on(fn);
  log.off(fn);
  const s = new Stream(log);
  s.addGate(new Gate('off.ev', d => d));
  s.emit(new Event('off.ev'));
  assert.strictEqual(fired.length, 0);
});
test('StreamLog: query filters by sig', () => {
  const log = new StreamLog('EVENTS');
  const s = new Stream(log);
  s.addGate(new Gate('q.a', d => d));
  s.addGate(new Gate('q.b', d => d));
  s.emit(new Event('q.a'));
  s.emit(new Event('q.b'));
  assert.ok(log.query({ sig: 'q.a' }).every(r => r.sig === 'q.a'));
});
test('StreamLog: query filters by status', () => {
  const log = new StreamLog('EVENTS');
  const s = new Stream(log);
  s.addGate(new Gate('qst.hit', d => d));
  s.emit(new Event('qst.hit'));
  s.emit(new Event('qst.miss'));
  const ok = log.query({ status: 'ok' });
  const pending = log.query({ status: 'pending' });
  assert.ok(ok.every(e => e.status === 'ok'));
  assert.ok(pending.every(e => e.status === 'pending'));
});
test('StreamLog: entries capped at 10000', () => {
  const log = new StreamLog('EVENTS');
  // Directly push 10001 entries to test cap
  for (let i = 0; i < 10001; i++) {
    log.observe({ sig: `cap.${i}` }, 'ok');
  }
  assert.ok(log.entries.length <= 10000);
});
test('StreamLog: setLevel changes recording behaviour', () => {
  const log = new StreamLog('EVENTS');
  log.setLevel('OFF');
  const s = new Stream(log);
  s.addGate(new Gate('setlevel.test', d => d));
  s.emit(new Event('setlevel.test'));
  assert.strictEqual(log.entries.length, 0);
});

// ── Bus ───────────────────────────────────────────────────────────────────────

test('Bus: on() triggers listener', () => {
  const bus = createBus();
  const heard = [];
  bus.on('bus:basic', d => heard.push(d));
  bus.emit('bus:basic', { x: 1 });
  assert.strictEqual(heard.length, 1);
  assert.strictEqual(heard[0].x, 1);
});
test('Bus: on() returns unsubscribe', () => {
  const bus = createBus();
  const heard = [];
  const unsub = bus.on('bus:unsub', d => heard.push(d));
  bus.emit('bus:unsub', { n: 1 });
  unsub();
  bus.emit('bus:unsub', { n: 2 });
  assert.strictEqual(heard.length, 1);
});
test('Bus: once() fires exactly once', () => {
  const bus = createBus();
  const heard = [];
  bus.once('bus:once', d => heard.push(d));
  bus.emit('bus:once', { a: 1 });
  bus.emit('bus:once', { a: 2 });
  assert.strictEqual(heard.length, 1);
});
test('Bus: off() removes specific listener', () => {
  const bus = createBus();
  const heard = [];
  const fn = d => heard.push(d);
  bus.on('bus:off', fn);
  bus.emit('bus:off', { n: 1 });
  bus.off('bus:off', fn);
  bus.emit('bus:off', { n: 2 });
  assert.strictEqual(heard.length, 1);
});
test('Bus: onAll() receives every emitted sig', () => {
  const bus = createBus();
  const sigs = [];
  bus.onAll((sig) => sigs.push(sig));
  bus.emit('bus:all.a', {});
  bus.emit('bus:all.b', {});
  assert.ok(sigs.includes('bus:all.a') && sigs.includes('bus:all.b'));
});
test('Bus: onAll() unsub stops wildcard', () => {
  const bus = createBus();
  const sigs = [];
  const unsub = bus.onAll(sig => sigs.push(sig));
  bus.emit('bus:wild.1', {});
  unsub();
  bus.emit('bus:wild.2', {});
  assert.ok(sigs.includes('bus:wild.1'));
  assert.ok(!sigs.includes('bus:wild.2'));
});
test('Bus: enriches with _busId (UUID)', () => {
  const bus = createBus();
  const heard = [];
  bus.on('bus:enrich', d => heard.push(d));
  bus.emit('bus:enrich', { val: 1 });
  assert.ok(heard[0]._busId && typeof heard[0]._busId === 'string');
  assert.ok(heard[0]._busId.length > 0);
});
test('Bus: enriches with _seq (monotonically increasing)', () => {
  const bus = createBus();
  const seqs = [];
  bus.on('bus:seq', d => seqs.push(d._seq));
  bus.emit('bus:seq', {});
  bus.emit('bus:seq', {});
  bus.emit('bus:seq', {});
  assert.ok(seqs[0] < seqs[1] && seqs[1] < seqs[2]);
});
test('Bus: enriches with _ts > 0', () => {
  const bus = createBus();
  const heard = [];
  bus.on('bus:ts', d => heard.push(d));
  bus.emit('bus:ts', {});
  assert.ok(heard[0]._ts > 0);
});
test('Bus: enriches with _sig matching emit sig', () => {
  const bus = createBus();
  const heard = [];
  bus.on('bus:sig.check', d => heard.push(d));
  bus.emit('bus:sig.check', {});
  assert.strictEqual(heard[0]._sig, 'bus:sig.check');
});
test('Bus: listener error does not crash other listeners', () => {
  const bus = createBus();
  const ok = [];
  bus.on('bus:err.safe', () => { throw new Error('listener boom'); });
  bus.on('bus:err.safe', d => ok.push(d));
  assert.doesNotThrow(() => bus.emit('bus:err.safe', { x: 1 }));
  assert.strictEqual(ok.length, 1);
});
test('Bus: multiple independent listeners on same sig', () => {
  const bus = createBus();
  const a = [], b = [], c = [];
  bus.on('bus:multi', d => a.push(d));
  bus.on('bus:multi', d => b.push(d));
  bus.on('bus:multi', d => c.push(d));
  bus.emit('bus:multi', { x: 1 });
  assert.strictEqual(a.length + b.length + c.length, 3);
});
test('Bus: original data not mutated by enrichment', () => {
  const bus = createBus();
  bus.on('bus:mutate', () => {});
  const original = { x: 42 };
  bus.emit('bus:mutate', original);
  assert.strictEqual(original.x, 42);
  assert.ok(!original._busId, 'Original object should not be mutated');
});

// ── NodeRegistry ──────────────────────────────────────────────────────────────

test('NodeRegistry: register creates record with uuid', () => {
  const reg = createNodeRegistry();
  reg.register({ uuid: 'node-a', address: '127.0.0.1', port: 3747 });
  const n = reg.get('node-a');
  assert.strictEqual(n.uuid, 'node-a');
  assert.strictEqual(n.lifecycle, 'active');
});
test('NodeRegistry: register without uuid throws', () => {
  const reg = createNodeRegistry();
  assert.throws(() => reg.register({}), /uuid required/);
});
test('NodeRegistry: double-register updates fields, does not duplicate', () => {
  const reg = createNodeRegistry();
  reg.register({ uuid: 'node-dup', address: '1.1.1.1', port: 3000 });
  reg.register({ uuid: 'node-dup', address: '2.2.2.2', port: 3001 });
  assert.strictEqual(reg.list().filter(n => n.uuid === 'node-dup').length, 1);
  assert.strictEqual(reg.get('node-dup').address, '2.2.2.2');
});
test('NodeRegistry: get() returns null for unknown uuid', () => {
  const reg = createNodeRegistry();
  assert.strictEqual(reg.get('nonexistent'), null);
});
test('NodeRegistry: seen() resets missedBeats to 0', () => {
  const reg = createNodeRegistry();
  reg.register({ uuid: 'node-seen' });
  for (let i = 0; i < 5; i++) reg.missedBeat('node-seen');
  reg.seen('node-seen');
  assert.strictEqual(reg.get('node-seen').missedBeats, 0);
});
test('NodeRegistry: seen() restores ACTIVE lifecycle', () => {
  const reg = createNodeRegistry();
  reg.register({ uuid: 'node-revive' });
  for (let i = 0; i < 4; i++) reg.missedBeat('node-revive');
  assert.strictEqual(reg.get('node-revive').lifecycle, 'degraded');
  reg.seen('node-revive');
  assert.strictEqual(reg.get('node-revive').lifecycle, 'active');
});
test('NodeRegistry: missedBeat degrades at 3', () => {
  const reg = createNodeRegistry();
  reg.register({ uuid: 'node-degrade' });
  for (let i = 0; i < 3; i++) reg.missedBeat('node-degrade');
  assert.strictEqual(reg.get('node-degrade').lifecycle, 'degraded');
});
test('NodeRegistry: missedBeat kills at 10', () => {
  const reg = createNodeRegistry();
  reg.register({ uuid: 'node-dead' });
  for (let i = 0; i < 10; i++) reg.missedBeat('node-dead');
  assert.strictEqual(reg.get('node-dead').lifecycle, 'dead');
});
test('NodeRegistry: evict() marks node as evicted', () => {
  const reg = createNodeRegistry();
  reg.register({ uuid: 'node-evict' });
  reg.evict('node-evict', 'test-reason');
  assert.strictEqual(reg.get('node-evict').lifecycle, 'evicted');
});
test('NodeRegistry: remove() deletes record entirely', () => {
  const reg = createNodeRegistry();
  reg.register({ uuid: 'node-remove' });
  reg.remove('node-remove');
  assert.strictEqual(reg.get('node-remove'), null);
});
test('NodeRegistry: list() excludes dead/evicted by default', () => {
  const reg = createNodeRegistry();
  reg.register({ uuid: 'alive' });
  reg.register({ uuid: 'dying' });
  for (let i = 0; i < 10; i++) reg.missedBeat('dying');
  const active = reg.list();
  assert.ok(!active.find(n => n.uuid === 'dying'));
  assert.ok(active.find(n => n.uuid === 'alive'));
});
test('NodeRegistry: list({ all: true }) includes all lifecycles', () => {
  const reg = createNodeRegistry();
  reg.register({ uuid: 'all-active' });
  reg.register({ uuid: 'all-dead' });
  for (let i = 0; i < 10; i++) reg.missedBeat('all-dead');
  const all = reg.list({ all: true });
  assert.ok(all.find(n => n.uuid === 'all-dead'));
});
test('NodeRegistry: updateTrust clamps 0–10', () => {
  const reg = createNodeRegistry();
  reg.register({ uuid: 'trust-node' });
  reg.updateTrust('trust-node', 999);
  assert.strictEqual(reg.get('trust-node').trustScore, 10);
  reg.updateTrust('trust-node', -99);
  assert.strictEqual(reg.get('trust-node').trustScore, 0);
});
test('NodeRegistry: diagnostics() returns correct counts', () => {
  const reg = createNodeRegistry();
  reg.register({ uuid: 'd-active' });
  reg.register({ uuid: 'd-dead' });
  for (let i = 0; i < 10; i++) reg.missedBeat('d-dead');
  const d = reg.diagnostics();
  assert.ok(d.active >= 1);
  assert.ok(d.dead >= 1);
});
test('NodeRegistry: busEmit fires on register', () => {
  const emitted = [];
  const reg = createNodeRegistry({ busEmit: (sig, data) => emitted.push({ sig, data }) });
  reg.register({ uuid: 'emit-test' });
  assert.ok(emitted.find(e => e.sig === 'node:registered'));
});
test('NodeRegistry: busEmit fires on eviction', () => {
  const emitted = [];
  const reg = createNodeRegistry({ busEmit: (sig, data) => emitted.push({ sig, data }) });
  reg.register({ uuid: 'evict-emit' });
  reg.evict('evict-emit', 'test');
  assert.ok(emitted.find(e => e.sig === 'node:evicted'));
});

// ── CalltoRegistry ────────────────────────────────────────────────────────────

test('CalltoRegistry: register returns uuid starting with ct_', () => {
  const reg = createCalltoRegistry();
  const c = reg.register({ action: 'click', selector: '#btn', origin: 'claude.ai', sessionId: 's1' });
  assert.ok(c.uuid.startsWith('ct_'));
});
test('CalltoRegistry: get returns registered callto', () => {
  const reg = createCalltoRegistry();
  const c = reg.register({ action: 'click', selector: '#btn', origin: 'x', sessionId: 's' });
  const got = reg.get(c.uuid);
  assert.strictEqual(got.action, 'click');
});
test('CalltoRegistry: get returns null for unknown uuid', () => {
  const reg = createCalltoRegistry();
  assert.strictEqual(reg.get('nonexistent-uuid'), null);
});
test('CalltoRegistry: resolve sets status to ok', () => {
  const reg = createCalltoRegistry();
  const c = reg.register({ action: 'type', selector: 'input', origin: 'x', sessionId: 's' });
  reg.resolve(c.uuid, { result: { val: 1 }, method: 'ws' });
  assert.strictEqual(reg.get(c.uuid).status, 'ok');
});
test('CalltoRegistry: resolve error sets status to error', () => {
  const reg = createCalltoRegistry();
  const c = reg.register({ action: 'type', selector: 'input', origin: 'x', sessionId: 's' });
  reg.resolve(c.uuid, { error: 'element not found', method: 'ws' });
  assert.strictEqual(reg.get(c.uuid).status, 'error');
});
test('CalltoRegistry: resolve sets executedAt timestamp', () => {
  const reg = createCalltoRegistry();
  const c = reg.register({ action: 'click', selector: 'a', origin: 'x', sessionId: 's' });
  const before = Date.now();
  reg.resolve(c.uuid, { result: {}, method: 'ws' });
  const after = Date.now();
  const ec = reg.get(c.uuid).executedAt;
  assert.ok(ec >= before && ec <= after);
});
test('CalltoRegistry: list filters by origin', () => {
  const reg = createCalltoRegistry();
  reg.register({ action: 'click', selector: '#a', origin: 'site-a', sessionId: 's1' });
  reg.register({ action: 'click', selector: '#b', origin: 'site-b', sessionId: 's2' });
  const a = reg.list({ origin: 'site-a' });
  assert.ok(a.every(c => c.origin === 'site-a'));
});
test('CalltoRegistry: list filters by sessionId', () => {
  const reg = createCalltoRegistry();
  reg.register({ action: 'click', selector: '#a', origin: 'x', sessionId: 'sess-1' });
  reg.register({ action: 'click', selector: '#b', origin: 'x', sessionId: 'sess-2' });
  const s1 = reg.list({ sessionId: 'sess-1' });
  assert.ok(s1.every(c => c.sessionId === 'sess-1'));
});
test('CalltoRegistry: list filters by status', () => {
  const reg = createCalltoRegistry();
  const c = reg.register({ action: 'click', selector: '#a', origin: 'x', sessionId: 's' });
  reg.resolve(c.uuid, { result: {}, method: 'ws' });
  const ok = reg.list({ status: 'ok' });
  assert.ok(ok.every(c => c.status === 'ok'));
});
test('CalltoRegistry: delete removes entry', () => {
  const reg = createCalltoRegistry();
  const c = reg.register({ action: 'click', selector: '#a', origin: 'x', sessionId: 's' });
  reg.delete(c.uuid);
  assert.strictEqual(reg.get(c.uuid), null);
});
test('CalltoRegistry: NON_DOM actions flagged requiresCDP', () => {
  const reg = createCalltoRegistry();
  const c = reg.register({ action: 'browser.download', selector: null, origin: 'x', sessionId: 's' });
  assert.ok(c.requiresCDP);
});
test('CalltoRegistry: DOM actions NOT flagged requiresCDP', () => {
  const reg = createCalltoRegistry();
  const c = reg.register({ action: 'click', selector: '#btn', origin: 'x', sessionId: 's' });
  assert.ok(!c.requiresCDP);
});
test('NON_DOM_CALLTOS: contains expected entries', () => {
  assert.ok(Array.isArray(NON_DOM_CALLTOS));
  const expected = ['browser.download', 'browser.permission.request', 'browser.window.create', 'browser.auth.popup'];
  for (const e of expected) assert.ok(NON_DOM_CALLTOS.includes(e), `Missing: ${e}`);
});
test('CalltoRegistry: resolve returns null for unknown uuid', () => {
  const reg = createCalltoRegistry();
  const result = reg.resolve('no-such-uuid', { result: {}, method: 'ws' });
  assert.strictEqual(result, null);
});
test('CalltoRegistry: list sorted newest-first', async () => {
  const reg = createCalltoRegistry();
  const c1 = reg.register({ action: 'click', selector: '#1', origin: 'x', sessionId: 's' });
  await new Promise(r => setTimeout(r, 5)); // ensure different ms timestamps
  const c2 = reg.register({ action: 'click', selector: '#2', origin: 'x', sessionId: 's' });
  const all = reg.list();
  const idx1 = all.findIndex(c => c.uuid === c1.uuid);
  const idx2 = all.findIndex(c => c.uuid === c2.uuid);
  assert.ok(idx2 < idx1, `Expected c2 (idx ${idx2}) before c1 (idx ${idx1})`);
});

run();
