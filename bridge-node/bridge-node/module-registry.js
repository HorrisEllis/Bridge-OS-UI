// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
'use strict';
/**
 * bridge-node/module-registry.js
 * Runtime Module Registry — load, unload, reload, and list all modules.
 *
 * Every optional module in boot.js flows through here so it can be
 * hot-unloaded from the CLI without restarting the node.
 *
 * Module contract (what each entry must expose, at minimum):
 *   .diagnostics() → { uuid, version, ... }
 *   .stop?()       → graceful shutdown (optional)
 *   ._name         → set by registry on registration
 *
 * Registry events (emitted on the bus):
 *   module:loaded    { name, uuid, version }
 *   module:unloaded  { name, reason }
 *   module:error     { name, error }
 *   module:reloaded  { name }
 *
 * CLI surface (exposed via /module/* routes):
 *   GET  /module/list              → all registered modules
 *   GET  /module/:name             → single module diagnostics
 *   POST /module/:name/unload      → gracefully stop + deregister
 *   POST /module/:name/reload      → stop + re-require + re-init
 *   POST /module/:name/enable      → re-init a stopped module
 *
 * Unload safety:
 *   Vital modules (identity, core, IME, sngate, data, heartbeat, contracts)
 *   cannot be unloaded at runtime — the registry rejects with an error.
 */

const path = require('path');

const VITAL = new Set([
  'bridge-identity', 'bridge-core', 'bridge-IME',
  'bridge-sngate', 'bridge-data', 'bridge-heartbeat', 'bridge-contracts',
]);

function createModuleRegistry({ busEmit = null } = {}) {
  const _modules = new Map(); // name → { instance, path, vital, loadedAt, status }

  // ── Registration ────────────────────────────────────────────────────────────

  function register(name, instance, { modulePath = null, vital = false } = {}) {
    if (!name || !instance) throw new Error(`[registry] register requires name + instance`);
    instance._name = name;
    _modules.set(name, {
      instance,
      path:     modulePath,
      vital:    vital || VITAL.has(name),
      loadedAt: Date.now(),
      status:   'active',
    });
    busEmit?.('module:loaded', {
      name,
      uuid:    instance.MODULE_UUID || instance.uuid || null,
      version: instance.MODULE_VERSION || instance.version || null,
    }, 'INFO');
    return instance;
  }

  // ── Query ───────────────────────────────────────────────────────────────────

  function get(name) {
    return _modules.get(name)?.instance || null;
  }

  function list() {
    return [..._modules.entries()].map(([name, entry]) => ({
      name,
      vital:     entry.vital,
      status:    entry.status,
      loadedAt:  entry.loadedAt,
      uptime:    Math.round((Date.now() - entry.loadedAt) / 1000),
      ...(entry.instance.diagnostics?.() || {}),
    }));
  }

  // ── Unload ──────────────────────────────────────────────────────────────────

  function unload(name, reason = 'cli:unload') {
    const entry = _modules.get(name);
    if (!entry) return { ok: false, error: `Module '${name}' not registered` };
    if (entry.vital) return { ok: false, error: `'${name}' is vital — cannot be unloaded at runtime` };

    // Call stop if available
    try { entry.instance.stop?.(); } catch (e) {
      busEmit?.('module:error', { name, error: `stop() threw: ${e.message}` }, 'WARN');
    }

    entry.status = 'unloaded';
    _modules.delete(name);

    // Purge require cache if we know the path, so reload gets fresh code
    if (entry.path) {
      try {
        const resolved = require.resolve(entry.path);
        delete require.cache[resolved];
      } catch {}
    }

    busEmit?.('module:unloaded', { name, reason }, 'INFO');
    return { ok: true, name, reason };
  }

  // ── Reload ──────────────────────────────────────────────────────────────────

  async function reload(name, initArgs = {}) {
    const entry = _modules.get(name);
    if (!entry) return { ok: false, error: `Module '${name}' not registered` };
    if (entry.vital) return { ok: false, error: `'${name}' is vital — cannot be reloaded` };
    if (!entry.path) return { ok: false, error: `No require path stored for '${name}'` };

    // Unload first
    unload(name, 'reload:unload');

    // Re-require
    let fresh;
    try {
      fresh = require(entry.path);
    } catch (e) {
      busEmit?.('module:error', { name, error: `require failed: ${e.message}` }, 'WARN');
      return { ok: false, error: e.message };
    }

    // Re-init if possible
    try {
      if (typeof fresh.init === 'function') await fresh.init(initArgs);
      else if (typeof fresh.install === 'function') await fresh.install(initArgs);
      else if (typeof fresh.start === 'function') await fresh.start(initArgs);
    } catch (e) {
      busEmit?.('module:error', { name, error: `re-init failed: ${e.message}` }, 'WARN');
      return { ok: false, error: `re-init: ${e.message}` };
    }

    register(name, fresh, { modulePath: entry.path, vital: false });
    busEmit?.('module:reloaded', { name }, 'INFO');
    return { ok: true, name };
  }

  // ── HTTP route handler ──────────────────────────────────────────────────────

  function route(method, urlParts, body, req, res) {
    const _json = (s, o) => {
      res.writeHead(s, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(o, null, 2));
    };

    // GET /module/list
    if (method === 'GET' && urlParts[1] === 'list') {
      return _json(200, { ok: true, modules: list() });
    }

    // GET /module/:name
    if (method === 'GET' && urlParts[1] && urlParts[1] !== 'list') {
      const name = urlParts[1];
      const entry = _modules.get(name);
      if (!entry) return _json(404, { ok: false, error: `Module '${name}' not found` });
      return _json(200, {
        ok: true, name, vital: entry.vital, status: entry.status,
        loadedAt: entry.loadedAt,
        uptime: Math.round((Date.now() - entry.loadedAt) / 1000),
        ...(entry.instance.diagnostics?.() || {}),
      });
    }

    // POST /module/:name/unload
    if (method === 'POST' && urlParts[2] === 'unload') {
      const result = unload(urlParts[1], body?.reason || 'http:unload');
      return _json(result.ok ? 200 : 400, result);
    }

    // POST /module/:name/reload
    if (method === 'POST' && urlParts[2] === 'reload') {
      reload(urlParts[1], body || {}).then(r => _json(r.ok ? 200 : 400, r)).catch(e => _json(500, { ok: false, error: e.message }));
      return; // async
    }

    return null;
  }

  return { register, get, list, unload, reload, route };
}

module.exports = { createModuleRegistry, VITAL };
