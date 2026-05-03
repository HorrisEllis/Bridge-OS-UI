// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
'use strict';
const assert = require('assert');
const { validate, validateAll, contracts } = require('../index');
const { loadOrInit }      = require('../../bridge-identity/index');
const { createIME }       = require('../../bridge-IME/index');
const { createSNGate }    = require('../../bridge-sngate/index');
const { createDataBus }   = require('../../bridge-data/index');
const { createHeartbeatManager } = require('../../bridge-heartbeat/index');
const os   = require('os');
const path = require('path');
const fs   = require('fs');

let passed = 0, failed = 0;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
async function run() {
  console.log('\n[bridge-contracts] Test Suite\n');
  for (const t of tests) {
    try { await t.fn(); console.log(`  ✓ ${t.name}`); passed++; }
    catch (e) { console.log(`  ✗ ${t.name}\n    ${e.message}`); failed++; }
  }
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

// ── Suite 1: Contract registry ────────────────────────────────────────────────

test('contracts object has expected contract names', () => {
  const names = Object.keys(contracts);
  assert.ok(names.includes('identity-to-IME'));
  assert.ok(names.includes('IME-to-sngate'));
  assert.ok(names.includes('sngate-to-adapters'));
  assert.ok(names.includes('data-to-sngate'));
  assert.ok(names.includes('mesh-to-heartbeat'));
});

test('each contract has version, provider, consumer, guarantees', () => {
  for (const [name, c] of Object.entries(contracts)) {
    assert.ok(c.version,    `${name} missing version`);
    assert.ok(c.provider,   `${name} missing provider`);
    assert.ok(c.consumer,   `${name} missing consumer`);
    assert.ok(Array.isArray(c.guarantees), `${name} guarantees must be array`);
    assert.ok(c.guarantees.length > 0, `${name} must have at least one guarantee`);
  }
});

test('validate() throws on unknown contract name', () => {
  assert.throws(() => validate('nonexistent-contract', {}), /Unknown contract/);
});

// ── Suite 2: IME-to-sngate contract ──────────────────────────────────────────

test('IME-to-sngate: valid IME passes', () => {
  const ime = createIME({ storeDir: null });
  assert.doesNotThrow(() => validate('IME-to-sngate', ime));
});

test('IME-to-sngate: missing getProfile() fails', () => {
  const badIME = { ingest: () => {}, getTrustScore: () => 5 };
  assert.throws(() => validate('IME-to-sngate', badIME), /getProfile/);
});

test('IME-to-sngate: missing ingest() fails', () => {
  const badIME = { getProfile: () => null, getTrustScore: () => 5 };
  assert.throws(() => validate('IME-to-sngate', badIME), /ingest\(\) missing/);
});

test('IME-to-sngate: getProfile() performance < 5ms per call', () => {
  const ime = createIME({ storeDir: null });
  // Pre-populate some profiles
  for (let i = 0; i < 50; i++) {
    ime.ingest({ uuid: `perf-uuid-${i}`, type: 'ssh.command', timestamp: Date.now(), payload: {} });
  }
  // Contract validation runs 100 calls and checks < 50ms total
  assert.doesNotThrow(() => validate('IME-to-sngate', ime));
});

// ── Suite 3: sngate-to-adapters contract ─────────────────────────────────────

test('sngate-to-adapters: valid gate passes', () => {
  const gate = createSNGate({ logDir: null });
  assert.doesNotThrow(() => validate('sngate-to-adapters', gate));
});

test('sngate-to-adapters: missing evaluate() fails', () => {
  const badGate = { evaluateAgentCall: () => {}, evaluateMeshHandshake: () => {} };
  assert.throws(() => validate('sngate-to-adapters', badGate), /evaluate/);
});

test('sngate-to-adapters: evaluate() returns valid decision', () => {
  const gate = createSNGate({ logDir: null });
  const r    = gate.evaluate({ type: 'test', surface: 'dev' });
  assert.ok(['allow', 'deny', 'observe'].includes(r.decision));
  assert.ok(r.score >= 0 && r.score <= 10);
});

// ── Suite 4: data-to-sngate contract ─────────────────────────────────────────

test('data-to-sngate: valid dataBus passes', () => {
  const bus = createDataBus({});
  assert.doesNotThrow(() => validate('data-to-sngate', bus));
});

test('data-to-sngate: missing push() fails', () => {
  const bad = { registerHook: () => {} };
  assert.throws(() => validate('data-to-sngate', bad), /push\(\) missing/);
});

test('data-to-sngate: missing registerHook() fails', () => {
  const bad = { push: async () => {} };
  assert.throws(() => validate('data-to-sngate', bad), /registerHook\(\) missing/);
});

// ── Suite 5: mesh-to-heartbeat contract ──────────────────────────────────────

test('mesh-to-heartbeat: valid heartbeat passes', () => {
  const hb = createHeartbeatManager({});
  assert.doesNotThrow(() => validate('mesh-to-heartbeat', hb));
});

test('mesh-to-heartbeat: missing register() fails', () => {
  const bad = { unregister: () => {}, getStatus: () => null };
  assert.throws(() => validate('mesh-to-heartbeat', bad), /register\(\) missing/);
});

// ── Suite 6: identity-to-IME contract ────────────────────────────────────────

test('identity-to-IME: valid identity module passes', () => {
  const identityModule = require('../../bridge-identity/index');
  assert.doesNotThrow(() => validate('identity-to-IME', identityModule));
});

test('identity-to-IME: missing loadOrInit() fails', () => {
  const bad = { verifyHandshake: () => {}, deriveUUID: () => {} };
  assert.throws(() => validate('identity-to-IME', bad), /loadOrInit\(\) missing/);
});

// ── Suite 7: validateAll() ────────────────────────────────────────────────────

test('validateAll() passes with all real modules', () => {
  const ime       = createIME({ storeDir: null });
  const gate      = createSNGate({ logDir: null });
  const dataBus   = createDataBus({});
  const heartbeat = createHeartbeatManager({});
  const identity  = require('../../bridge-identity/index');

  assert.doesNotThrow(() => validateAll({ ime, gate, dataBus, heartbeat, identity }));
});

test('validateAll() skips contracts with missing modules gracefully', () => {
  // Only provide gate — other contracts skipped (modules not provided)
  const gate = createSNGate({ logDir: null });
  assert.doesNotThrow(() => validateAll({ gate }));
});

test('validateAll() throws if any provided module is invalid', () => {
  const badIME = {}; // missing all methods
  assert.throws(() => validateAll({ ime: badIME }), /Contract violation/);
});

// ── Suite 8: Anti-recursion contract enforcement ──────────────────────────────

test('IME-to-sngate prohibitions include ingest() ban', () => {
  const c = contracts['IME-to-sngate'];
  assert.ok(c.prohibitions.some(p => p.includes('ingest()')));
});

test('sngate-to-adapters prohibitions include IME ingest ban', () => {
  const c = contracts['sngate-to-adapters'];
  assert.ok(c.prohibitions.some(p => p.toLowerCase().includes('ime')));
});

// ── Suite 9: Contract VERSION field ──────────────────────────────────────────

test('all contracts have semver version strings', () => {
  for (const [name, c] of Object.entries(contracts)) {
    assert.match(c.version, /^\d+\.\d+\.\d+$/, `${name} version is not semver`);
  }
});

run();
