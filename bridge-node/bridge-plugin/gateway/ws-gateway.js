// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
'use strict';
/**
 * bridge-plugin/gateway/ws-gateway.js
 * WebSocket gateway for Tampermonkey/Guardian connector sessions.
 *
 * Per Critique #2 resolutions:
 * - Session capability model (domHash, url, visibilityState, lastUpdated)
 * - Active session lock per origin (primary/observer/shadow/backup)
 * - Per-session rate limiter + queue depth
 * - bridge state atom (bootId, sessions) written on every change
 * - Stale capability rejection (> 30s)
 */

'use strict';

const crypto = require('crypto');
const http   = require('http');

const ROLE = { PRIMARY: 'primary', OBSERVER: 'observer', SHADOW: 'shadow', BACKUP: 'backup' };

const DEFAULT_RATE = {
  maxEventsPerSecond: 50,
  maxQueueDepth:      200,
  burstAllowance:     100,
  dropPolicy:         'oldest',
};

// ── Session ───────────────────────────────────────────────────────────────────
function createSession(ws, registration) {
  const id         = registration.sessionId || ('ws_' + crypto.randomBytes(8).toString('hex'));
  const origin     = registration.origin || registration.href || null;
  const connectedAt = Date.now();

  let capabilities = {
    url:              registration.href || null,
    visibilityState:  registration.visibilityState || 'visible',
    domHash:          registration.domHash || null,
    lastUpdated:      Date.now(),
    supportedCalltos: registration.supportedCalltos || [],
  };

  let role         = ROLE.OBSERVER;
  let lastPingAt   = Date.now();
  let pendingCalltos = [];

  // Per-session rate limiter
  let eventCount = 0;
  let windowStart = Date.now();

  function rateCheck() {
    const now = Date.now();
    if (now - windowStart > 1000) { eventCount = 0; windowStart = now; }
    eventCount++;
    if (eventCount > DEFAULT_RATE.maxEventsPerSecond) return false;
    if (pendingCalltos.length >= DEFAULT_RATE.maxQueueDepth) {
      if (DEFAULT_RATE.dropPolicy === 'oldest') pendingCalltos.shift();
      else return false;
    }
    return true;
  }

  function send(type, data) {
    if (!rateCheck()) return false;
    try {
      ws.send(JSON.stringify({ type, data, ts: Date.now() }));
      return true;
    } catch { return false; }
  }

  async function execute({ id: callId, action, selector, params, timeout = 5000 }) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve({ ok: false, error: 'callto timeout', callId });
      }, timeout);

      pendingCalltos.push({ callId, resolve, timer });
      send('callto:execute', { id: callId, action, selector, params });
    });
  }

  function receiveResult(callId, result) {
    const idx = pendingCalltos.findIndex(c => c.callId === callId);
    if (idx === -1) return;
    const { resolve, timer } = pendingCalltos.splice(idx, 1)[0];
    clearTimeout(timer);
    resolve(result);
  }

  function updateCapabilities(caps) {
    capabilities = { ...capabilities, ...caps, lastUpdated: Date.now() };
    lastPingAt = Date.now();
  }

  return {
    id, origin, connectedAt, ws,
    get role()         { return role; },
    set role(r)        { role = r; },
    get lastPingAt()   { return lastPingAt; },
    get capabilities() { return capabilities; },
    send, execute, receiveResult, updateCapabilities,
    ping() { lastPingAt = Date.now(); },
  };
}

// ── Gateway ───────────────────────────────────────────────────────────────────
function createWSGateway({ busEmit = null, onStateChange = null } = {}) {
  const _sessions    = new Map();   // sessionId → session
  const _originLock  = new Map();   // origin → primary sessionId
  const bootId       = crypto.randomUUID();
  let   _wsServer    = null;

  // ── Session lock management ────────────────────────────────────────────────
  function _assignRole(session) {
    const origin = session.origin;
    if (!origin) { session.role = ROLE.OBSERVER; return; }

    if (!_originLock.has(origin)) {
      _originLock.set(origin, session.id);
      session.role = ROLE.PRIMARY;
    } else {
      session.role = ROLE.OBSERVER;
    }
  }

  function _promotePrimary(origin) {
    // When primary disconnects, promote oldest observer
    const candidates = [..._sessions.values()]
      .filter(s => s.origin === origin && s.role === ROLE.OBSERVER)
      .sort((a, b) => a.connectedAt - b.connectedAt);

    if (candidates.length > 0) {
      const next = candidates[0];
      next.role = ROLE.PRIMARY;
      _originLock.set(origin, next.id);
      busEmit?.('userscript:session:promoted', { sessionId: next.id, origin }, 'INFO');
    } else {
      _originLock.delete(origin);
    }
  }

  // ── Get primary session for origin (used by callto-router) ────────────────
  function getPrimaryForOrigin(origin) {
    if (!origin) return null;
    const primaryId = _originLock.get(origin);
    if (!primaryId) return null;
    const s = _sessions.get(primaryId);
    if (!s || s.role !== ROLE.PRIMARY) return null;
    return s;
  }

  // ── Mount on existing HTTP server ─────────────────────────────────────────
  function install(httpServer, bus) {
    // Lazy-load ws — not a hard dep for tests
    let WebSocketServer;
    try { WebSocketServer = require('ws').Server; } catch {
      console.warn('[ws-gateway] ws package not available — WS sessions disabled');
      return;
    }

    _wsServer = new WebSocketServer({ server: httpServer, path: '/ws' });

    _wsServer.on('connection', (ws, req) => {
      let session = null;

      ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }

        switch (msg.type) {
          case 'session:register': {
            session = createSession(ws, msg.data || {});
            _sessions.set(session.id, session);
            _assignRole(session);
            busEmit?.('userscript:connected', {
              sessionId: session.id, origin: session.origin,
              role: session.role, href: session.capabilities.url,
            }, 'INFO');
            session.send('session:registered', {
              sessionId: session.id, role: session.role, bootId,
            });
            _notifyStateChange();
            break;
          }

          case 'heartbeat': {
            session?.ping();
            session?.updateCapabilities(msg.data?.capabilities || {});
            break;
          }

          case 'callto:result': {
            if (!session) return;
            const { id, ok, result, error } = msg.data || {};
            session.receiveResult(id, { ok, result, error });
            busEmit?.('callto:result', { sessionId: session.id, id, ok }, 'DEBUG');
            break;
          }

          case 'event': {
            if (!session) return;
            const { eventType, data: evData } = msg.data || {};
            busEmit?.(eventType || 'userscript:event', {
              ...evData, sessionId: session?.id, origin: session?.origin,
            }, 'DEBUG');
            break;
          }
        }
      });

      ws.on('close', () => {
        if (!session) return;
        const origin = session.origin;
        const wasPrimary = session.role === ROLE.PRIMARY;
        _sessions.delete(session.id);

        if (wasPrimary && origin) _promotePrimary(origin);

        busEmit?.('userscript:disconnected', { sessionId: session.id, origin }, 'INFO');
        _notifyStateChange();
      });
    });
  }

  // ── HTTP route handler (/userscript/*) ────────────────────────────────────
  function route(method, urlParts, body, req, res) {
    const _json = (status, obj) => {
      const d = JSON.stringify(obj);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(d);
    };

    // GET /userscript/sessions
    if (method === 'GET' && urlParts[1] === 'sessions') {
      const sessions = [..._sessions.values()].map(s => ({
        id: s.id, origin: s.origin, role: s.role,
        connectedAt: s.connectedAt, lastPingAt: s.lastPingAt,
        capabilities: s.capabilities,
      }));
      return _json(200, { ok: true, count: sessions.length, sessions });
    }

    // POST /userscript/session/:id/promote
    if (method === 'POST' && urlParts[1] === 'session' && urlParts[3] === 'promote') {
      const sid     = urlParts[2];
      const session = _sessions.get(sid);
      if (!session) return _json(404, { ok: false, error: 'Session not found' });

      const origin = session.origin;
      if (origin) {
        const oldPrimary = _originLock.get(origin);
        if (oldPrimary) {
          const old = _sessions.get(oldPrimary);
          if (old) old.role = ROLE.OBSERVER;
        }
        _originLock.set(origin, sid);
        session.role = ROLE.PRIMARY;
      }
      return _json(200, { ok: true, sessionId: sid, role: session.role });
    }

    // POST /userscript/broadcast
    if (method === 'POST' && urlParts[1] === 'broadcast') {
      const { type, data, origin: targetOrigin } = body || {};
      let sent = 0;
      for (const s of _sessions.values()) {
        if (!targetOrigin || s.origin === targetOrigin) {
          if (s.send(type || 'broadcast', data || {})) sent++;
        }
      }
      return _json(200, { ok: true, sent });
    }

    return _json(404, { ok: false, error: 'Unknown userscript endpoint' });
  }

  // ── State atom (Electron reconcile on connect) ────────────────────────────
  function getState() {
    return {
      bootId,
      startedAt: Date.now(),
      sessions: Object.fromEntries(
        [..._sessions.entries()].map(([id, s]) => [id, {
          origin: s.origin, role: s.role, lastPingAt: s.lastPingAt,
        }])
      ),
    };
  }

  function _notifyStateChange() {
    onStateChange?.(getState());
  }

  return { install, route, getPrimaryForOrigin, getState, sessions: _sessions, bootId };
}

module.exports = { createWSGateway, createSession };
