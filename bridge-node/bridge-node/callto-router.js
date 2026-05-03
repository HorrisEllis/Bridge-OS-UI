// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
'use strict';
/**
 * bridge-node/callto-router.js
 * Callto execution priority stack.
 *
 * Priority 1: Userscript WebSocket (Guardian/Tampermonkey) — primary
 * Priority 2: ErosmancerOS CDP — fallback when no WS session
 * Priority 3: Playwright — EXPLICIT ONLY, never auto-invoked
 *
 * INVARIANTS:
 * - Userscript WS is always attempted first if a matching session exists.
 * - NON_DOM_CALLTOS skip WS entirely — CDP/Playwright only.
 * - Playwright is never auto-installed. User opt-in only.
 * - Every execution logged with UUID, session, method, result, durationMs.
 * - Session capability checked before routing (URL match, domHash freshness).
 */

const crypto = require('crypto');
const { NON_DOM_CALLTOS } = require('../bridge-core/registry/index');

const CAPABILITY_STALE_MS = 30000; // 30s — reject callto if session capabilities stale

function createCalltoRouter({ wsSessions, erosClient = null, playwrightEnabled = false, busEmit = null, calltoRegistry = null } = {}) {

  // ── Session capability validation ─────────────────────────────────────────
  function _validateSession(session, callto) {
    if (!session) return { ok: false, reason: 'no session' };

    const caps = session.capabilities;
    if (!caps) return { ok: false, reason: 'session has no capabilities' };

    // Freshness check
    if (caps.lastUpdated && (Date.now() - caps.lastUpdated) > CAPABILITY_STALE_MS) {
      return { ok: false, reason: 'session capabilities stale (> 30s)' };
    }

    // Visibility: hidden tabs can only run if configured
    if (caps.visibilityState === 'hidden' && !callto.allowHidden) {
      return { ok: false, reason: 'tab not visible' };
    }

    // URL match: callto.origin must match session's current URL
    if (callto.origin && caps.url) {
      try {
        const sessionOrigin = new URL(caps.url).origin;
        const calltoOrigin  = callto.origin.startsWith('http') ? new URL(callto.origin).origin : callto.origin;
        if (sessionOrigin !== calltoOrigin) {
          return { ok: false, reason: `origin mismatch: session=${sessionOrigin} callto=${calltoOrigin}` };
        }
      } catch {}
    }

    return { ok: true };
  }

  // ── Route a callto through the priority stack ─────────────────────────────
  async function route(callto) {
    const t0     = Date.now();
    const callId = callto.uuid || ('ctr_' + crypto.randomBytes(6).toString('hex'));

    // NON-DOM calltos skip WS entirely
    if (NON_DOM_CALLTOS.includes(callto.action)) {
      return _routeCDP(callto, callId, t0, 'non-dom-forced');
    }

    // ── Priority 1: Userscript WebSocket ──────────────────────────────────
    const session = wsSessions?.getPrimaryForOrigin(callto.origin);
    if (session) {
      const capCheck = _validateSession(session, callto);
      if (capCheck.ok) {
        return _routeWS(callto, session, callId, t0);
      }
      // Capabilities stale or mismatch — fall through with log
      busEmit?.('callto:ws:skipped', {
        callId, reason: capCheck.reason, origin: callto.origin
      }, 'WARN');
    }

    // ── Priority 2: ErosmancerOS CDP ──────────────────────────────────────
    if (erosClient?.hasSessionForOrigin?.(callto.origin)) {
      return _routeCDP(callto, callId, t0, 'cdp-fallback');
    }

    // ── Priority 3: Playwright — EXPLICIT ONLY ────────────────────────────
    if (playwrightEnabled) {
      return _routePlaywright(callto, callId, t0);
    }

    // Nothing available
    const durationMs = Date.now() - t0;
    const result = {
      ok:         false,
      callId,
      method:     null,
      error:      'No execution method available. Install Tampermonkey connector or enable CDP.',
      durationMs,
    };
    _log(callto, result);
    return result;
  }

  // ── WS execution ──────────────────────────────────────────────────────────
  async function _routeWS(callto, session, callId, t0) {
    try {
      const r = await session.execute({
        id:       callId,
        action:   callto.action,
        selector: callto.selector,
        params:   callto.params || {},
        timeout:  callto.timeout || 5000,
      });
      const durationMs = Date.now() - t0;
      const result = {
        ok:         r.ok !== false,
        callId,
        method:     'ws',
        sessionId:  session.id,
        result:     r.result || r,
        error:      r.error || null,
        durationMs,
      };
      _log(callto, result);
      return result;
    } catch (e) {
      // WS failed — fall through to CDP
      busEmit?.('callto:ws:error', { callId, error: e.message }, 'WARN');
      if (erosClient?.hasSessionForOrigin?.(callto.origin)) {
        return _routeCDP(callto, callId, t0, 'cdp-ws-failover');
      }
      return { ok: false, callId, method: 'ws', error: e.message, durationMs: Date.now() - t0 };
    }
  }

  // ── CDP execution (ErosmancerOS) ──────────────────────────────────────────
  async function _routeCDP(callto, callId, t0, reason = 'cdp') {
    if (!erosClient) {
      return { ok: false, callId, method: 'cdp', error: 'ErosmancerOS not available', durationMs: Date.now() - t0 };
    }
    try {
      const r = await erosClient.execute({
        action:   callto.action,
        selector: callto.selector,
        params:   callto.params || {},
      });
      const durationMs = Date.now() - t0;
      const result = { ok: r.ok !== false, callId, method: 'cdp', reason, result: r, durationMs };
      _log(callto, result);
      return result;
    } catch (e) {
      const durationMs = Date.now() - t0;
      const result = { ok: false, callId, method: 'cdp', error: e.message, durationMs };
      _log(callto, result);
      return result;
    }
  }

  // ── Playwright execution — EXPLICIT OPT-IN ONLY ──────────────────────────
  async function _routePlaywright(callto, callId, t0) {
    let playwright;
    try {
      playwright = require('../nexus-playwright-controller');
    } catch {
      return {
        ok:    false,
        callId,
        method: 'playwright',
        error:  'Playwright not installed. Run: npm install playwright. Then set playwrightEnabled:true in config.',
        durationMs: Date.now() - t0,
      };
    }
    try {
      const r = await playwright.execute(callto.action, callto.selector, callto.params || {});
      const durationMs = Date.now() - t0;
      const result = { ok: r.ok !== false, callId, method: 'playwright', result: r, durationMs };
      _log(callto, result);
      return result;
    } catch (e) {
      const result = { ok: false, callId, method: 'playwright', error: e.message, durationMs: Date.now() - t0 };
      _log(callto, result);
      return result;
    }
  }

  // ── Log every execution ───────────────────────────────────────────────────
  function _log(callto, result) {
    busEmit?.('callto:executed', {
      callId:      result.callId,
      action:      callto.action,
      selector:    callto.selector,
      origin:      callto.origin,
      method:      result.method,
      ok:          result.ok,
      durationMs:  result.durationMs,
      error:       result.error || null,
    }, result.ok ? 'INFO' : 'WARN');

    // Update callto registry if provided
    if (callto.uuid && calltoRegistry) {
      calltoRegistry.resolve(callto.uuid, {
        result: result.result,
        error:  result.error,
        method: result.method,
      });
    }
  }

  // Allow eros client to be wired after construction (async probe)
  const router = { route };
  Object.defineProperty(router, 'erosClient', {
    get: () => erosClient,
    set: (v) => { erosClient = v; },
  });
  return router;
}

module.exports = { createCalltoRouter };
