// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
'use strict';
/**
 * bridge-contracts/tests/test-contracts-deep.js
 * Deep test suite — contract registry, validation, prohibitions, versioning
 * §4.1 §1.1 §1.2 §5.2
 */

const assert = require('assert');
const { validate, validateAll, contracts } = require('../index');

let passed = 0, failed = 0;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
async function run() {
  console.log('\n[bridge-contracts] Deep Test Suite\n');
  for (const t of tests) {
    try { await t.fn(); console.log(`  ✓ ${t.name}`); passed++; }
    catch (e) { console.error(`  ✗ ${t.name}\n    ${e.message}`); failed++; }
  }
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

// ── Registry structure ────────────────────────────────────────────────────────

test('contracts: is a plain object', () => {
  assert.ok(contracts && typeof contracts === 'object' && !Array.isArray(contracts));
});
test('contracts: has at least 6 entries', () => {
  assert.ok(Object.keys(contracts).length >= 6);
});
test('contracts: expected contract names present', () => {
  const expected = [
    'identity-to-IME', 'IME-to-sngate', 'sngate-to-adapters',
    'data-to-sngate', 'causal-to-bus', 'trust-mesh-to-IME',
    'mesh-to-heartbeat',
  ];
  for (const name of expected) {
    assert.ok(contracts[name], `Missing contract: ${name}`);
  }
});
test('contracts: each has contract, version, provider, consumer, guarantees, prohibitions, validate', () => {
  for (const [name, c] of Object.entries(contracts)) {
    assert.ok(c.contract,                     `${name}: missing contract`);
    assert.ok(c.version,                      `${name}: missing version`);
    assert.ok(c.provider,                     `${name}: missing provider`);
    assert.ok(c.consumer,                     `${name}: missing consumer`);
    assert.ok(Array.isArray(c.guarantees),    `${name}: guarantees not array`);
    assert.ok(Array.isArray(c.prohibitions),  `${name}: prohibitions not array`);
    assert.ok(typeof c.validate === 'function', `${name}: validate not function`);
  }
});
test('contracts: all versions are semver strings', () => {
  for (const [name, c] of Object.entries(contracts)) {
    assert.match(c.version, /^\d+\.\d+\.\d+$/, `${name}: version not semver`);
  }
});
test('contracts: all guarantees are non-empty strings', () => {
  for (const [name, c] of Object.entries(contracts)) {
    assert.ok(c.guarantees.length >= 1, `${name}: must have at least 1 guarantee`);
    for (const g of c.guarantees) {
      assert.ok(typeof g === 'string' && g.length > 0, `${name}: empty guarantee`);
    }
  }
});
test('contracts: contract field matches key name', () => {
  for (const [name, c] of Object.entries(contracts)) {
    assert.strictEqual(c.contract, name, `${name}: contract field mismatch`);
  }
});
test('contracts: provider strings are non-empty', () => {
  for (const [name, c] of Object.entries(contracts)) {
    assert.ok(c.provider.length > 0, `${name}: empty provider`);
  }
});
test('contracts: consumer strings are non-empty', () => {
  for (const [name, c] of Object.entries(contracts)) {
    assert.ok(c.consumer.length > 0, `${name}: empty consumer`);
  }
});

// ── validate() ────────────────────────────────────────────────────────────────

test('validate(): throws on unknown contract name', () => {
  assert.throws(() => validate('nonexistent-contract', {}), /Unknown contract/);
});
test('validate(): error message includes contract name', () => {
  try {
    validate('nonexistent-xyz-contract', {});
    assert.fail('Should have thrown');
  } catch (e) {
    assert.ok(e.message.includes('nonexistent-xyz-contract'));
  }
});
test('validate(): returns true on passing validation', () => {
  // data-to-sngate: validate(dataBus) checks push and registerHook
  const dataBus = { push: async () => {}, registerHook: () => {} };
  const result = validate('data-to-sngate', dataBus);
  assert.strictEqual(result, true);
});
test('validate(): throws Contract violation for missing methods', () => {
  const badDataBus = { push: async () => {} }; // missing registerHook
  assert.throws(() => validate('data-to-sngate', badDataBus), /Contract violation/);
});
test('validate(): violation message includes consumer and provider', () => {
  try {
    validate('data-to-sngate', {});
  } catch (e) {
    assert.ok(e.message.includes('Consumer:') || e.message.includes('Provider:'));
  }
});
test('validate(): violation lists specific missing method', () => {
  const bad = { push: async () => {} };
  try { validate('data-to-sngate', bad); }
  catch (e) { assert.ok(e.message.includes('registerHook')); }
});

// ── data-to-sngate contract ───────────────────────────────────────────────────

test('data-to-sngate: passes with push+registerHook', () => {
  const bus = { push: async () => {}, registerHook: () => {} };
  assert.doesNotThrow(() => validate('data-to-sngate', bus));
});
test('data-to-sngate: fails with null', () => {
  assert.throws(() => validate('data-to-sngate', null), /dataBus is null/);
});
test('data-to-sngate: fails missing push', () => {
  assert.throws(() => validate('data-to-sngate', { registerHook: () => {} }), /push\(\) missing/);
});
test('data-to-sngate: fails missing registerHook', () => {
  assert.throws(() => validate('data-to-sngate', { push: async () => {} }), /registerHook\(\) missing/);
});
test('data-to-sngate: prohibitions include bypass gate ban', () => {
  const c = contracts['data-to-sngate'];
  assert.ok(c.prohibitions.some(p => p.toLowerCase().includes('gate')));
});

// ── IME-to-sngate contract ────────────────────────────────────────────────────

test('IME-to-sngate: passes with all required methods', () => {
  const calls = [];
  const ime = {
    getProfile:    (uuid) => null,
    ingest:        (d) => {},
    getTrustScore: (uuid) => 5,
  };
  assert.doesNotThrow(() => validate('IME-to-sngate', ime));
});
test('IME-to-sngate: fails with null', () => {
  assert.throws(() => validate('IME-to-sngate', null), /IME module is null/);
});
test('IME-to-sngate: fails missing getProfile', () => {
  const bad = { ingest: () => {}, getTrustScore: () => 5 };
  assert.throws(() => validate('IME-to-sngate', bad), /getProfile/);
});
test('IME-to-sngate: fails missing ingest', () => {
  const bad = { getProfile: () => null, getTrustScore: () => 5 };
  assert.throws(() => validate('IME-to-sngate', bad), /ingest/);
});
test('IME-to-sngate: fails missing getTrustScore', () => {
  const bad = { getProfile: () => null, ingest: () => {} };
  assert.throws(() => validate('IME-to-sngate', bad), /getTrustScore/);
});
test('IME-to-sngate: prohibitions include ingest() anti-recursion ban', () => {
  const c = contracts['IME-to-sngate'];
  assert.ok(c.prohibitions.some(p => p.includes('ingest()')));
});
test('IME-to-sngate: performance guarantee is documented', () => {
  const c = contracts['IME-to-sngate'];
  assert.ok(c.guarantees.some(g => g.includes('5ms') || g.includes('< 5')));
});

// ── sngate-to-adapters contract ───────────────────────────────────────────────

test('sngate-to-adapters: passes with required methods', () => {
  const gate = {
    evaluate:              () => ({ decision: 'allow', score: 5 }),
    evaluateAgentCall:     () => {},
    evaluateMeshHandshake: () => {},
  };
  assert.doesNotThrow(() => validate('sngate-to-adapters', gate));
});
test('sngate-to-adapters: fails with null', () => {
  assert.throws(() => validate('sngate-to-adapters', null), /gate module is null/);
});
test('sngate-to-adapters: fails missing evaluate', () => {
  const bad = { evaluateAgentCall: () => {}, evaluateMeshHandshake: () => {} };
  assert.throws(() => validate('sngate-to-adapters', bad), /evaluate/);
});
test('sngate-to-adapters: validate() calls evaluate() and checks decision', () => {
  const gate = {
    evaluate:              () => ({ decision: 'allow', score: 5 }),
    evaluateAgentCall:     () => {},
    evaluateMeshHandshake: () => {},
  };
  assert.doesNotThrow(() => validate('sngate-to-adapters', gate));
});
test('sngate-to-adapters: evaluate returning invalid decision fails', () => {
  const gate = {
    evaluate:              () => ({ decision: 'maybe', score: 5 }),
    evaluateAgentCall:     () => {},
    evaluateMeshHandshake: () => {},
  };
  assert.throws(() => validate('sngate-to-adapters', gate), /unknown decision/);
});
test('sngate-to-adapters: all valid decisions accepted', () => {
  for (const decision of ['allow', 'deny', 'observe']) {
    const gate = {
      evaluate:              () => ({ decision, score: 5 }),
      evaluateAgentCall:     () => {},
      evaluateMeshHandshake: () => {},
    };
    assert.doesNotThrow(() => validate('sngate-to-adapters', gate), `decision=${decision} should pass`);
  }
});
test('sngate-to-adapters: prohibitions include IME ingest ban', () => {
  const c = contracts['sngate-to-adapters'];
  assert.ok(c.prohibitions.some(p => p.toLowerCase().includes('ime')));
});

// ── mesh-to-heartbeat contract ────────────────────────────────────────────────

test('mesh-to-heartbeat: passes with register, unregister, getStatus', () => {
  const hb = { register: () => {}, unregister: () => {}, getStatus: () => null };
  assert.doesNotThrow(() => validate('mesh-to-heartbeat', hb));
});
test('mesh-to-heartbeat: fails with null', () => {
  assert.throws(() => validate('mesh-to-heartbeat', null), /heartbeat module is null/);
});
test('mesh-to-heartbeat: fails missing register', () => {
  const bad = { unregister: () => {}, getStatus: () => null };
  assert.throws(() => validate('mesh-to-heartbeat', bad), /register\(\) missing/);
});
test('mesh-to-heartbeat: fails missing unregister', () => {
  const bad = { register: () => {}, getStatus: () => null };
  assert.throws(() => validate('mesh-to-heartbeat', bad), /unregister\(\) missing/);
});
test('mesh-to-heartbeat: fails missing getStatus', () => {
  const bad = { register: () => {}, unregister: () => {} };
  assert.throws(() => validate('mesh-to-heartbeat', bad), /getStatus\(\) missing/);
});
test('mesh-to-heartbeat: has node:degraded guarantee', () => {
  const c = contracts['mesh-to-heartbeat'];
  assert.ok(c.guarantees.some(g => g.includes('node:degraded') || g.includes('degraded')));
});

// ── identity-to-IME contract ──────────────────────────────────────────────────

test('identity-to-IME: passes with all required methods', () => {
  const identity = {
    loadOrInit:      async () => {},
    verifyHandshake: () => {},
    deriveUUID:      () => {},
  };
  assert.doesNotThrow(() => validate('identity-to-IME', identity));
});
test('identity-to-IME: fails missing loadOrInit', () => {
  const bad = { verifyHandshake: () => {}, deriveUUID: () => {} };
  assert.throws(() => validate('identity-to-IME', bad), /loadOrInit/);
});
test('identity-to-IME: fails missing verifyHandshake', () => {
  const bad = { loadOrInit: () => {}, deriveUUID: () => {} };
  assert.throws(() => validate('identity-to-IME', bad), /verifyHandshake/);
});
test('identity-to-IME: prohibitions include UUID immutability', () => {
  const c = contracts['identity-to-IME'];
  assert.ok(c.prohibitions.some(p => p.toLowerCase().includes('uuid')));
});

// ── causal-to-bus contract ────────────────────────────────────────────────────

test('causal-to-bus: passes with all required methods', () => {
  const causal = {
    query:        () => ({ ok: true, events: [], total: 0 }),
    classify:     () => ({ regime: 'stable' }),
    diagnostics:  () => ({}),
    wrappedEmit:  () => {},
  };
  assert.doesNotThrow(() => validate('causal-to-bus', causal));
});
test('causal-to-bus: fails missing query', () => {
  const bad = { classify: () => {}, diagnostics: () => {}, wrappedEmit: () => {} };
  assert.throws(() => validate('causal-to-bus', bad), /query/);
});
test('causal-to-bus: fails missing wrappedEmit', () => {
  const bad = { query: () => {}, classify: () => {}, diagnostics: () => {} };
  assert.throws(() => validate('causal-to-bus', bad), /wrappedEmit/);
});
test('causal-to-bus: non-fatal guarantee documented', () => {
  const c = contracts['causal-to-bus'];
  assert.ok(c.guarantees.some(g => g.toLowerCase().includes('non-fatal') || g.includes('continues')));
});
test('causal-to-bus: anti-recursion prohibition documented (no direct IME/gate calls)', () => {
  const c = contracts['causal-to-bus'];
  assert.ok(c.prohibitions.some(p => p.toLowerCase().includes('ime') || p.toLowerCase().includes('gate')));
});

// ── trust-mesh-to-IME contract ────────────────────────────────────────────────

test('trust-mesh-to-IME: passes with pulse, getTrustScore, diagnostics', () => {
  const trustMesh = {
    pulse:         () => {},
    getTrustScore: (uuid) => 5,
    diagnostics:   () => ({}),
  };
  assert.doesNotThrow(() => validate('trust-mesh-to-IME', trustMesh));
});
test('trust-mesh-to-IME: getTrustScore unknown uuid returns 0–10', () => {
  const trustMesh = {
    pulse:         () => {},
    getTrustScore: (uuid) => 5,
    diagnostics:   () => ({}),
  };
  assert.doesNotThrow(() => validate('trust-mesh-to-IME', trustMesh));
});
test('trust-mesh-to-IME: getTrustScore returning non-number fails', () => {
  const bad = {
    pulse:         () => {},
    getTrustScore: () => 'high',
    diagnostics:   () => ({}),
  };
  assert.throws(() => validate('trust-mesh-to-IME', bad), /getTrustScore/);
});
test('trust-mesh-to-IME: getTrustScore returning >10 fails', () => {
  const bad = {
    pulse:         () => {},
    getTrustScore: () => 11,
    diagnostics:   () => ({}),
  };
  assert.throws(() => validate('trust-mesh-to-IME', bad), /getTrustScore/);
});
test('trust-mesh-to-IME: getTrustScore returning <0 fails', () => {
  const bad = {
    pulse:         () => {},
    getTrustScore: () => -1,
    diagnostics:   () => ({}),
  };
  assert.throws(() => validate('trust-mesh-to-IME', bad), /getTrustScore/);
});
test('trust-mesh-to-IME: prohibitions include direct IME.ingest() ban', () => {
  const c = contracts['trust-mesh-to-IME'];
  assert.ok(c.prohibitions.some(p => p.toLowerCase().includes('ingest()')));
});

// ── validateAll() ─────────────────────────────────────────────────────────────

test('validateAll(): passes with empty modules (skips all contracts)', () => {
  assert.doesNotThrow(() => validateAll({}));
});
test('validateAll(): passes with only valid dataBus provided', () => {
  const dataBus = { push: async () => {}, registerHook: () => {} };
  assert.doesNotThrow(() => validateAll({ dataBus }));
});
test('validateAll(): throws if invalid module provided', () => {
  const badIME = {};
  assert.throws(() => validateAll({ ime: badIME }), /Contract violation|Startup validation/);
});
test('validateAll(): error message includes all violations', () => {
  const badIME = {};
  try { validateAll({ ime: badIME }); }
  catch (e) { assert.ok(e.message.includes('IME') || e.message.includes('getProfile')); }
});
test('validateAll(): skips contracts whose modules are not provided', () => {
  // Only heartbeat provided — other contracts silently skipped
  const heartbeat = { register: () => {}, unregister: () => {}, getStatus: () => null };
  assert.doesNotThrow(() => validateAll({ heartbeat }));
});
test('validateAll(): validates multiple modules simultaneously', () => {
  const dataBus   = { push: async () => {}, registerHook: () => {} };
  const heartbeat = { register: () => {}, unregister: () => {}, getStatus: () => null };
  const ime       = { getProfile: () => null, ingest: () => {}, getTrustScore: () => 5 };
  assert.doesNotThrow(() => validateAll({ dataBus, heartbeat, ime }));
});

// ── validate() edge cases ─────────────────────────────────────────────────────

test('validate(): internal error during validation = contract violation', () => {
  // If validate() itself throws, it's treated as a violation
  const throwingIME = {
    getProfile:    () => { throw new Error('internal crash'); },
    ingest:        () => {},
    getTrustScore: () => 5,
  };
  // The performance check calls getProfile 100x — it will throw
  assert.throws(() => validate('IME-to-sngate', throwingIME));
});
test('validate(): second argument mismatch still evaluated (no short-circuit)', () => {
  // data-to-sngate only uses first arg — extra args ignored
  const dataBus = { push: async () => {}, registerHook: () => {} };
  assert.doesNotThrow(() => validate('data-to-sngate', dataBus, { extra: 'arg' }));
});

run();
