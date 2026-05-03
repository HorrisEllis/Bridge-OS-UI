// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
'use strict';
/**
 * bridge-steg/tests/test-steg-deep.js
 */
const assert = require('assert');
const { createStegChannel } = require('../index');

let passed = 0, failed = 0;
const tests = [];
function test(n, fn) { tests.push({ n, fn }); }
async function run() {
  console.log('\n[bridge-steg] Deep Test Suite\n');
  for (const t of tests) {
    try { await t.fn(); console.log(`  ✓ ${t.n}`); passed++; }
    catch (e) { console.error(`  ✗ ${t.n}\n    ${e.message}`); failed++; }
  }
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

const sc = createStegChannel({});

test('inject/extract json: roundtrip preserves payload', () => {
  const original = 'sovereign mesh payload v3.3';
  const cover = sc.inject({ channel: 'json', payload: original, secret: 'shared-secret-1' });
  const out   = sc.extract({ channel: 'json', cover, secret: 'shared-secret-1' });
  assert.strictEqual(out.toString('utf8'), original);
});

test('inject/extract header: roundtrip preserves payload', () => {
  const original = 'onion routing header channel test';
  const cover = sc.inject({ channel: 'header', payload: original, secret: 'secret-2' });
  const out   = sc.extract({ channel: 'header', cover, secret: 'secret-2' });
  assert.strictEqual(out.toString('utf8'), original);
});

test('INVARIANT S-04: wrong secret returns null not partial plaintext', () => {
  const cover = sc.inject({ channel: 'json', payload: 'sensitive', secret: 'right-secret' });
  const out   = sc.extract({ channel: 'json', cover, secret: 'wrong-secret' });
  assert.strictEqual(out, null);
});

test('json cover: looks like telemetry (has ts, env, metrics)', () => {
  const cover = sc.inject({ channel: 'json', payload: 'hello', secret: 's' });
  assert.ok(cover.ts > 0);
  assert.ok(cover.env === 'production');
  assert.ok(typeof cover.metrics === 'object');
});

test('header cover: looks like HTTP headers (has X-Request-ID or similar)', () => {
  const cover = sc.inject({ channel: 'header', payload: 'hello', secret: 's' });
  const keys  = Object.keys(cover);
  assert.ok(keys.some(k => k.startsWith('X-')));
});

test('inject: requires payload', () => {
  assert.throws(() => sc.inject({ channel: 'json', secret: 's' }), /payload required/);
});

test('inject: requires secret', () => {
  assert.throws(() => sc.inject({ channel: 'json', payload: 'x' }), /secret required/);
});

test('long payload: roundtrips correctly (> 1000 chars)', () => {
  const original = 'X'.repeat(1200);
  const cover = sc.inject({ channel: 'json', payload: original, secret: 'long-test' });
  const out   = sc.extract({ channel: 'json', cover, secret: 'long-test' });
  assert.strictEqual(out.toString('utf8'), original);
});

test('binary payload: roundtrips correctly', () => {
  const original = Buffer.from([0x00, 0xFF, 0x7F, 0x80, 0x01, 0xFE]);
  const cover = sc.inject({ channel: 'json', payload: original, secret: 'bin-test' });
  const out   = sc.extract({ channel: 'json', cover, secret: 'bin-test' });
  assert.ok(out.equals(original));
});

test('json: different secrets produce different headers (ciphertext differs)', () => {
  const c1 = sc.inject({ channel: 'json', payload: 'same', secret: 'key1' });
  const c2 = sc.inject({ channel: 'json', payload: 'same', secret: 'key2' });
  // Headers encode the actual ciphertext — must differ for different secrets
  assert.notDeepStrictEqual(c1.headers, c2.headers);
});

run();
