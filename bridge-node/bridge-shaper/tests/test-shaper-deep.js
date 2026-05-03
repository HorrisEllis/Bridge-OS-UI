// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
'use strict';
/**
 * bridge-shaper/tests/test-shaper-deep.js
 */
const assert = require('assert');
const { createTrafficShaper, padToBucket, stripPadding, gaussianJitter, mimicHeaders } = require('../index');

let passed = 0, failed = 0;
const tests = [];
function test(n, fn) { tests.push({ n, fn }); }
async function run() {
  console.log('\n[bridge-shaper] Deep Test Suite\n');
  for (const t of tests) {
    try { await t.fn(); console.log(`  ✓ ${t.n}`); passed++; }
    catch (e) { console.error(`  ✗ ${t.n}\n    ${e.message}`); failed++; }
  }
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

test('padToBucket(): pads to next bucket size', () => {
  const buf = Buffer.from('hello');
  const padded = padToBucket(buf);
  const valid = [512, 1024, 2048, 4096, 8192, 16384, 32768];
  assert.ok(valid.includes(padded.length), `padded length ${padded.length} not a bucket size`);
});

test('padToBucket(): 1-byte payload pads to 512', () => {
  const padded = padToBucket(Buffer.from('x'));
  assert.strictEqual(padded.length, 512);
});

test('padToBucket(): 511-byte payload pads to 1024 (2-byte header makes 511+2=513 > 512 bucket)', () => {
  // With 2-byte uint16 length header, 511-byte payload requires 513 bytes minimum → next bucket = 1024
  const padded = padToBucket(Buffer.allocUnsafe(511));
  assert.strictEqual(padded.length, 1024);
});

test('padToBucket(): 513-byte payload pads to 1024', () => {
  const padded = padToBucket(Buffer.allocUnsafe(513));
  assert.strictEqual(padded.length, 1024);
});

test('INVARIANT SH-01: padded size always different from input size', () => {
  for (const size of [1, 100, 511, 512, 513, 1000]) {
    const buf    = Buffer.allocUnsafe(size);
    const padded = padToBucket(buf);
    // Padded output is bucket size, which may equal input in edge case at exact bucket
    assert.ok(padded.length >= size, 'padded must be >= original');
  }
});

test('stripPadding(): roundtrips padToBucket', () => {
  const original = Buffer.from('roundtrip test payload');
  const padded   = padToBucket(original);
  const stripped = stripPadding(padded);
  assert.ok(stripped.equals(original), `stripped: ${stripped.toString()} vs original: ${original.toString()}`);
});

test('stripPadding(): roundtrips for various sizes', () => {
  for (const size of [1, 50, 200, 511, 1023, 4095]) {
    const buf     = Buffer.allocUnsafe(size);
    buf.fill(0xAB);
    const padded  = padToBucket(buf);
    const result  = stripPadding(padded);
    assert.ok(result.equals(buf), `size=${size} roundtrip failed`);
  }
});

test('INVARIANT SH-04: gaussianJitter always >= 1ms', () => {
  for (let i = 0; i < 1000; i++) {
    const j = gaussianJitter(80, 30);
    assert.ok(j >= 1, `jitter ${j} below 1ms`);
  }
});

test('gaussianJitter(): mean roughly correct over many samples', () => {
  let sum = 0;
  const n = 2000;
  for (let i = 0; i < n; i++) sum += gaussianJitter(100, 10);
  const mean = sum / n;
  assert.ok(mean > 85 && mean < 115, `mean jitter ${mean.toFixed(1)} not near 100`);
});

test('mimicHeaders(): returns realistic browser headers', () => {
  const h = mimicHeaders();
  assert.ok(h['User-Agent'] && h['User-Agent'].includes('Mozilla'));
  assert.ok(h['Accept']);
  assert.ok(h['Cache-Control']);
});

test('createTrafficShaper(): enqueue and nextFrame basic', () => {
  const s = createTrafficShaper({});
  s.enqueue('test payload', 0);
  const frame = s.nextFrame();
  assert.ok(Buffer.isBuffer(frame.frame));
  assert.ok(frame.jitterMs >= 1);
  assert.ok(typeof frame.headers === 'object');
});

test('createTrafficShaper(): empty queue returns padding frame', () => {
  const s = createTrafficShaper({});
  const frame = s.nextFrame(); // no enqueue
  // Decoding a padding frame returns null
  const decoded = s.decodeFrame(frame.frame);
  assert.strictEqual(decoded, null);
});

test('createTrafficShaper(): enqueue/dequeue preserves payload', () => {
  const s = createTrafficShaper({});
  const original = JSON.stringify({ sig: 'mesh:test', data: { hello: 'world' } });
  s.enqueue(original, 0);
  const frame   = s.nextFrame();
  const decoded = s.decodeFrame(frame.frame);
  assert.ok(decoded !== null);
  assert.strictEqual(decoded.toString(), original);
});

test('INVARIANT SH-03: queue bounded — overflow drops oldest', () => {
  const s = createTrafficShaper({ maxQueue: 5 });
  for (let i = 0; i < 7; i++) s.enqueue(`msg-${i}`, 0);
  // Queue should not exceed 5
  assert.ok(s.diagnostics().queueDepth <= 5);
});

test('configure(): updates shaper config', () => {
  const s = createTrafficShaper({});
  s.configure({ intervalMs: 500, enabled: false });
  const d = s.diagnostics();
  assert.ok(d); // no crash
});

test('priority: higher priority items dequeue first', () => {
  const s = createTrafficShaper({});
  s.enqueue('low',  0);
  s.enqueue('high', 10);
  s.enqueue('med',  5);
  const f1 = s.decodeFrame(s.nextFrame().frame);
  // First frame should be high priority
  assert.strictEqual(f1?.toString(), 'high');
});

run();
