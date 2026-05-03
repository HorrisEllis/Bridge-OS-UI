// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
'use strict';
/**
 * bridge-sngate/index.js
 * Programmable trust primitive. One engine, three adapters.
 *
 * INVARIANTS (from architecture):
 * 11. bridge-sngate is a stateless evaluator. Reads context. Never writes to IME.
 * 12. IME is read-only from sngate's perspective. IME.getProfile() only.
 * 13. Evaluation path strictly linear: identity → IME.getProfile() → sngate.evaluate() → decision
 * 14. sngate emits decisions on bus. IME listens to bus. Never direct.
 *
 * Anti-recursion: sngate → bus → IME.ingest()  (ONLY)
 *                 Never:   sngate → IME directly
 *
 * Three-state decision: allow | deny | observe
 * Score alone NEVER triggers deny. Score + matching rule triggers deny.
 */

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

// ── Default config ────────────────────────────────────────────────────────────
const DEFAULT_CONFIG = {
  gateThreshold:   5,     // fidelity score ≥ 5 = allow (when no deny rules match)
  observeThreshold: 3,    // score 3–4 = observe
  logDir:          path.join(process.cwd(), 'data', 'sngate-logs'),
  maxLogSize:      10000, // entries before rotation
  defaultMode:     'observe', // 'allow' | 'deny' | 'observe' — default when unconfigured
};

// ── Rule store (in-memory + optional disk persistence) ────────────────────────
function createRuleStore(persistPath) {
  let _rules = new Map();

  function add(rule) {
    if (!rule.id) rule.id = crypto.randomUUID();
    if (!rule.type) throw new Error('[sngate] rule.type required');
    _rules.set(rule.id, { ...rule, createdAt: Date.now() });
    _persist();
    return rule.id;
  }

  function remove(id) {
    _rules.delete(id);
    _persist();
  }

  function list(filter = {}) {
    let rules = [..._rules.values()];
    if (filter.surface) rules = rules.filter(r => !r.surface || r.surface === filter.surface);
    if (filter.type)    rules = rules.filter(r => r.type === filter.type);
    return rules;
  }

  // match() returns both the winning rule and a matchPath explaining why it won.
  // Enables the "why did this fire?" audit requirement.
  function match(evalCtx) {
    for (const rule of _rules.values()) {
      if (rule.surface && evalCtx.surface && rule.surface !== evalCtx.surface) continue;
      if (_ruleMatches(rule, evalCtx)) {
        return {
          ...rule,
          _matchPath: `${rule.type}:${rule.value} → ${rule.action || 'deny'} (surface:${rule.surface || 'any'})`,
        };
      }
    }
    return null;
  }

  // detectShadowedRules() — finds rules that can never fire because an earlier
  // rule always matches first. Returns array of { shadowedId, shadowedBy } pairs.
  // Runs at O(n²) — call from diagnostics/CLI only, not hot path.
  function detectShadowedRules() {
    const rules   = [..._rules.values()];
    const shadowed = [];
    for (let i = 1; i < rules.length; i++) {
      for (let j = 0; j < i; j++) {
        const earlier = rules[j];
        const later   = rules[i];
        if (earlier.type !== later.type) continue;
        if (earlier.surface && later.surface && earlier.surface !== later.surface) continue;
        // Same type + compatible surface: check if earlier value subsumes later
        let subsumes = false;
        if (earlier.type === 'intent') {
          // earlier prefix 'agent.' subsumes later prefix 'agent.tool_call'
          subsumes = later.value.startsWith(earlier.value) || earlier.value === later.value;
        } else if (earlier.type === 'uuid' || earlier.type === 'ip') {
          subsumes = earlier.value === later.value;
        } else if (earlier.type === 'domain') {
          subsumes = later.value.includes(earlier.value) || earlier.value === later.value;
        }
        if (subsumes) {
          shadowed.push({ shadowedId: later.id, shadowedBy: earlier.id, type: later.type, value: later.value });
        }
      }
    }
    return shadowed;
  }

  function _ruleMatches(rule, ctx) {
    const { type, payload, identity } = ctx;
    switch (rule.type) {
      case 'uuid':    return identity?.uuid === rule.value;
      case 'domain':  return payload?.domain?.includes(rule.value) || payload?.url?.includes(rule.value);
      case 'intent':  return String(type).startsWith(rule.value);
      case 'ip':      return payload?.ip === rule.value;
      case 'regex':   try { const re = (rule._compiled = rule._compiled || new RegExp(rule.value)); return re.test(ctx._payloadJson || (ctx._payloadJson = JSON.stringify(payload))); } catch { return false; }
      default:        return false;
    }
  }

  function _persist() {
    if (!persistPath) return;
    try {
      const dir = path.dirname(persistPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(persistPath, JSON.stringify([..._rules.values()], null, 2));
    } catch {}
  }

  function load() {
    if (!persistPath || !fs.existsSync(persistPath)) return;
    try {
      const rules = JSON.parse(fs.readFileSync(persistPath, 'utf8'));
      for (const r of rules) _rules.set(r.id, r);
    } catch {}
  }

  return { add, remove, list, match, load, detectShadowedRules };
}

// ── Trace log (append-only audit trail) ───────────────────────────────────────
function createTraceLog(logDir) {
  let _entries  = [];
  let _rotCount = 0;

  function append(entry) {
    _entries.push({ ...entry, id: crypto.randomUUID(), ts: Date.now() });
    if (_entries.length > 10000) _entries.shift();
    // Async write to disk
    if (logDir) setImmediate(() => _flush());
  }

  function query({ surface, decision, since, uuid } = {}) {
    return _entries.filter(e => {
      if (surface  && e.surface  !== surface)  return false;
      if (decision && e.decision !== decision) return false;
      if (since    && e.ts < since)           return false;
      if (uuid     && e.identity?.uuid !== uuid) return false;
      return true;
    });
  }

  function _flush() {
    if (!logDir) return;
    try {
      if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
      const file = path.join(logDir, `sngate-${new Date().toISOString().slice(0,10)}.jsonl`);
      const last = _entries[_entries.length - 1];
      if (last) fs.appendFileSync(file, JSON.stringify(last) + '\n');
    } catch {}
  }

  return { append, query };
}

// ── Core gate evaluation ──────────────────────────────────────────────────────
function createSNGate(cfg = {}, ime = null, busEmit = null) {
  const config     = { ...DEFAULT_CONFIG, ...cfg };
  const ruleStore  = createRuleStore(cfg.rulesPath || null);
  const traceLog   = createTraceLog(config.logDir);
  const gateId     = crypto.randomUUID();

  ruleStore.load();

  /**
   * evaluate({ type, identity, payload, context, surface })
   * → { score, decision, reason, trace, gateId }
   *
   * surface: 'dev' | 'agent' | 'mesh' | 'data'
   */
  function evaluate(evalCtx) {
    const { type, identity, payload, context = {}, surface = 'dev' } = evalCtx;

    // ── Step 1: Identity failure is absolute ──────────────────────────────
    if (identity) {
      if (identity.verified === false) {
        return _decide(0, 'deny', 'identity verification failed', evalCtx, surface);
      }
      if (identity.uuidMismatch) {
        return _decide(0, 'deny', 'UUID-publicKey mismatch — hard block', evalCtx, surface);
      }
    }

    // ── Step 2: IME profile (read-only, < 5ms) ────────────────────────────
    let imeScore   = 5; // neutral default
    let imeReasons = [];
    if (ime && identity?.uuid) {
      const profile = ime.getProfile(identity.uuid);
      if (profile) {
        imeScore   = profile.trustScore;
        imeReasons = profile.scoreReasons || [];
      }
    }

    // ── Step 3: Base fidelity from identity verification tier ─────────────
    let fidelity = imeScore;
    if (identity?.verified === true) {
      if (identity.knownUUID) fidelity = Math.min(10, fidelity + 1);
      if (identity.groupMatch) fidelity = Math.min(10, fidelity + 0.5);
    }

    // ── Step 4: Check for matching deny/allow rules ───────────────────────
    const matchedRule = ruleStore.match({ type, identity, payload, surface });

    let decision;
    let reason;

    if (matchedRule) {
      decision = matchedRule.action || 'deny';
      // _matchPath explains exactly why this rule fired — satisfies rule introspection requirement
      reason   = `rule:${matchedRule.id} | ${matchedRule._matchPath || matchedRule.type+'='+matchedRule.value}`;
    } else {
      // Score-only path: never deny — observe or allow
      // Score alone NEVER triggers deny. Rule required for deny.
      if (fidelity >= config.gateThreshold) {
        decision = 'allow';
        reason   = `score ${fidelity.toFixed(1)} ≥ ${config.gateThreshold}`;
      } else if (fidelity >= config.observeThreshold) {
        decision = 'observe';
        reason   = `score ${fidelity.toFixed(1)} between ${config.observeThreshold}–${config.gateThreshold}`;
      } else {
        decision = 'observe'; // still observe, not deny — no rule
        reason   = `score ${fidelity.toFixed(1)} < ${config.observeThreshold}, observe (no deny rule)`;
      }
    }

    const result = _decide(fidelity, decision, reason, evalCtx, surface);

    // ── Step 5: Emit decision on bus (IME listens to bus, not direct) ─────
    busEmit?.('sngate:decision', {
      gateId, surface, type, decision, score: fidelity,
      uuid: identity?.uuid, reason,
    }, decision === 'deny' ? 'WARN' : 'DEBUG');

    return result;
  }

  function _decide(score, decision, reason, ctx, surface) {
    const trace = {
      gateId,
      surface,
      type:     ctx.type,
      identity: ctx.identity ? { uuid: ctx.identity.uuid, verified: ctx.identity.verified } : null,
      score,
      decision,
      reason,
      ts: Date.now(),
    };
    traceLog.append(trace);
    return { score, decision, reason, trace, gateId };
  }

  // ── HTTP middleware (dev adapter) ─────────────────────────────────────────
  function middleware() {
    return (req, res, next) => {
      const identity = req.bridgeIdentity || null;
      const result   = evaluate({
        type:     req.method + ':' + (req.path || req.url),
        identity,
        payload:  { url: req.url, ip: req.socket?.remoteAddress },
        surface:  'dev',
      });

      req.sngate = result;

      if (result.decision === 'deny') {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Blocked', gateId: result.gateId, reason: result.reason }));
        return;
      }
      next?.();
    };
  }

  // ── Agent adapter (AI tool call gating) ──────────────────────────────────
  function evaluateAgentCall(agentUuid, toolName, params) {
    return evaluate({
      type:     'agent.tool_call',
      identity: { uuid: agentUuid, verified: !!agentUuid },
      payload:  { tool: toolName, params },
      surface:  'agent',
    });
  }

  // ── Mesh adapter (node handshake gating) ─────────────────────────────────
  function evaluateMeshHandshake(verifyResult) {
    return evaluate({
      type:     'mesh.handshake',
      identity: {
        uuid:        verifyResult.uuid,
        verified:    verifyResult.ok,
        uuidMismatch: !verifyResult.ok && verifyResult.reason?.includes('mismatch'),
      },
      payload:  { groupHint: verifyResult.groupHint },
      surface:  'mesh',
    });
  }

  // ── Data push adapter ─────────────────────────────────────────────────────
  function evaluateDataPush(senderUuid, verified, tag) {
    return evaluate({
      type:     'data.push',
      identity: { uuid: senderUuid, verified },
      payload:  { tag },
      surface:  'data',
    });
  }

  return {
    evaluate,
    middleware,
    evaluateAgentCall,
    evaluateMeshHandshake,
    evaluateDataPush,
    rules:    ruleStore,
    trace:    traceLog,
    gateId,
  };
}

// Singleton export
const SNGate = createSNGate();
module.exports = { SNGate, createSNGate };
