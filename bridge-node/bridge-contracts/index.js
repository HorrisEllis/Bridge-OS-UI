// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
'use strict';
/**
 * bridge-contracts/index.js
 * Frozen, versioned interaction contracts between modules.
 * Enforced at startup — not at runtime.
 *
 * If bridge-IME v2 ships and breaks the contract bridge-sngate depends on,
 * the system refuses to start and tells you exactly why.
 */

const contracts = {
  'identity-to-IME': {
    contract:  'identity-to-IME',
    version:   '1.0.0',
    provider:  'bridge-identity',
    consumer:  'bridge-IME',
    guarantees: [
      'loadOrInit() returns Identity with .uuid, .publicKey, .sign(), .handshake()',
      'verifyHandshake() returns { ok, uuid, publicKey, groupHint } or { ok:false, reason }',
      'UUID derived from publicKey — immutable, unforgeable',
      'Hard stop on UUID mismatch — never silent corruption',
    ],
    prohibitions: [
      'consumer may not generate new keypairs — only load or verify',
      'consumer may not modify identity.uuid directly',
    ],
    validate(identity) {
      const errs = [];
      if (typeof identity.loadOrInit !== 'function') errs.push('loadOrInit() missing');
      if (typeof identity.verifyHandshake !== 'function') errs.push('verifyHandshake() missing');
      if (typeof identity.deriveUUID !== 'function') errs.push('deriveUUID() missing');
      return errs;
    },
  },

  'IME-to-sngate': {
    contract:  'IME-to-sngate',
    version:   '1.0.0',
    provider:  'bridge-IME',
    consumer:  'bridge-sngate',
    guarantees: [
      'IME.getProfile(uuid) returns profile or null — never throws',
      'IME.getProfile(uuid) returns in < 5ms — always from cache',
      'profile.trustScore is always 0–10',
      'profile.anomalies is always present array (may be empty)',
      'profile.scoreReasons is always present array',
    ],
    prohibitions: [
      'consumer may not call IME.ingest() directly — anti-recursion invariant',
      'consumer may not write to IME state',
      'consumer may not call IME.resetBaseline()',
    ],
    validate(ime) {
      const errs = [];
      if (!ime) { errs.push('IME module is null'); return errs; }
      if (typeof ime.getProfile !== 'function')   errs.push('IME.getProfile() missing');
      if (typeof ime.ingest !== 'function')        errs.push('IME.ingest() missing');
      if (typeof ime.getTrustScore !== 'function') errs.push('IME.getTrustScore() missing');
      // Validate < 5ms performance guarantee
      const start = Date.now();
      for (let i = 0; i < 100; i++) ime.getProfile('contract-validation-probe');
      const elapsed = Date.now() - start;
      if (elapsed > 50) errs.push(`IME.getProfile() performance: 100 calls took ${elapsed}ms (must be < 5ms each)`);
      return errs;
    },
  },

  'sngate-to-adapters': {
    contract:  'sngate-to-adapters',
    version:   '1.0.0',
    provider:  'bridge-sngate',
    consumer:  'bridge-node adapters',
    guarantees: [
      'evaluate() returns { score, decision, reason, trace, gateId }',
      'decision is always "allow" | "deny" | "observe"',
      'score is always 0–10',
      'score alone never triggers deny — rule required',
      'identity failure (verified:false) always returns deny score 0',
    ],
    prohibitions: [
      'adapters may not call IME.ingest() through sngate',
      'adapters may not bypass evaluate() for any request',
    ],
    validate(gate) {
      const errs = [];
      if (!gate) { errs.push('gate module is null'); return errs; }
      if (typeof gate.evaluate !== 'function')             errs.push('gate.evaluate() missing');
      if (typeof gate.evaluateAgentCall !== 'function')    errs.push('gate.evaluateAgentCall() missing');
      if (typeof gate.evaluateMeshHandshake !== 'function') errs.push('gate.evaluateMeshHandshake() missing');
      // Test score-alone-never-denies invariant
      const result = gate.evaluate({ type: 'test', surface: 'dev' });
      if (!['allow', 'deny', 'observe'].includes(result.decision)) {
        errs.push(`evaluate() returned unknown decision: ${result.decision}`);
      }
      return errs;
    },
  },

  'data-to-sngate': {
    contract:  'data-to-sngate',
    version:   '1.0.0',
    provider:  'bridge-data',
    consumer:  'bridge-sngate (mesh adapter)',
    guarantees: [
      'push() calls gate.evaluateDataPush() before processing',
      'push() returns { ok, id, decision, fidelity } on success',
      'push() returns { ok:false, error, reason } on block',
      'Every push logged to delta ledger with verified UUID',
    ],
    prohibitions: [
      'push() may not bypass gate evaluation',
      'push() may not store full payloads — summaries and metadata only in delta',
    ],
    validate(dataBus) {
      const errs = [];
      if (!dataBus) { errs.push('dataBus is null'); return errs; }
      if (typeof dataBus.push !== 'function')         errs.push('dataBus.push() missing');
      if (typeof dataBus.registerHook !== 'function') errs.push('dataBus.registerHook() missing');
      return errs;
    },
  },


  'causal-to-bus': {
    contract:  'causal-to-bus',
    version:   '1.0.0',
    provider:  'bridge-causal',
    consumer:  'bridge-node (all modules)',
    guarantees: [
      'createCausalAuthority() returns { query, classify, diagnostics, route, kernel, wrappedEmit }',
      'wrappedEmit is transparent — all existing bus listeners fire unchanged',
      'causal:kernel:* events are never re-ingested — no feedback loop',
      'query(cql) always returns { ok, events[], total } — never throws to caller',
      'Non-fatal init — system continues if ESM import fails',
    ],
    prohibitions: [
      'bridge-causal may not call IME.ingest() directly',
      'bridge-causal may not call gate.evaluate() directly',
    ],
    validate(causal) {
      const errs = [];
      if (typeof causal.query !== 'function')       errs.push('causal.query() missing');
      if (typeof causal.classify !== 'function')     errs.push('causal.classify() missing');
      if (typeof causal.diagnostics !== 'function')  errs.push('causal.diagnostics() missing');
      if (typeof causal.wrappedEmit !== 'function')  errs.push('causal.wrappedEmit() missing');
      return errs;
    },
  },

  'trust-mesh-to-IME': {
    contract:  'trust-mesh-to-IME',
    version:   '1.0.0',
    provider:  'bridge-mesh (trust-mesh)',
    consumer:  'bridge-IME',
    guarantees: [
      'trust-mesh emits mesh:trust:update on bus — never calls IME.ingest() directly',
      'getTrustScore(uuid) returns 0–10 — IME-compatible scale',
      'getTrustScore(uuid) returns 5 (neutral) for unknown peers — never throws',
      'pulse() and propagate() are idempotent on unknown UUIDs',
    ],
    prohibitions: [
      'trust-mesh may not call IME.ingest() directly — anti-recursion',
      'trust-mesh may not call gate.evaluate() — trust-mesh is advisory only',
      'trust-mesh may not quarantine peers — bridge-sngate guides that ',
    ],
    validate(trustMesh) {
      const errs = [];
      if (typeof trustMesh.pulse !== 'function')         errs.push('trustMesh.pulse() missing');
      if (typeof trustMesh.getTrustScore !== 'function') errs.push('trustMesh.getTrustScore() missing');
      if (typeof trustMesh.diagnostics !== 'function')   errs.push('trustMesh.diagnostics() missing');
      const score = trustMesh.getTrustScore('contract-probe-unknown-uuid');
      if (typeof score !== 'number' || score < 0 || score > 10) errs.push('getTrustScore() must return 0-10 for unknown UUIDs');
      return errs;
    },
  },

  'mesh-to-heartbeat': {
    contract:  'mesh-to-heartbeat',
    version:   '1.0.0',
    provider:  'bridge-heartbeat',
    consumer:  'bridge-mesh',
    guarantees: [
      'register(uuid, healthUrl) starts monitoring',
      'unregister(uuid) stops monitoring cleanly',
      'node:degraded emitted at degradeAt missed beats',
      'node:dead emitted at deadAt missed beats + auto-unregister',
      'getStatus(uuid) returns null for unregistered nodes',
    ],
    prohibitions: [],
    validate(hb) {
      const errs = [];
      if (!hb) { errs.push('heartbeat module is null'); return errs; }
      if (typeof hb.register !== 'function')   errs.push('heartbeat.register() missing');
      if (typeof hb.unregister !== 'function') errs.push('heartbeat.unregister() missing');
      if (typeof hb.getStatus !== 'function')  errs.push('heartbeat.getStatus() missing');
      return errs;
    },
  },
};

// ── Startup validator ─────────────────────────────────────────────────────────
function validate(contractName, ...modules) {
  const contract = contracts[contractName];
  if (!contract) throw new Error(`[bridge-contracts] Unknown contract: "${contractName}"`);

  let errs;
  try {
    errs = contract.validate(...modules);
  } catch (e) {
    // Internal error during validation = contract violation
    errs = [e.message];
  }

  if (errs.length > 0) {
    throw new Error(
      `[bridge-contracts] Contract violation: "${contractName}" v${contract.version}\n` +
      errs.map(e => `  ✗ ${e}`).join('\n') + '\n' +
      `  Consumer: ${contract.consumer}\n` +
      `  Provider: ${contract.provider}`
    );
  }
  return true;
}

function validateAll(modules = {}) {
  const errors = [];
  for (const [name, contract] of Object.entries(contracts)) {
    const args = _resolveArgs(name, modules);
    if (!args) continue; // skip if modules not provided
    try {
      validate(name, ...args);
    } catch (e) {
      errors.push(e.message);
    }
  }
  if (errors.length > 0) {
    throw new Error('[bridge-contracts] Startup validation failed:\n' + errors.join('\n'));
  }
}

function _resolveArgs(name, modules) {
  switch (name) {
    case 'identity-to-IME':     return modules.identity ? [modules.identity] : null;
    case 'IME-to-sngate':       return modules.ime      ? [modules.ime]      : null;
    case 'sngate-to-adapters':  return modules.gate     ? [modules.gate]     : null;
    case 'data-to-sngate':      return modules.dataBus  ? [modules.dataBus]  : null;
    case 'mesh-to-heartbeat':   return modules.heartbeat? [modules.heartbeat]: null;
    default: return null;
  }
}

module.exports = { validate, validateAll, contracts };
