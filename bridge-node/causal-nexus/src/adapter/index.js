// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
/**
 * @module       adapter
 * @uuid         dc2cfbff-daf6-42f5-9a56-8039854403aa
 * @version      5.0.0
 *
 * Bridge translation layer. Converts raw bridge bus events into typed
 * kernel events with proper causedBy linkage and edgeType declaration.
 *
 * Three paths share the unified calltoMap (F-011):
 *   handle()            — bridge bus events (pw:*, element:*, page:*, dom:*)
 *   handleDispatcher()  — dispatcher API (commandRunning/Success/Failed)
 *   handleObserver()    — observer API (dom:changed, page:navigated)
 *
 * S-1: srcBusEvent NOT stored — only srcBusName. Replay reconstructs from payload.
 * F-012: unmapped bus events emit system:bus:unknown instead of throwing.
 *
 * @hook e7790fe9-9c0a-46ff-92f7-a11a2ab8d639  createAdapter
 */

import { EDGE_CAUSAL_ADAPTER, EDGE_CAUSAL_EXPLICIT } from '../causality/index.js';

const DIRECT_MAP = {
  'pw:cookies:captured':    'cookies:captured',
  'pw:cookies:injected':    'cookies:injected',
  'pw:dom:snapshot':        'dom:snapshot',
  'element:batch:resolved': 'batch:resolved',
  'page:navigated':         'page:navigated',
  'page:ready':             'page:ready',
  'page:unloading':         'page:unloading',
  'dom:changed':            'dom:changed',
};

function busSource(busName) {
  if (busName.startsWith('pw:'))      return 'bridge:mirror';
  if (busName.startsWith('element:')) return 'bridge:element-api';
  return 'bridge:connector';
}

/**
 * @hook e7790fe9-9c0a-46ff-92f7-a11a2ab8d639  adapter:createAdapter
 */
export function createAdapter(kernel) {

  // ── handle() — bridge bus events ─────────────────────────────────────────

  function handle(busName, payload, opts = {}) {
    const p    = (payload && payload.data) ? payload.data : payload;
    const base = {
      sessionId:   p.sessionUuid  || p.sessionId  || null,
      tabId:       p.tabId        || null,
      srcBusName:  busName,
      replayOf:    opts.replayOf    || null,
      origEventTs: opts.origEventTs || null,
    };

    // callto:running — register the callto so the resolved/error path can link it
    if (busName === 'element:callto:running') {
      const id = p.calltoId || p.id;
      const ev = kernel.ingest('command:running', p, {
        ...base, source: 'bridge:element-api', edgeType: EDGE_CAUSAL_EXPLICIT,
      });
      if (id) kernel.registerCallto(id, ev.id);
      return ev;
    }

    // callto:resolved — resolve causedBy from calltoMap
    if (busName === 'element:callto:resolved') {
      const id       = p.calltoId || p.id;
      const causedBy = id ? kernel.resolveCallto(id) : null;
      return kernel.ingest(p.status === 'ok' ? 'command:success' : 'command:failed', p, {
        ...base, source: 'bridge:element-api',
        causedBy,
        edgeType: causedBy ? EDGE_CAUSAL_ADAPTER : EDGE_CAUSAL_EXPLICIT,
      });
    }

    // callto:error — resolve causedBy from calltoMap
    if (busName === 'element:callto:error') {
      const id       = p.calltoId || p.id;
      const causedBy = id ? kernel.resolveCallto(id) : null;
      return kernel.ingest('command:failed', p, {
        ...base, source: 'bridge:element-api',
        causedBy,
        edgeType: causedBy ? EDGE_CAUSAL_ADAPTER : EDGE_CAUSAL_EXPLICIT,
      });
    }

    // pw:element:result
    if (busName === 'pw:element:result') {
      return kernel.ingest(p.ok === true ? 'command:success' : 'command:failed', p, {
        ...base, source: 'bridge:mirror', edgeType: EDGE_CAUSAL_EXPLICIT,
      });
    }

    // Direct map
    const mapped = DIRECT_MAP[busName];
    if (mapped) {
      return kernel.ingest(mapped, p, {
        ...base, source: busSource(busName), edgeType: EDGE_CAUSAL_EXPLICIT,
      });
    }

    // F-012: unmapped — observable, not thrown
    kernel.ingest('system:bus:unknown', { busName, payloadKeys: Object.keys(p || {}) }, {
      source: 'kernel:adapter', edgeType: null,
    });
    return null;
  }

  // ── handleDispatcher() — dispatcher API ──────────────────────────────────

  function handleDispatcher(name, payload) {
    const base = {
      sessionId: payload.sessionUuid || payload.sessionId || null,
      tabId:     payload.tabId       || null,
    };

    if (name === 'commandRunning') {
      const ev = kernel.ingest('command:running', payload, {
        ...base, source: 'dispatcher', edgeType: EDGE_CAUSAL_EXPLICIT,
      });
      if (payload.commandId) kernel.registerCallto(payload.commandId, ev.id);
      return ev;
    }

    if (name === 'commandSuccess') {
      const causedBy = payload.commandId ? kernel.resolveCallto(payload.commandId) : null;
      return kernel.ingest('command:success', payload, {
        ...base, source: 'dispatcher',
        causedBy,
        edgeType: causedBy ? EDGE_CAUSAL_ADAPTER : EDGE_CAUSAL_EXPLICIT,
      });
    }

    if (name === 'commandFailed') {
      const causedBy = payload.commandId ? kernel.resolveCallto(payload.commandId) : null;
      return kernel.ingest('command:failed', payload, {
        ...base, source: 'dispatcher',
        causedBy,
        edgeType: causedBy ? EDGE_CAUSAL_ADAPTER : EDGE_CAUSAL_EXPLICIT,
      });
    }

    kernel.ingest('system:bus:unknown', { busName: name, payloadKeys: Object.keys(payload || {}) }, {
      source: 'kernel:dispatcher', edgeType: null,
    });
    return null;
  }

  // ── handleObserver() — observer API ──────────────────────────────────────

  function handleObserver(name, payload) {
    const base = {
      sessionId: payload.sessionUuid || payload.sessionId || null,
      tabId:     payload.tabId       || null,
    };

    if (name === 'dom:changed')    return kernel.ingest('dom:changed',    payload, { ...base, source: 'observer' });
    if (name === 'page:navigated') return kernel.ingest('page:navigated', payload, { ...base, source: 'observer' });

    kernel.ingest('system:bus:unknown', { busName: name, payloadKeys: Object.keys(payload || {}) }, {
      source: 'kernel:observer',
    });
    return null;
  }

  // ── replayEvent() — replay from stored srcBusName ────────────────────────

  function replayEvent(origEvent) {
    if (!origEvent.srcBusName) return null;
    // S-1: srcBusEvent not stored — replay uses ev.payload
    return handle(origEvent.srcBusName, origEvent.payload, {
      replayOf:    origEvent.id,
      origEventTs: origEvent.eventTs,
    });
  }

  return { handle, handleDispatcher, handleObserver, replayEvent };
}
