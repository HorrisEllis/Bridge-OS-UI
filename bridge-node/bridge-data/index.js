// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
'use strict';
/**
 * bridge-data/index.js
 * Universal data intake pipeline.
 *
 * Anything can be pushed through bridge-data.
 * Every push: identity verified → sngate evaluated → logged → callto hooks fired.
 *
 * POST /data/push
 * {
 *   uuid:       sender UUID with network suffix,
 *   moduleUuid: which module is sending,
 *   payload:    anything,
 *   tag:        "sensor|event|metric|log|voice|cookie|dom|callto-result",
 *   sig:        signature of (uuid + ts + tag),
 * }
 *
 * This is how bridge-plugin feeds captured browser data back.
 * This is how Guardian feeds URCK events back.
 * Universal intake — any data, any source, gated and logged.
 */

'use strict';

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

function createDataBus({ gate = null, ime = null, busEmit = null, deltaDir = null } = {}) {

  // ── Callto hook registry ──────────────────────────────────────────────────
  // Any module can register: "when you receive data from moduleUuid X, call me"
  const _hooks = new Map();  // moduleUuid → Set<fn>

  function registerHook(moduleUuid, fn) {
    if (!_hooks.has(moduleUuid)) _hooks.set(moduleUuid, new Set());
    _hooks.get(moduleUuid).add(fn);
    return () => _hooks.get(moduleUuid)?.delete(fn); // unsubscribe
  }

  // ── Delta log (append-only, disk) ─────────────────────────────────────────
  function _writeDelta(entry) {
    if (!deltaDir) return;
    try {
      if (!fs.existsSync(deltaDir)) fs.mkdirSync(deltaDir, { recursive: true });
      const file = path.join(deltaDir, `delta-${new Date().toISOString().slice(0,10)}.jsonl`);
      fs.appendFileSync(file, JSON.stringify(entry) + '\n');
    } catch {}
  }

  // ── Push handler ──────────────────────────────────────────────────────────
  async function push({ uuid, moduleUuid, payload, tag = 'event', sig = null, ts = null, _localVerified = false } = {}) {
    if (!uuid) return { ok: false, error: 'uuid required' };

    const pushTs  = ts || Date.now();
    const pushId  = 'dp_' + crypto.randomBytes(8).toString('hex');

    // ── Step 1: Verify sender signature (if provided) ──────────────────────
    // _localVerified: set by boot.js for same-machine pushes (127.0.0.1)
    // sig: cryptographic verification path (for remote/external pushes)
    let verified = _localVerified;
    if (!verified && sig) {
      // Signature is over: uuid + pushTs + tag
      // Real verify needs sender's publicKey — wired in mesh handshake path
      verified = true; // Placeholder — full implementation in bridge-mesh phase
    }

    const identity = { uuid, verified, knownUUID: verified };

    // ── Step 2: SNGate evaluation ──────────────────────────────────────────
    let gateResult = { decision: 'allow', score: 5, reason: 'no gate configured' };
    if (gate) {
      gateResult = gate.evaluateDataPush(uuid, verified, tag);
    }

    if (gateResult.decision === 'deny') {
      busEmit?.('data:blocked', { _uuid: uuid, uuid, moduleUuid, tag, reason: gateResult.reason }, 'WARN');
      return { ok: false, error: 'blocked', gateId: gateResult.gateId, reason: gateResult.reason };
    }

    // ── Step 3: IME ingestion (behavioral tracking) ────────────────────────
    ime?.ingest({
      uuid,
      type:      'data.push',
      timestamp: pushTs,
      payload:   { source: moduleUuid, tag },
    });

    // ── Step 4: Delta log ──────────────────────────────────────────────────
    const deltaEntry = {
      id:         pushId,
      ts:         pushTs,
      uuid,
      moduleUuid: moduleUuid || null,
      tag,
      fidelity:   gateResult.score,
      decision:   gateResult.decision,
      payloadSize: JSON.stringify(payload || {}).length,
    };
    _writeDelta(deltaEntry);

    // ── Step 5: Bus emit ───────────────────────────────────────────────────
    busEmit?.('data:received', {
      _uuid: uuid,
      id:    pushId,
      uuid,
      moduleUuid,
      tag,
      fidelity: gateResult.score,
      decision: gateResult.decision,
    }, 'INFO');

    // ── Step 6: Callto hooks ───────────────────────────────────────────────
    if (moduleUuid && _hooks.has(moduleUuid)) {
      const hookData = { id: pushId, uuid, moduleUuid, tag, payload, ts: pushTs, fidelity: gateResult.score };
      for (const fn of _hooks.get(moduleUuid)) {
        try { fn(hookData); } catch (e) {
          console.error('[bridge-data] hook error:', e.message);
        }
      }
    }

    return {
      ok:        true,
      id:        pushId,
      decision:  gateResult.decision,
      fidelity:  gateResult.score,
    };
  }

  // ── HTTP route handler ─────────────────────────────────────────────────────
  async function route(method, urlParts, body, req, res) {
    const _json = (status, obj) => {
      if (res.headersSent) return;
      const d = JSON.stringify(obj);
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': 'http://localhost:' + (process.env.NEXUS_PORT || 3747),
      });
      res.end(d);
    };

    // POST /data/push
    if (method === 'POST' && urlParts[1] === 'push') {
      const result = await push(body || {});
      return _json(result.ok ? 200 : 403, result);
    }

    // GET /data/delta — recent delta entries
    if (method === 'GET' && urlParts[1] === 'delta') {
      if (!deltaDir || !fs.existsSync(deltaDir)) return _json(200, { ok: true, entries: [] });
      const today = new Date().toISOString().slice(0, 10);
      const file  = path.join(deltaDir, `delta-${today}.jsonl`);
      if (!fs.existsSync(file)) return _json(200, { ok: true, entries: [] });
      const lines   = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
      const entries = lines.slice(-100).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      return _json(200, { ok: true, count: entries.length, entries });
    }

    return _json(404, { ok: false, error: 'Unknown data endpoint' });
  }

  return { push, registerHook, route };
}

module.exports = { createDataBus };
