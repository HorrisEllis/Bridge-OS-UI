// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
/**
 * ir-layer.js — GUARDIAN Intent-Routing Layer v1.0.0
 * UUID: guardian-ir-layer-v1000-0000-000000000001
 * hookId: guardian.ir:layer:route:00001
 *
 * The IR Layer sits between captured events and their destinations.
 * It resolves RouteSpec objects into executable transport actions.
 *
 * Architecture: ALL callto dispatch MUST go through this layer.
 * No direct module-to-module routing. Event bus only.
 *
 * RouteSpec types:
 *   nexus      → POST to Nexus ingestion endpoint
 *   local      → Store in browser.storage (persistent)
 *   mesh       → Broadcast to all discovered mesh nodes
 *   device     → Route to specific device by instanceId
 *   analyze    → Feed to URCK kernel only, no outbound
 *   pipeline   → Execute steps sequentially
 *   conditional → Evaluate rules, dispatch to matching route
 *   custom     → User-registered function
 */

'use strict';

// ── RouteSpec Schemas ─────────────────────────────────────────────────────────

const ROUTE_TYPES = new Set([
  'nexus', 'local', 'mesh', 'device', 'analyze', 'pipeline', 'conditional', 'custom'
]);

const DELIVERY_MODES = {
  FIRE_AND_FORGET:  'fire_and_forget',
  AT_LEAST_ONCE:    'at_least_once',
  EXACTLY_ONCE:     'exactly_once',
  GUARDED_PIPELINE: 'guarded_pipeline',
};

const CALLTO_STATES = {
  CREATED:      'created',
  ROUTED:       'routed',
  DISPATCHED:   'dispatched',
  IN_TRANSIT:   'in_transit',
  ACKNOWLEDGED: 'acknowledged',
  STORED:       'stored',
  ARCHIVED:     'archived',
  FAILED:       'failed',
};

// ── RouteSpec Validator ───────────────────────────────────────────────────────

function validateRouteSpec(spec) {
  if (!spec || typeof spec !== 'object') return { valid: false, error: 'RouteSpec must be an object' };
  if (!spec.type) return { valid: false, error: 'RouteSpec.type is required' };
  if (!ROUTE_TYPES.has(spec.type)) return { valid: false, error: `Unknown route type: ${spec.type}` };

  if (spec.type === 'pipeline') {
    if (!Array.isArray(spec.steps) || spec.steps.length === 0)
      return { valid: false, error: 'pipeline RouteSpec requires steps array' };
    for (const step of spec.steps) {
      const sv = validateRouteSpec(step);
      if (!sv.valid) return { valid: false, error: `Pipeline step invalid: ${sv.error}` };
    }
  }

  if (spec.type === 'device') {
    if (!spec.instanceId && !spec.nodeId)
      return { valid: false, error: 'device RouteSpec requires instanceId or nodeId' };
  }

  if (spec.type === 'conditional') {
    if (!Array.isArray(spec.rules) || spec.rules.length === 0)
      return { valid: false, error: 'conditional RouteSpec requires rules array' };
  }

  return { valid: true, error: null };
}

// ── Callto Schema ─────────────────────────────────────────────────────────────

function createCalltoPacket(payload, routeSpec, intent = 'capture') {
  const validation = validateRouteSpec(routeSpec);
  if (!validation.valid) throw new Error(`IR: Invalid RouteSpec — ${validation.error}`);

  return {
    id:          'callto-' + _irUuid(),
    source:      'guardian',
    instanceId:  IR_STATE.instanceId,
    intent,                           // capture | listen | inspect | forward | replay | analyze
    route:       routeSpec,
    delivery:    DELIVERY_MODES.AT_LEAST_ONCE,
    payload:     Object.freeze(payload ?? {}),
    fingerprint: payload?.fingerprint ?? {},
    state:       CALLTO_STATES.CREATED,
    createdAt:   Date.now(),
    ttl:         30000,               // 30s default TTL
    retryCount:  0,
    routeTrace:  [],                  // populated as packet moves through system
  };
}

// ── Route Executor ────────────────────────────────────────────────────────────

const _customRoutes = new Map();

function registerCustomRoute(name, fn) {
  if (typeof fn !== 'function') throw new Error('Custom route must be a function');
  _customRoutes.set(name, fn);
}

async function executeRoute(routeSpec, callto, context = {}) {
  const { nexusUrl = IR_STATE.nexusUrl, bridgeUrl = IR_STATE.bridgeUrl } = context;

  // Attach trace entry
  callto.routeTrace.push({ type: routeSpec.type, ts: Date.now() });
  callto.state = CALLTO_STATES.DISPATCHED;

  switch (routeSpec.type) {

    case 'nexus': {
      callto.state = CALLTO_STATES.IN_TRANSIT;
      try {
        const res = await fetch(nexusUrl + '/ingest', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ ...callto, routeType: 'nexus' }),
          signal:  AbortSignal.timeout(5000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const ack = await res.json();
        callto.state = CALLTO_STATES.ACKNOWLEDGED;
        _irLog('nexus', callto.id, 'ACK', ack);
        return { ok: true, ack, route: 'nexus' };
      } catch (e) {
        callto.state = CALLTO_STATES.FAILED;
        _irLog('nexus', callto.id, 'FAIL', e.message);
        _enqueueRetry(callto, routeSpec, context);
        return { ok: false, reason: e.message, route: 'nexus' };
      }
    }

    case 'local': {
      try {
        const stored = await _getLocalStore();
        stored.push({ ...callto, storedAt: Date.now() });
        // Keep last 500 locally
        if (stored.length > 500) stored.splice(0, stored.length - 500);
        await _setLocalStore(stored);
        callto.state = CALLTO_STATES.STORED;
        _irLog('local', callto.id, 'STORED');
        return { ok: true, route: 'local', count: stored.length };
      } catch (e) {
        callto.state = CALLTO_STATES.FAILED;
        return { ok: false, reason: e.message, route: 'local' };
      }
    }

    case 'analyze': {
      // URCK ingest only — no outbound
      callto.state = CALLTO_STATES.ACKNOWLEDGED;
      _irLog('analyze', callto.id, 'ANALYZED');
      return { ok: true, route: 'analyze', analyzed: true };
    }

    case 'pipeline': {
      let current = callto;
      const results = [];
      for (const step of routeSpec.steps) {
        const r = await executeRoute(step, current, context);
        results.push(r);
        if (!r.ok && routeSpec.failFast !== false) {
          return { ok: false, reason: `Pipeline step [${step.type}] failed: ${r.reason}`, results, route: 'pipeline' };
        }
      }
      callto.state = CALLTO_STATES.ACKNOWLEDGED;
      return { ok: true, route: 'pipeline', results };
    }

    case 'mesh': {
      const nodes = IR_STATE.discoveredNodes;
      if (!nodes.size) return { ok: false, reason: 'No mesh nodes discovered', route: 'mesh' };
      const results = [];
      for (const [, node] of nodes) {
        if (node.status !== 'online') continue;
        try {
          const res = await fetch(`http://${node.ip}:${node.port}/ingest`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ ...callto, routeType: 'mesh', meshFrom: IR_STATE.instanceId }),
            signal:  AbortSignal.timeout(3000),
          });
          results.push({ nodeId: node.instanceId, ok: res.ok });
        } catch (e) {
          results.push({ nodeId: node.instanceId, ok: false, reason: e.message });
        }
      }
      callto.state = CALLTO_STATES.ACKNOWLEDGED;
      return { ok: true, route: 'mesh', results };
    }

    case 'device': {
      const node = IR_STATE.discoveredNodes.get(routeSpec.instanceId || routeSpec.nodeId);
      if (!node) return { ok: false, reason: `Device not found: ${routeSpec.instanceId || routeSpec.nodeId}`, route: 'device' };
      try {
        const res = await fetch(`http://${node.ip}:${node.port}/ingest`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ ...callto, routeType: 'device' }),
          signal:  AbortSignal.timeout(5000),
        });
        callto.state = res.ok ? CALLTO_STATES.ACKNOWLEDGED : CALLTO_STATES.FAILED;
        return { ok: res.ok, route: 'device', nodeId: node.instanceId };
      } catch (e) {
        callto.state = CALLTO_STATES.FAILED;
        return { ok: false, reason: e.message, route: 'device' };
      }
    }

    case 'conditional': {
      for (const rule of routeSpec.rules) {
        if (_evaluateRule(rule, callto, context)) {
          return await executeRoute(rule.route, callto, context);
        }
      }
      // No rule matched — use fallback or fail
      if (routeSpec.fallback) return await executeRoute(routeSpec.fallback, callto, context);
      return { ok: false, reason: 'No conditional rule matched', route: 'conditional' };
    }

    case 'custom': {
      const fn = _customRoutes.get(routeSpec.name);
      if (!fn) return { ok: false, reason: `Custom route not registered: ${routeSpec.name}`, route: 'custom' };
      try {
        const result = await fn(callto, context);
        callto.state = result.ok ? CALLTO_STATES.ACKNOWLEDGED : CALLTO_STATES.FAILED;
        return { ...result, route: 'custom' };
      } catch (e) {
        callto.state = CALLTO_STATES.FAILED;
        return { ok: false, reason: e.message, route: 'custom' };
      }
    }

    default:
      return { ok: false, reason: `Unknown route type: ${routeSpec.type}`, route: 'unknown' };
  }
}

// ── Conditional Rule Evaluator ────────────────────────────────────────────────

function _evaluateRule(rule, callto, context) {
  const { condition } = rule;
  if (!condition) return false;
  const { field, op, value } = condition;

  let actual;
  switch (field) {
    case 'host':      actual = context.host || ''; break;
    case 'selector':  actual = callto.payload?.selector || ''; break;
    case 'intent':    actual = callto.intent; break;
    case 'source':    actual = callto.source; break;
    case 'confidence': actual = callto.fingerprint?.confidence ?? 1.0; break;
    default:          actual = null;
  }

  switch (op) {
    case 'eq':       return actual === value;
    case 'contains': return String(actual).includes(value);
    case 'lt':       return Number(actual) < Number(value);
    case 'gt':       return Number(actual) > Number(value);
    case 'matches':  return new RegExp(value).test(String(actual));
    default:         return false;
  }
}

// ── Retry Queue ───────────────────────────────────────────────────────────────

const _retryQueue = [];
const RETRY_BACKOFF = [1000, 5000, 15000, 60000]; // ms

function _enqueueRetry(callto, routeSpec, context) {
  if (callto.retryCount >= RETRY_BACKOFF.length) {
    _irLog('retry', callto.id, 'MAX_RETRIES_EXCEEDED');
    return;
  }
  const delay = RETRY_BACKOFF[callto.retryCount];
  callto.retryCount++;
  setTimeout(async () => {
    _irLog('retry', callto.id, `ATTEMPT_${callto.retryCount}`);
    callto.state = CALLTO_STATES.DISPATCHED;
    await executeRoute(routeSpec, callto, context);
  }, delay);
  _retryQueue.push({ calltoId: callto.id, retryAt: Date.now() + delay, attempt: callto.retryCount });
}

// ── Pulse / Heartbeat System ──────────────────────────────────────────────────

const IR_STATE = {
  instanceId:      _guardianUUID(),           // guardian-{uuid} — e.g. guardian-3000b1c2-0669-4d5a-a9b4-3f1e06cc4420
  logicalId:       'guardian',
  nexusUrl:        'http://127.0.0.1:3747', // bridge serves /pulse and /ingest
  bridgeUrl:       'http://127.0.0.1:3747',
  discoveredNodes: new Map(),               // instanceId → NodeEntry
  pulseInterval:   null,
  pulseLog:        [],                      // ring of last 100 pulse acks
};

// ── Guardian UUID — format: guardian-{uuid} per v3.1 spec
// e.g. guardian-3000b1c2-0669-4d5a-a9b4-3f1e06cc4420
// Opaque string. Must not encode meaning. Display ID is derived in UI only.
function _guardianUUID() {
  const raw = (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      });
  return 'guardian-' + raw;  // e.g. guardian-3000b1c2-0669-4d5a-a9b4-3f1e06cc4420
}

// Kept as alias for callto ID generation
function _irUuid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

/**
 * Pulse packet — emitted every ~1500ms
 * Nexus listens on /pulse and updates its node registry.
 */
function buildPulse() {
  return {
    type:         'guardian:pulse',
    logicalId:    IR_STATE.logicalId,
    instanceId:   IR_STATE.instanceId,
    ts:           Date.now(),
    port:         3747,
    nexusPort:    3748,
    capabilities: ['capture', 'callto:emit', 'listener', 'route', 'ir'],
    intents:      ['nexus', 'local', 'broadcast', 'pipeline', 'analyze'],
    version:      '3.0.0',
  };
}

async function emitPulse() {
  const pulse = buildPulse();
  try {
    const res = await fetch(IR_STATE.nexusUrl + '/pulse', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(pulse),
      signal:  AbortSignal.timeout(1200),
    });
    if (res.ok) {
      const ack = await res.json().catch(() => ({}));
      IR_STATE.pulseLog.push({ ts: Date.now(), ack: true });
      if (IR_STATE.pulseLog.length > 100) IR_STATE.pulseLog.shift();
      // Update discovered nodes from Nexus response
      if (Array.isArray(ack.nodes)) {
        for (const n of ack.nodes) {
          IR_STATE.discoveredNodes.set(n.instanceId, {
            ...n,
            lastSeen: Date.now(),
            status: 'online',
          });
        }
      }
    }
  } catch {
    // Pulse failure is silent — Nexus may be offline
  }
  // Expire stale nodes
  const now = Date.now();
  for (const [id, node] of IR_STATE.discoveredNodes) {
    if (now - node.lastSeen > 10000) {
      node.status = 'stale';
      if (now - node.lastSeen > 30000) IR_STATE.discoveredNodes.delete(id);
    }
  }
}

function startPulse(nexusUrl) {
  if (nexusUrl) IR_STATE.nexusUrl = nexusUrl;
  if (IR_STATE.pulseInterval) clearInterval(IR_STATE.pulseInterval);
  IR_STATE.pulseInterval = setInterval(emitPulse, 1500);
  emitPulse(); // immediate
}

function stopPulse() {
  if (IR_STATE.pulseInterval) clearInterval(IR_STATE.pulseInterval);
  IR_STATE.pulseInterval = null;
}

// ── Storage Helpers ───────────────────────────────────────────────────────────

async function _getLocalStore() {
  return new Promise(res => {
    browser.storage.local.get('ir_local_store', r => res(Array.isArray(r.ir_local_store) ? r.ir_local_store : []));
  });
}

async function _setLocalStore(data) {
  return browser.storage.local.set({ ir_local_store: data });
}

// Display ID — derived from instanceId for UI only. Never used for routing.
// Extracts first UUID segment: guardian-3000b1c2-... → "3000b1c2"
function guardianShortId(instanceId) {
  if (!instanceId) return '?';
  // Strip "guardian-" prefix, take first 8 chars of the UUID
  const raw = instanceId.startsWith('guardian-') ? instanceId.slice(9) : instanceId;
  return raw.slice(0, 8);
}

// Resolve node by instanceId — exact match first, then short-prefix match
function resolveNodeByInstanceId(instanceId) {
  if (!instanceId) return null;
  if (IR_STATE.discoveredNodes.has(instanceId)) return IR_STATE.discoveredNodes.get(instanceId);
  // Partial prefix match (user may paste just the display short ID)
  for (const [id, node] of IR_STATE.discoveredNodes) {
    if (id.startsWith(instanceId) || guardianShortId(id) === instanceId) return node;
  }
  return null;
}
function _irLog(route, calltoId, status, extra = null) {
  const entry = { route, calltoId: calltoId?.slice(-8), status, ts: Date.now() };
  if (extra) entry.extra = extra;
  // Emit as URCK event if available
  if (typeof URCK !== 'undefined') {
}
}

function irStats() {
  return {
    instanceId:     IR_STATE.instanceId,
    retryQueue:     _retryQueue.length,
    discoveredNodes: IR_STATE.discoveredNodes.size,
    pulseLog:       IR_STATE.pulseLog.slice(-10),
    customRoutes:   [..._customRoutes.keys()],
  };
}

// ── Exports ───────────────────────────────────────────────────────────────────

const IR = {
  createCallto:      createCalltoPacket,
  validate:          validateRouteSpec,
  execute:           executeRoute,
  registerRoute:     registerCustomRoute,
  startPulse,
  stopPulse,
  stats:             irStats,
  shortId:           guardianShortId,
  resolveNode:       resolveNodeByInstanceId,
  DELIVERY_MODES,
  CALLTO_STATES,
  ROUTE_TYPES,
  get instanceId()       { return IR_STATE.instanceId; },
  get shortId_()         { return guardianShortId(IR_STATE.instanceId); },
  get discoveredNodes()  { return IR_STATE.discoveredNodes; },
  get nexusUrl()         { return IR_STATE.nexusUrl; },
  set nexusUrl(v)        { IR_STATE.nexusUrl = v; },
  get bridgeUrl()        { return IR_STATE.bridgeUrl; },
  set bridgeUrl(v)       { IR_STATE.bridgeUrl = v; },
};

if (typeof window     !== 'undefined') window.IR     = IR;
if (typeof globalThis !== 'undefined') globalThis.IR = IR;
