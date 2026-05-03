// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
'use strict';
/**
 * bridge-cfr/index.js
 * CFR (Constraint Field Runtime) integration module for sovereign-node.
 *
 * Hooks into the boot-returned context and exposes:
 *   GET  /cfr/health          — CFR module status + connected canvas count
 *   GET  /cfr/nodes           — All canvas nodes (attractors) with live field state
 *   GET  /cfr/deltas          — Recent bus events formatted as CFR deltas
 *   POST /cfr/emit            — Inject a bus event from the CFR canvas
 *   POST /cfr/field           — Update CFR field parameters (structure, entropy, etc.)
 *   GET  /cfr/field           — Current CFR field state
 *   GET  /cfr/causal          — Live causal kernel snapshot
 *   GET  /cfr/trust           — Trust mesh snapshot for all known peers
 *   POST /cfr/simulate        — Inject a simulation event (route, failure, heal, etc.)
 *   GET  /cfr/snr-rules       — SNR gate rules as CFR understands them
 *   POST /cfr/snr-rules       — Add a rule via CFR
 *   GET  /cfr/state           — Full field+node+causal+trust compound state
 *   WS   /cfr/stream          — WebSocket stream of bus events → CFR delta format
 *
 * Bus event → CFR delta mapping:
 *   Every bus event is normalised to { type, msg, ts, cls, detail }
 *   where cls ∈ ['ok','warn','err','cfr'] maps to the timeline colour
 *
 * Node model:
 *   Each registered node (from /pulse or boot identity) becomes a canvas attractor.
 *   Field parameters are derived from live system health:
 *     structure  ← trust mesh mean score (0..1)
 *     entropy    ← sngate deny rate (0..1)
 *     attention  ← active WS sessions / 10 (0..1, capped)
 *     damping    ← heartbeat miss rate inverted (0..1)
 */

const crypto = require('crypto');

const MODULE_UUID    = 'bridge-cfr-v1-0-0';
const MODULE_VERSION = '1.0.0';
const MAX_DELTAS     = 500;   // rolling delta ring
const MAX_NODES      = 200;

// ── CFR field state — derived from live system, overridable via POST /cfr/field
const _field = {
  structure:  0.5,
  entropy:    0.2,
  attention:  0.5,
  damping:    0.12,
  curl:       0.6,
  speed:      1.0,
  snrConfig:  { threshold: 5, mode: 'adaptive' },
};

// ── Node registry (canvas attractors)
const _nodes    = new Map();  // id → node record
const _deltas   = [];         // rolling ring of CFR deltas
const _wsClients = new Set(); // connected CFR WebSocket streams

let _ctx = null;  // boot context wired in via install()
let _installed = false;

// ── Bus event → CFR delta classifier
const CLS_MAP = {
  'bridge:boot':           'ok',
  'bridge:shutdown':       'warn',
  'node:pulse':            'ok',
  'node:degraded':         'warn',
  'node:dead':             'err',
  'mesh:peer:connected':   'ok',
  'mesh:peer:disconnect':  'warn',
  'mesh:data:incoming':    'ok',
  'mesh:trust:update':     'cfr',
  'sngate:decision':       (d) => d.decision === 'deny' ? 'err' : d.decision === 'observe' ? 'warn' : 'ok',
  'causal:kernel:ready':   'cfr',
  'causal:kernel:stats':   'cfr',
  'alert:sngate:burst':    'err',
  'alert:mesh:degraded':   'err',
  'canvas:watchdog':       (d) => d.ok ? 'ok' : 'err',
  'canvas:module:ready':   'ok',
  'cli:command':           'cfr',
  'cfr:field:update':      'cfr',
  'cfr:node:upsert':       'ok',
  'cfr:simulate':          'cfr',
};

function classifyEvent(sig, data) {
  const rule = CLS_MAP[sig];
  if (!rule) return sig.includes('error') || sig.includes('fail') || sig.includes('dead') ? 'err'
            : sig.includes('warn') || sig.includes('degrad') ? 'warn'
            : 'ok';
  return typeof rule === 'function' ? rule(data) : rule;
}

function pushDelta(sig, data, cls) {
  const delta = {
    id:   crypto.randomUUID(),
    ts:   Date.now(),
    type: sig,
    cls:  cls || classifyEvent(sig, data),
    msg:  extractMsg(sig, data),
    detail: data ? JSON.stringify(data).slice(0, 200) : '',
  };
  _deltas.push(delta);
  if (_deltas.length > MAX_DELTAS) _deltas.shift();
  // Broadcast to connected WS streams
  if (_wsClients.size) {
    const payload = JSON.stringify({ event: 'delta', data: delta });
    for (const ws of _wsClients) {
      try { ws.send(payload); } catch { _wsClients.delete(ws); }
    }
  }
  return delta;
}

function extractMsg(sig, data) {
  if (!data) return sig;
  if (data.msg)     return String(data.msg).slice(0, 120);
  if (data.message) return String(data.message).slice(0, 120);
  if (data.error)   return String(data.error).slice(0, 120);
  if (data.uuid)    return `uuid:${data.uuid.slice(0, 8)}`;
  return sig;
}

// ── Derive field parameters from live system state
function deriveField() {
  if (!_ctx) return _field;
  try {
    const trust   = _ctx.trustMesh?.diagnostics() || {};
    const gate    = _ctx.gate;
    const ws      = _ctx.wsGateway?.getState() || {};

    // structure ← mean trust score (default 0.5 if no peers)
    if (trust.peerCount > 0 && trust.meanScore != null) {
      _field.structure = Math.min(1, Math.max(0, trust.meanScore));
    }

    // entropy ← sngate deny ratio from trace
    if (gate?.trace) {
      const recent = gate.trace.query({}).slice(-100);
      const denies = recent.filter(e => e.decision === 'deny').length;
      _field.entropy = recent.length ? denies / recent.length : 0.2;
    }

    // attention ← active WS sessions
    const sessions = ws.sessions || 0;
    _field.attention = Math.min(1, sessions / 10);

    // snrConfig stays as configured or from gate
    if (gate?.config) {
      _field.snrConfig.threshold = gate.config.gateThreshold ?? 5;
      _field.snrConfig.mode      = gate.config.defaultMode    ?? 'adaptive';
    }
  } catch (_) {}
  return _field;
}

// ── Node upsert — any registered node/identity becomes a canvas attractor
function upsertNode(id, record) {
  if (!id) return;
  const existing = _nodes.get(id) || {};
  _nodes.set(id, {
    id,
    label:     record.label || record.logicalId || record.uuid?.slice(0, 12) || id.slice(0, 12),
    type:      record.type || record.capabilities?.[0] || 'node',
    updatedAt: Date.now(),
    ...existing,
    ...record,
  });
  if (_nodes.size > MAX_NODES) {
    // evict oldest
    const oldest = [..._nodes.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0];
    if (oldest) _nodes.delete(oldest[0]);
  }
}

// ── Install — called from boot context after all phases complete
function install(ctx) {
  if (_installed) return;
  _installed = true;
  _ctx = ctx;

  const { bus, busEmit, identity, nodeRegistry, trustMesh, causal, gate, ime } = ctx;

  // Register own identity as a canvas node
  upsertNode(identity.uuid, {
    label:      'sovereign-node',
    type:       'foundation',
    updatedAt:  Date.now(),
    uuid:       identity.uuid,
  });

  // Subscribe to ALL bus events → push to delta ring
  bus.onAny?.((sig, data) => {
    pushDelta(sig, data);
    // Update field from live state periodically
    if (sig === 'causal:kernel:stats' || sig === 'mesh:trust:update' || sig === 'sngate:decision') {
      deriveField();
    }
  });

  // Fallback: hook specific events if onAny isn't available
  if (!bus.onAny) {
    const WATCH = [
      'bridge:boot','bridge:shutdown','node:pulse','node:degraded','node:dead',
      'mesh:peer:connected','mesh:peer:disconnect','mesh:data:incoming','mesh:trust:update',
      'sngate:decision','causal:kernel:ready','causal:kernel:stats',
      'alert:sngate:burst','alert:mesh:degraded','canvas:watchdog','canvas:module:ready',
      'cli:command','cfr:field:update','cfr:node:upsert','cfr:simulate',
    ];
    for (const sig of WATCH) {
      bus.on(sig, (data) => {
        pushDelta(sig, data);
        if (['causal:kernel:stats','mesh:trust:update','sngate:decision'].includes(sig)) {
          deriveField();
        }
        // node:pulse → register as canvas node
        if (sig === 'node:pulse' && data?.instanceId) {
          upsertNode(data.instanceId, {
            label:        data.logicalId || data.instanceId.slice(0, 12),
            type:         data.capabilities?.[0] || 'canvas',
            nodeCount:    data.nodeCount,
            fps:          data.fps,
            instanceId:   data.instanceId,
          });
        }
        if (sig === 'mesh:peer:connected' && data?._uuid) {
          upsertNode(data._uuid, { label: data._uuid.slice(0, 12), type: 'bridge', uuid: data._uuid });
        }
      });
    }
  }

  // Sync nodeRegistry nodes → canvas nodes on boot
  try {
    const existing = nodeRegistry?.list() || [];
    for (const n of existing) upsertNode(n.instanceId || n.uuid || n.id, n);
  } catch (_) {}

  pushDelta('cfr:module:ready', { uuid: MODULE_UUID, version: MODULE_VERSION }, 'ok');
}

// ── HTTP route handler  (registered in boot as top === 'cfr')
function route(method, urlParts, body, req, res) {
  const sub = urlParts[1] || '';

  // GET /cfr/health
  if (method === 'GET' && sub === 'health') {
    return {
      ok:       true,
      module:   MODULE_UUID,
      version:  MODULE_VERSION,
      nodes:    _nodes.size,
      deltas:   _deltas.length,
      wsClients:_wsClients.size,
      installed:_installed,
      field:    deriveField(),
    };
  }

  // GET /cfr/nodes
  if (method === 'GET' && sub === 'nodes') {
    return {
      ok:    true,
      nodes: [..._nodes.values()],
      count: _nodes.size,
    };
  }

  // GET /cfr/deltas?limit=N
  if (method === 'GET' && sub === 'deltas') {
    const qs     = (req?.url || '').split('?')[1] || '';
    const params = Object.fromEntries(new URLSearchParams(qs));
    const limit  = Math.min(500, Math.max(1, parseInt(params.limit) || 50));
    return {
      ok:     true,
      deltas: _deltas.slice(-limit),
      total:  _deltas.length,
    };
  }

  // GET /cfr/field
  if (method === 'GET' && sub === 'field') {
    return { ok: true, field: deriveField() };
  }

  // POST /cfr/field  — override field params
  if (method === 'POST' && sub === 'field') {
    const allowed = ['structure','entropy','attention','damping','curl','speed'];
    let changed = false;
    for (const k of allowed) {
      if (body[k] !== undefined) {
        _field[k] = Math.min(1, Math.max(0, Number(body[k])));
        changed = true;
      }
    }
    if (changed) {
      _ctx?.busEmit?.('cfr:field:update', { ..._field }, 'INFO');
      pushDelta('cfr:field:update', { ..._field }, 'cfr');
    }
    return { ok: true, field: _field };
  }

  // GET /cfr/state  — compound: field + nodes + causal + trust
  if (method === 'GET' && sub === 'state') {
    const causal = _ctx?.causal?.diagnostics() || {};
    const trust  = _ctx?.trustMesh?.diagnostics() || {};
    return {
      ok:    true,
      state: {
        schema:  1,
        field:   deriveField(),
        nodes:   [..._nodes.values()],
        causal,
        trust,
        snrConfig: _field.snrConfig,
        uptime:  process.uptime(),
        nodeId:  _ctx?.identity?.uuid?.slice(0, 8) || null,
      },
    };
  }

  // GET /cfr/causal
  if (method === 'GET' && sub === 'causal') {
    if (!_ctx?.causal) return { ok: false, error: 'causal module not loaded' };
    return { ok: true, causal: _ctx.causal.diagnostics() };
  }

  // GET /cfr/trust
  if (method === 'GET' && sub === 'trust') {
    if (!_ctx?.trustMesh) return { ok: false, error: 'trust mesh not loaded' };
    return { ok: true, trust: _ctx.trustMesh.diagnostics() };
  }

  // GET /cfr/snr-rules
  if (method === 'GET' && sub === 'snr-rules') {
    const rules = _ctx?.gate?.rules?.list() || [];
    return { ok: true, rules };
  }

  // POST /cfr/snr-rules
  if (method === 'POST' && sub === 'snr-rules') {
    if (!_ctx?.gate?.rules) return { ok: false, error: 'sngate not available' };
    const id = _ctx.gate.rules.add(body);
    pushDelta('cfr:snr:rule_added', { id, rule: body }, 'cfr');
    return { ok: true, id };
  }

  // POST /cfr/emit  — inject bus event from canvas
  if (method === 'POST' && sub === 'emit') {
    const { sig, data, level } = body || {};
    if (!sig) return { ok: false, error: 'sig required' };
    _ctx?.busEmit?.(sig, { ...data, _source: 'cfr' }, level || 'INFO');
    pushDelta(sig, data, classifyEvent(sig, data));
    return { ok: true, sig, ts: Date.now() };
  }

  // POST /cfr/simulate  — route/failure/heal simulation events
  if (method === 'POST' && sub === 'simulate') {
    return handleSimulate(body || {});
  }

  // POST /cfr/node  — register / update a canvas node
  if (method === 'POST' && (sub === 'node' || sub === 'nodes')) {
    const { id, label, type, ...rest } = body || {};
    if (!id) return { ok: false, error: 'id required' };
    upsertNode(id, { label, type, ...rest });
    pushDelta('cfr:node:upsert', { id, label, type }, 'ok');
    return { ok: true, node: _nodes.get(id) };
  }

  return null; // not handled — let boot return 404
}

// ── Simulation handler
function handleSimulate(body) {
  const { type, fromId, toId, intensity = 5 } = body;
  const fromNode = _nodes.get(fromId);
  const toNode   = _nodes.get(toId);

  switch (type) {
    case 'route': {
      if (!fromId || !toId) return { ok: false, error: 'fromId and toId required' };
      _ctx?.busEmit?.('cfr:simulate', { type, fromId, toId, intensity, ts: Date.now() }, 'INFO');
      pushDelta('cfr:simulate:route', { from: fromNode?.label || fromId, to: toNode?.label || toId, intensity }, 'ok');
      return { ok: true, type, from: fromNode?.label, to: toNode?.label };
    }
    case 'failure': {
      if (!fromId) return { ok: false, error: 'fromId required' };
      _ctx?.busEmit?.('node:degraded', { _uuid: fromId, uuid: fromId, reason: 'cfr:simulated' }, 'WARN');
      pushDelta('cfr:simulate:failure', { nodeId: fromId, label: fromNode?.label, intensity }, 'err');
      return { ok: true, type, nodeId: fromId };
    }
    case 'heal': {
      if (!fromId) return { ok: false, error: 'fromId required' };
      _ctx?.busEmit?.('mesh:peer:connected', { _uuid: fromId, uuid: fromId, reason: 'cfr:heal' }, 'INFO');
      pushDelta('cfr:simulate:heal', { nodeId: fromId, label: fromNode?.label }, 'ok');
      return { ok: true, type, nodeId: fromId };
    }
    case 'snr_block': {
      _ctx?.busEmit?.('sngate:decision', { decision: 'deny', surface: 'cfr:simulated', uuid: fromId || 'unknown', _source: 'cfr' }, 'WARN');
      pushDelta('sngate:decision', { decision: 'deny', surface: 'cfr:simulated' }, 'err');
      return { ok: true, type };
    }
    case 'broadcast': {
      if (!fromId) return { ok: false, error: 'fromId required' };
      for (const [id] of _nodes) {
        if (id !== fromId) {
          _ctx?.busEmit?.('cfr:simulate', { type: 'route', fromId, toId: id, intensity }, 'INFO');
        }
      }
      pushDelta('cfr:simulate:broadcast', { from: fromNode?.label, targets: _nodes.size - 1 }, 'cfr');
      return { ok: true, type, targets: _nodes.size - 1 };
    }
    case 'cascade': {
      let i = 0;
      for (const [id] of _nodes) {
        setTimeout(() => {
          _ctx?.busEmit?.('node:degraded', { _uuid: id, uuid: id, reason: 'cfr:cascade' }, 'WARN');
          pushDelta('cfr:simulate:cascade', { nodeId: id, wave: i }, 'err');
        }, i * 400);
        i++;
      }
      return { ok: true, type, waves: i };
    }
    default:
      return { ok: false, error: `Unknown sim type: ${type}` };
  }
}

// ── WebSocket stream attachment (called from boot after wsGateway installs)
function attachWS(ws) {
  _wsClients.add(ws);
  ws.on('close', () => { _wsClients.delete(ws); clearInterval(ws._pingInterval); });
  ws.on('error', () => { _wsClients.delete(ws); clearInterval(ws._pingInterval); });
  ws.on('pong',  () => { ws._alive = true; });
  // Send current state on connect
  try {
    ws.send(JSON.stringify({ event: 'init', data: { field: deriveField(), nodes: [..._nodes.values()], deltas: _deltas.slice(-20) } }));
  } catch (_) {}
  // WS-01 fix: ping every 25s — dead clients are detected and evicted rather
  // than accumulating silently in _wsClients until the next delta broadcast fails.
  ws._alive = true;
  ws._pingInterval = setInterval(() => {
    if (!ws._alive) { _wsClients.delete(ws); clearInterval(ws._pingInterval); ws.terminate?.(); return; }
    ws._alive = false;
    try { ws.ping(); } catch { _wsClients.delete(ws); clearInterval(ws._pingInterval); }
  }, 25_000);
}

// ── Diagnostics
function diagnostics() {
  return {
    uuid:      MODULE_UUID,
    version:   MODULE_VERSION,
    installed: _installed,
    nodes:     _nodes.size,
    deltas:    _deltas.length,
    wsClients: _wsClients.size,
    field:     { ..._field },
  };
}

// ── Canvas → NEXUS Mastermind sync ───────────────────────────────────────────
// Pushes current mesh topology (nodes, field state, cluster health) to a
// NEXUS Mastermind instance at the configured endpoint. The Mastermind can
// then render the mesh as a cognitive canvas overlay — nodes become framework
// nodes, trust scores become connection strengths, the regime becomes a
// synthesis signal.

let _nexusSyncUrl = null;
let _nexusSyncInterval = null;

function configureNexusSync(url, intervalMs = 30_000) {
  _nexusSyncUrl = url;
  if (_nexusSyncInterval) clearInterval(_nexusSyncInterval);
  if (!url) return;
  _nexusSyncInterval = setInterval(() => pushToNexus(), intervalMs);
}

async function pushToNexus(targetUrl = _nexusSyncUrl) {
  if (!targetUrl) return { ok: false, reason: 'no nexus sync URL configured' };
  const payload = {
    source:  'bridge-cfr',
    ts:      Date.now(),
    field:   deriveField(),
    nodes:   [..._nodes.values()],
    deltas:  _deltas.slice(-10),
    regime:  _ctx?.causal?.classify?.()?.regime || 'unknown',
  };
  try {
    const http = require('http');
    const data = JSON.stringify(payload);
    await new Promise((resolve, reject) => {
      const url  = new URL('/nexus/mesh-sync', targetUrl);
      const req  = http.request({ hostname: url.hostname, port: url.port || 80, path: url.pathname,
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        timeout: 4000 }, res => {
          const c = []; res.on('data', x => c.push(x));
          res.on('end', () => resolve(JSON.parse(Buffer.concat(c).toString())));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.write(data); req.end();
    });
    _ctx?.busEmit?.('cfr:nexus:synced', { nodes: _nodes.size, url: targetUrl }, 'INFO');
    return { ok: true };
  } catch (e) {
    _ctx?.busEmit?.('cfr:nexus:sync_failed', { reason: e.message, url: targetUrl }, 'WARN');
    return { ok: false, reason: e.message };
  }
}

module.exports = { install, route, attachWS, diagnostics, upsertNode, configureNexusSync, pushToNexus, MODULE_UUID, MODULE_VERSION };
