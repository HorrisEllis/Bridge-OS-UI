// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
'use strict';
/**
 * bridge-node/eros-shim.js
 * ErosmancerOS CDP client shim for bridge-node callto-router.
 *
 * The callto-router expects:
 *   erosClient.hasSessionForOrigin(origin) → boolean
 *   erosClient.execute({ action, selector, params }) → { ok, result?, error? }
 *
 * This shim:
 * 1. Checks if ErosmancerOS is running on :7432
 * 2. If available, proxies calltos through its /callto endpoint
 * 3. If unavailable, returns { available: false } so router falls through
 *
 * EROS-001 and EROS-002 bugs must be fixed before this shim is production-active.
 * Until then: erosClient = null in boot.js (harmless — router skips to Playwright path)
 */

const http = require('http');

const EROS_PORT = 7432;
const EROS_HOST = '127.0.0.1';

// ── HTTP call to ErosmancerOS ─────────────────────────────────────────────────
function erosRequest(path, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: EROS_HOST,
      port:     EROS_PORT,
      path,
      method,
      headers:  { 'Content-Type': 'application/json' },
      timeout:  3000,
    };
    const req = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch { resolve(null); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('eros timeout')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ── Shim factory ─────────────────────────────────────────────────────────────
function createErosShim({ busEmit = null } = {}) {
  let _available    = false;
  let _sessions     = new Map();  // origin → sessionId
  let _lastHealthAt = 0;

  // Probe ErosmancerOS health
  async function probe() {
    try {
      const r = await erosRequest('/health');
      _available = !!(r?.ok || r?.status === 'running');
      _lastHealthAt = Date.now();
      if (_available) {
        // Sync session list
        const s = await erosRequest('/sessions');
        _sessions = new Map((s?.sessions || []).map(x => [x.origin, x.id]));
      }
    } catch {
      _available = false;
    }
    return _available;
  }

  // Check if ErosmancerOS has a CDP session for a given origin
  function hasSessionForOrigin(origin) {
    if (!_available) return false;
    if (!origin) return false;
    try {
      const originHost = new URL(origin.startsWith('http') ? origin : 'https://' + origin).hostname;
      for (const [sessionOrigin] of _sessions) {
        try {
          if (new URL(sessionOrigin).hostname === originHost) return true;
        } catch {}
      }
    } catch {}
    return false;
  }

  // Execute a callto via ErosmancerOS CDP
  async function execute({ action, selector, params = {} }) {
    if (!_available) return { ok: false, error: 'ErosmancerOS not available' };
    try {
      const r = await erosRequest('/callto', 'POST', { action, selector, params });
      busEmit?.('eros:callto:executed', { action, selector, ok: r?.ok }, 'DEBUG');
      return r || { ok: false, error: 'No response from ErosmancerOS' };
    } catch (e) {
      return { ok: false, error: `ErosmancerOS error: ${e.message}` };
    }
  }

  // Start periodic health probe (every 10s)
  function startMonitor(intervalMs = 10000) {
    probe(); // immediate probe
    return setInterval(() => probe(), intervalMs);
  }

  return { probe, hasSessionForOrigin, execute, startMonitor,
           get available() { return _available; } };
}

module.exports = { createErosShim };
