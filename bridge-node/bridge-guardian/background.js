// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
// background.js — Guardian v3.3.1
// URCK migrated to Causal-Nexus protocol
// IR Layer integrated — ALL routing goes through IR
// Pulse system: instanceId = 'guardian' + uuid (multi-instance safe)
// RouteSpec engine wired to all callto dispatch

'use strict';

// ── IR Layer safety accessor ──────────────────────────────────────────────────
// ir-layer.js sets window.IR and globalThis.IR but 'const IR' is file-scoped.
// In Firefox MV2 background pages with strict mode, bare 'IR' may not resolve
// if the scripts haven't fully shared scope. This accessor guarantees access.
function _getIR() {
  if (typeof IR !== 'undefined') return IR;
  if (typeof globalThis !== 'undefined' && globalThis.IR) return globalThis.IR;
  if (typeof window !== 'undefined' && window.IR) return window.IR;
  return null;
}

const BRIDGE_URL_DEFAULT = 'http://127.0.0.1:3747';
const NEXUS_URL_DEFAULT  = 'http://127.0.0.1:3748';
let   BRIDGE_URL         = BRIDGE_URL_DEFAULT;
let   NEXUS_URL          = NEXUS_URL_DEFAULT;

// ─── State ────────────────────────────────────────────────────────────────────

const sessions   = new Map();  // tabId → { sessionId, url, ts }
const listeners  = new Map();  // listenerId → { tabId, selector, mode, linkTarget, active, log, eventCount }
const channel    = new BroadcastChannel('guardian-bridge');

// ─── Handshake state ──────────────────────────────────────────────────────────

let handshakeState = {
  status:        'disconnected',
  sessionToken:  null,
  bridgeVersion: null,
  lastAckTs:     null,
  failCount:     0,
  lastError:     null,
};

const HANDSHAKE_INTERVAL   = 8000;
const HANDSHAKE_TIMEOUT    = 4000;
const HANDSHAKE_FAIL_LIMIT = 3;

// ─── Load URLs from storage ───────────────────────────────────────────────────

async function loadUrls() {
  return new Promise(res => {
    browser.storage.local.get(['bridgeUrl', 'nexusUrl'], r => {
      BRIDGE_URL = r.bridgeUrl || BRIDGE_URL_DEFAULT;
      NEXUS_URL  = r.nexusUrl  || NEXUS_URL_DEFAULT;
      // Sync to IR layer
      if (typeof IR !== 'undefined') {
        _getIR().nexusUrl  = NEXUS_URL;
        _getIR().bridgeUrl = BRIDGE_URL;
      }
      res({ BRIDGE_URL, NEXUS_URL });
    });
  });
}

// ─── Bridge fetch ─────────────────────────────────────────────────────────────

async function bridgeFetch(path, method = 'GET', body = null, timeoutMs = 5000) {
  const url = BRIDGE_URL + path;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Guardian-Token': handshakeState.sessionToken || '' },
      signal:  controller.signal,
    };
    if (body) opts.body = JSON.stringify(body);
    const r = await fetch(url, opts);
    clearTimeout(timer);
    if (!r.ok) return { ok: false, data: null, reason: `HTTP ${r.status} ${r.statusText}`, code: r.status };
    const data = await r.json().catch(() => null);
    return { ok: true, data, reason: null };
  } catch (e) {
    clearTimeout(timer);
    let reason = 'Unknown error';
    if (e.name === 'AbortError')                     reason = `Bridge timeout after ${timeoutMs}ms — is it running at ${BRIDGE_URL}?`;
    else if (e.message?.includes('Failed to fetch')) reason = `Bridge unreachable at ${BRIDGE_URL} — check bridge server is running`;
    else if (e.message?.includes('NetworkError'))    reason = `Network error — bridge may have crashed`;
    else reason = e.message || 'Fetch failed';
    return { ok: false, data: null, reason, code: 'NETWORK_ERROR' };
  }
}

// ─── Handshake protocol ───────────────────────────────────────────────────────

async function performHandshake() {
  handshakeState.status = 'handshaking';

  const challenge = crypto.randomUUID();
  const payload = {
    type:            'guardian.handshake',
    challenge,
    guardianVersion: '3.0.0',
    urckVersion:     URCK.version,
    instanceId:      _getIR().instanceId,     // NEW: include IR instance ID
    ts:              Date.now(),
    capabilities:    ['callto', 'listener', 'link', 'snapshot', 'cookies', 'ir', 'route', 'pulse'],
  };

  const result = await bridgeFetch('/guardian/handshake', 'POST', payload, HANDSHAKE_TIMEOUT);

  if (!result.ok) {
    handshakeState.failCount++;
    handshakeState.lastError  = result.reason;
    handshakeState.status     = handshakeState.failCount >= HANDSHAKE_FAIL_LIMIT ? 'degraded' : 'disconnected';
    _broadcastHandshakeState();
    return false;
  }

  const { ack, version, token, capabilities } = result.data || {};
  if (!ack) {
    handshakeState.failCount++;
    handshakeState.lastError = 'Bridge rejected handshake (ack=false)';
    handshakeState.status    = 'disconnected';
    _broadcastHandshakeState();
    return false;
  }

  handshakeState.status        = 'connected';
  handshakeState.sessionToken  = token || challenge;
  handshakeState.bridgeVersion = version || 'unknown';
  handshakeState.lastAckTs     = Date.now();
  handshakeState.failCount     = 0;
  handshakeState.lastError     = null;

  // Ingest into Causal-Nexus URCK
  URCK.ingest('guardian.handshake.success', {
    bridgeVersion: version,
    capabilities,
    instanceId:    _getIR().instanceId,
    token:         (handshakeState.sessionToken || '').slice(0, 8) + '…',
  }, { source: 'background:handshake' });

  _broadcastHandshakeState();
  return true;
}

function _broadcastHandshakeState() {
  channel.postMessage({ type: 'HANDSHAKE_STATE', state: { ...handshakeState } });
}

// ─── Session Registry ─────────────────────────────────────────────────────────

async function registerSession(tabId, url) {
  const sessionId = crypto.randomUUID();
  sessions.set(tabId, { sessionId, url, ts: Date.now() });
  URCK.ingest('guardian.session.connect', { tabId, url, sessionId, instanceId: _getIR().instanceId }, { tabId, sessionId });
  const result = await bridgeFetch('/bus/emit', 'POST', { type: 'session.register', tabId, sessionId, url, instanceId: _getIR().instanceId });
  if (!result.ok) console.warn('[Guardian] Session register failed:', result.reason);
  return sessionId;
}

function getAllSessions() { return [...sessions.entries()].map(([tabId, s]) => ({ tabId, ...s })); }

// ─── Callto Registration via IR Layer ─────────────────────────────────────────

async function registerCalltoWithIR(callto, routeSpec) {
  if (!callto.id || !callto.selector) {
    return { ok: false, reason: 'Malformed callto — missing id or selector' };
  }

  // STEP 1: Log to URCK kernel immediately — before any network call
  // This ensures callto is in the event graph even if IR/bridge is offline
  const logEntry = URCK.ingest('guardian.callto.captured', {
    calltoId:  callto.id,
    selector:  callto.selector,
    label:     callto.label || callto.selector,
    action:    callto.action || 'click',
    url:       callto.url,
    host:      callto.host || '',
    ts:        callto.ts || Date.now(),
  }, { source: 'background:callto', url: callto.url });

  // STEP 2: Default route: Nexus if alive, else local
  const route = routeSpec || { type: 'pipeline', steps: [
    { type: 'nexus' },
    { type: 'local' },   // local as fallback/backup
  ]};

  const validation = _getIR().validate(route);
  if (!validation.valid) {
    return { ok: false, reason: `Invalid RouteSpec: ${validation.error}` };
  }

  try {
    const packet = _getIR().createCallto({ ...callto }, route, 'capture');
    const result = await _getIR().execute(route, packet, { nexusUrl: NEXUS_URL, bridgeUrl: BRIDGE_URL });

    // STEP 3: Register with bridge (legacy + callto index sync)
    bridgeFetch('/userscript/callto', 'POST', callto).catch(() => {});

    if (!result.ok) {
      URCK.ingest('guardian.callto.register.failed', {
        calltoId: callto.id,
        reason:   result.reason,
        route:    JSON.stringify(route),
      }, { source: 'background:ir' });
    } else {
      URCK.ingest('guardian.callto.register.ok', {
        calltoId:   callto.id,
        selector:   callto.selector,
        routeTrace: packet.routeTrace,
      }, { source: 'background:ir' });
    }

    return result;
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

// ─── Listener Engine ──────────────────────────────────────────────────────────

function createListener(opts) {
  const id = 'listener-' + crypto.randomUUID().slice(0, 8);
  const entry = {
    id,
    tabId:      opts.tabId,
    selector:   opts.selector,
    xpath:      opts.xpath,
    label:      opts.label || opts.selector,
    mode:       opts.mode || 'mutation',
    linkTarget: opts.linkTarget || null,
    url:        opts.url,
    active:     true,
    startTs:    Date.now(),
    eventCount: 0,
    log:        [],
  };
  listeners.set(id, entry);
  return entry;
}

function stopListener(id) {
  const l = listeners.get(id);
  if (!l) return false;
  l.active = false;
  browser.tabs.sendMessage(l.tabId, { type: 'STOP_LISTENER', listenerId: id }).catch(() => {});
  URCK.ingest('guardian.listener.stopped', { listenerId: id, eventCount: l.eventCount }, { tabId: l.tabId });
  return true;
}

function stopAllListeners() {
  for (const [id] of listeners) stopListener(id);
  listeners.clear();
}

// ─── Link Routing ─────────────────────────────────────────────────────────────

async function routeListenerEvent(listenerId, eventData) {
  const l = listeners.get(listenerId);
  if (!l || !l.active || !l.linkTarget) return;

  l.eventCount++;
  l.log.push({ ts: Date.now(), data: eventData });
  if (l.log.length > 200) l.log.shift();

  const target = l.linkTarget;
  let result;

  if (target.type === 'bridge') {
    const targetUrl = target.url || BRIDGE_URL;
    result = await fetch(targetUrl + '/bus/emit', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ type: 'guardian.link.event', listenerId, event: eventData, source: l.url }),
    }).then(r => ({ ok: r.ok, reason: r.ok ? null : `HTTP ${r.status}` }))
      .catch(e => ({ ok: false, reason: e.message }));

  } else if (target.type === 'callto') {
    result = await bridgeFetch(`/userscript/callto/${target.calltoId}/exec`, 'POST', { event: eventData, listenerId });

  } else if (target.type === 'url') {
    result = await fetch(target.url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ guardian: true, listenerId, event: eventData }),
    }).then(r => ({ ok: r.ok, reason: r.ok ? null : `HTTP ${r.status}` }))
      .catch(e => ({ ok: false, reason: e.message }));

  } else if (target.type === 'nexus') {
    // Route through IR layer to Nexus
    const route = { type: 'nexus' };
    const packet = _getIR().createCallto({ listenerId, event: eventData }, route, 'listen');
    result = await _getIR().execute(route, packet, { nexusUrl: NEXUS_URL });
  }

  if (result && !result.ok) {
    channel.postMessage({ type: 'ROUTE_FAILURE', listenerId, targetType: target.type, reason: result.reason });
    URCK.ingest('guardian.link.route.failed', { listenerId, targetType: target.type, reason: result.reason }, { tabId: l.tabId });
  }
}

// ─── ESC Global Killswitch ────────────────────────────────────────────────────

let _killswitchRunning = false;

function globalKillswitch(reason = 'ESC', originTabId = null) {
  if (_killswitchRunning) return;
  _killswitchRunning = true;
  stopAllListeners();
  browser.tabs.query({}).then(tabs => {
    for (const tab of tabs) {
      if (tab.id === originTabId) continue;
      browser.tabs.sendMessage(tab.id, { type: 'GLOBAL_KILLSWITCH', reason }).catch(() => {});
    }
    _killswitchRunning = false;
  }).catch(() => { _killswitchRunning = false; });
  URCK.ingest('guardian.killswitch', { reason, originTabId }, { source: 'background' });
  channel.postMessage({ type: 'KILLSWITCH', reason });
}

// ─── Manual Node Registry (for Devices tab) ──────────────────────────────────

async function getManualNodes() {
  return new Promise(res => {
    browser.storage.local.get('manual_nodes', r => res(Array.isArray(r.manual_nodes) ? r.manual_nodes : []));
  });
}

async function saveManualNode(node) {
  const nodes = await getManualNodes();
  const existing = nodes.findIndex(n => n.ip === node.ip && n.port === node.port);
  if (existing >= 0) nodes[existing] = node;
  else nodes.push(node);
  await browser.storage.local.set({ manual_nodes: nodes });
  return { ok: true, node };
}

async function removeManualNode(nodeId) {
  const nodes = await getManualNodes();
  const filtered = nodes.filter(n => n.id !== nodeId);
  await browser.storage.local.set({ manual_nodes: filtered });
  return { ok: true };
}

async function probeNode(ip, port) {
  try {
    const res = await fetch(`http://${ip}:${port}/pulse`, {
      method: 'GET',
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      return { reachable: true, latency: Date.now(), data };
    }
    return { reachable: false, reason: `HTTP ${res.status}` };
  } catch (e) {
    return { reachable: false, reason: e.message };
  }
}

// ─── Message Handler ──────────────────────────────────────────────────────────

browser.runtime.onMessage.addListener(async (msg, sender) => {
  const tabId = sender.tab?.id || msg.tabId;

  switch (msg.type) {

    case 'CALLTO_ADDED': {
      const { callto, routeSpec } = msg;
      const ev = URCK.ingest('guardian.bridge.callto', callto, {
        tabId, source: 'guardian:content', url: callto.url,
      });
      URCK.registerCallto(callto.id, ev.id);

      const result = await registerCalltoWithIR(callto, routeSpec || null);

      channel.postMessage({ type: 'CALLTO_ADDED', callto, ok: result.ok, reason: result.reason || null });
      return { ok: result.ok, seq: ev.seq, reason: result.reason, routeTrace: result.ack?.routeTrace };
    }

    case 'LISTENER_EVENT': {
      const { listenerId, eventData } = msg;
      if (listeners.get(listenerId)) {
        await routeListenerEvent(listenerId, eventData);
        channel.postMessage({ type: 'LISTENER_EVENT', listenerId, eventData });
      }
      return { ok: true };
    }

    case 'START_LISTENER': {
      const listener = createListener({ ...msg.config, tabId });
      await browser.tabs.sendMessage(tabId, {
        type: 'ATTACH_LISTENER', listenerId: listener.id,
        selector: listener.selector, xpath: listener.xpath, mode: listener.mode,
      });
      URCK.ingest('guardian.listener.started', { listenerId: listener.id, ...msg.config }, { tabId });
      channel.postMessage({ type: 'LISTENER_STARTED', listener });
      return { ok: true, listenerId: listener.id };
    }

    case 'STOP_LISTENER': {
      stopListener(msg.listenerId);
      channel.postMessage({ type: 'LISTENER_STOPPED', listenerId: msg.listenerId });
      return { ok: true };
    }

    case 'SET_LINK_TARGET': {
      const l = listeners.get(msg.listenerId);
      if (l) l.linkTarget = msg.linkTarget;
      return { ok: !!l };
    }

    case 'GLOBAL_KILLSWITCH': {
      globalKillswitch(msg.reason || 'manual', tabId);
      return { ok: true };
    }

    case 'FORCE_DISCONNECT': {
      // Full killswitch — stops everything including bridge connection + pulse
      globalKillswitch('force-disconnect', tabId);
      // Stop the bridge heartbeat interval if running
      if (typeof _bridgePulseInterval !== 'undefined' && _bridgePulseInterval) {
        clearInterval(_bridgePulseInterval);
        _bridgePulseInterval = null;
      }
      // Clear all sessions
      sessions.clear();
      // Broadcast to all tabs
      browser.tabs.query({}).then(tabs => {
        tabs.forEach(t => browser.tabs.sendMessage(t.id, { type: 'FORCE_DISCONNECT' }).catch(() => {}));
      });
      channel.postMessage({ type: 'FORCE_DISCONNECT' });
      return { ok: true };
    }

    case 'GET_LISTENERS': {
      return { listeners: [...listeners.values()].map(l => ({ ...l, log: l.log.slice(-20) })) };
    }

    case 'PICKER_CAPTURED': {
      const { fingerprint, selector, url } = msg;
      const s = sessions.get(tabId);
      const calltoId = 'callto-' + crypto.randomUUID().slice(0, 8);
      const event = URCK.ingest('guardian.picker.capture', {
        calltoId, fingerprint, selector, url, tabId,
      }, { tabId, sessionId: s?.sessionId, url });
      await bridgeFetch('/userscript/callto', 'POST', { id: calltoId, selector, fingerprint, tabId, url, seq: event.seq });
      channel.postMessage({ type: 'CAPTURE_DONE', calltoId, selector, url });
      return { ok: true, calltoId };
    }

    case 'COOKIES_CAPTURE': {
      const { cookies, url } = msg;
      URCK.ingest('guardian.cookies.capture', { cookies, url }, { tabId, url });
      await bridgeFetch('/data/cookies', 'POST', { cookies, url, tabId });
      return { ok: true };
    }

    case 'URCK_EVENT': {
      const { eventType, payload, meta } = msg;
      URCK.ingest(eventType, payload, { ...meta, tabId });
      return { ok: true };
    }

    case 'IR_ROUTE': {
      // Direct IR routing request from content/popup
      const { payload: routePayload, routeSpec, intent } = msg;
      const validation = _getIR().validate(routeSpec);
      if (!validation.valid) return { ok: false, reason: validation.error };

      // If device route uses instanceId, resolve ip/port from pulse registry
      let resolvedSpec = routeSpec;
      if (routeSpec.type === 'device' && routeSpec.instanceId && !routeSpec.ip) {
        const node = _getIR().resolveNode(routeSpec.instanceId);
        if (node) {
          resolvedSpec = { ...routeSpec, ip: node.ip, port: node.port };
          // Inject into discoveredNodes so executeRoute can find it
          _getIR().discoveredNodes.set(routeSpec.instanceId, node);
        } else {
          return { ok: false, reason: `Device instanceId not found in pulse registry: ${routeSpec.instanceId}` };
        }
      }

      try {
        const packet = _getIR().createCallto(routePayload, resolvedSpec, intent || 'capture');
        const result = await _getIR().execute(resolvedSpec, packet, { nexusUrl: NEXUS_URL, bridgeUrl: BRIDGE_URL });
        return { ok: result.ok, reason: result.reason, routeTrace: packet.routeTrace };
      } catch (e) {
        return { ok: false, reason: e.message };
      }
    }

    case 'GET_IR_STATS': {
      return { stats: _getIR().stats(), instanceId: _getIR().instanceId };
    }

    case 'GET_DISCOVERED_NODES': {
      const manual = await getManualNodes();
      const discovered = [...IR.discoveredNodes.values()];
      return { nodes: { discovered, manual } };
    }

    case 'ADD_MANUAL_NODE': {
      const node = {
        id:         'manual-' + crypto.randomUUID().slice(0, 8),
        ip:         msg.ip,
        port:       msg.port,
        label:      msg.label || `${msg.ip}:${msg.port}`,
        intent:     msg.intent || 'nexus',
        manual:     true,
        addedAt:    Date.now(),
        status:     'unknown',
        instanceId: msg.instanceId || null,
      };
      const probe = await probeNode(msg.ip, msg.port);
      node.status = probe.reachable ? 'online' : 'offline';
      node.latency = probe.latency || null;
      // If the probe returned a guardian instanceId, use it
      if (probe.data?.instanceId) node.instanceId = probe.data.instanceId;
      if (probe.data?.logicalId)  node.logicalId  = probe.data.logicalId;
      await saveManualNode(node);
      return { ok: true, node };
    }

    // ── Direct Guardian-to-Guardian connection via instanceId ─────────────
    // Looks up node from pulse registry first, falls back to IP+port manual add.
    case 'CONNECT_BY_INSTANCE_ID': {
      const { instanceId, label, intent } = msg;
      if (!instanceId) return { ok: false, reason: 'instanceId required' };

      // 1. Check pulse registry (Nexus-discovered nodes)
      const knownNode = _getIR().resolveNode(instanceId);
      if (knownNode) {
        // Already know this node — ensure it's in manual store for persistence
        const persistNode = {
          id:         'manual-' + crypto.randomUUID().slice(0, 8),
          ip:         knownNode.ip,
          port:       knownNode.port,
          label:      label || knownNode.logicalId || instanceId,
          intent:     intent || knownNode.intent || 'guardian',
          instanceId: knownNode.instanceId,
          logicalId:  knownNode.logicalId,
          manual:     true,
          addedAt:    Date.now(),
          status:     knownNode.status || 'online',
          source:     'instanceId',
        };
        await saveManualNode(persistNode);
        return { ok: true, node: persistNode, source: 'pulse_registry' };
      }

      // 2. Node not in pulse registry yet — need IP+port to connect
      // Return a partial result so popup can prompt for IP+port
      return {
        ok:      false,
        reason:  'Instance not found in pulse registry — enter IP and port to connect directly',
        partial: true,
        instanceId,
      };
    }

    case 'REMOVE_MANUAL_NODE': {
      return removeManualNode(msg.nodeId);
    }

    case 'PROBE_NODE': {
      return probeNode(msg.ip, msg.port);
    }

    case 'GET_SESSIONS':        { return { sessions: getAllSessions() }; }
    case 'GET_CAPTURES':        { return { captures: URCK.captures(), seq: URCK.clock.seq, version: URCK.version }; }
    case 'BRIDGE_FETCH':        { const r = await bridgeFetch(msg.path, msg.method, msg.body); return { result: r.data, ok: r.ok, reason: r.reason }; }
    case 'PING':                { return { pong: true }; }
    case 'GET_HANDSHAKE_STATE': { return { state: { ...handshakeState } }; }
    case 'FORCE_HANDSHAKE':     { const ok = await performHandshake(); return { ok, state: { ...handshakeState } }; }
  }
});

// ─── Tab Lifecycle ────────────────────────────────────────────────────────────

browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url?.startsWith('http')) {
    if (!sessions.has(tabId)) {
      await registerSession(tabId, tab.url);
    } else {
      const s = sessions.get(tabId);
      sessions.set(tabId, { ...s, url: tab.url });
      // URCK.ingest removed: tab.navigate fires on every navigation (high volume)
    }
    for (const [lid, l] of listeners) {
      if (l.tabId === tabId && l.active) {
        browser.tabs.sendMessage(tabId, {
          type: 'ATTACH_LISTENER', listenerId: lid,
          selector: l.selector, xpath: l.xpath, mode: l.mode,
        }).catch(() => {});
      }
    }
  }
});

browser.tabs.onRemoved.addListener(tabId => {
  const s = sessions.get(tabId);
  if (s) {
    URCK.ingest('guardian.session.disconnect', { tabId, sessionId: s.sessionId }, { tabId });
    sessions.delete(tabId);
  }
  for (const [lid, l] of listeners) {
    if (l.tabId === tabId) { l.active = false; listeners.delete(lid); }
  }
});

// ─── Heartbeat + Handshake Loop ───────────────────────────────────────────────

async function heartbeatTick() {
  if (handshakeState.status !== 'connected') {
    await performHandshake();
    return;
  }

  const result = await bridgeFetch('/guardian/heartbeat', 'POST', {
    token:         handshakeState.sessionToken,
    ts:            Date.now(),
    instanceId:    _getIR().instanceId,
    listenerCount: listeners.size,
    sessionCount:  sessions.size,
    irStats:       _getIR().stats(),
  }, 2500);

  if (!result.ok) {
    handshakeState.failCount++;
    handshakeState.lastError = result.reason;
    if (handshakeState.failCount >= HANDSHAKE_FAIL_LIMIT) {
      handshakeState.status = 'degraded';
      channel.postMessage({ type: 'CONNECTION_DEGRADED', reason: result.reason, fails: handshakeState.failCount });
    }
  } else {
    handshakeState.failCount = 0;
    handshakeState.lastAckTs = Date.now();
    if (handshakeState.status === 'degraded') {
      handshakeState.status = 'connected';
      channel.postMessage({ type: 'CONNECTION_RESTORED' });
    }
  }

  channel.postMessage({
    type:           'HEARTBEAT',
    alive:          result.ok,
    sessions:       getAllSessions().length,
    listenerCount:  listeners.size,
    handshake:      { ...handshakeState },
    instanceId:     _getIR().instanceId,
    discoveredNodes: _getIR().discoveredNodes.size,
    ts:             Date.now(),
  });
}

setInterval(heartbeatTick, HANDSHAKE_INTERVAL);

// ─── Storage Change Listener ──────────────────────────────────────────────────

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.bridgeUrl) {
    BRIDGE_URL = changes.bridgeUrl.newValue || BRIDGE_URL_DEFAULT;
    _getIR().bridgeUrl = BRIDGE_URL;
    handshakeState.status = 'disconnected';
    performHandshake();
  }
  if (changes.nexusUrl) {
    NEXUS_URL = changes.nexusUrl.newValue || NEXUS_URL_DEFAULT;
    _getIR().nexusUrl  = NEXUS_URL;
    _getIR().stopPulse();
    _getIR().startPulse(NEXUS_URL);
  }
});

// ─── Init ─────────────────────────────────────────────────────────────────────

(async () => {
  await loadUrls();

  // Start pulse with our instanceId
  const _ir = _getIR();
  if (!_ir) {
    console.error('[Guardian] CRITICAL: IR layer not loaded — check ir-layer.js is in manifest scripts');
  } else {
    _ir.startPulse(NEXUS_URL);
  }
  URCK.ingest('guardian.init', {
    instanceId: _getIR().instanceId,
    version:    '3.0.0',
    bridgeUrl:  BRIDGE_URL,
    nexusUrl:   NEXUS_URL,
  }, { source: 'background:init' });

  // Register existing tabs
  const tabs = await browser.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  for (const tab of tabs) {
    if (tab.id && tab.url) await registerSession(tab.id, tab.url);
  }

  await performHandshake();

  console.log(`[Guardian v3.0.0] background ready — ${tabs.length} tabs · bridge: ${BRIDGE_URL} · nexus: ${NEXUS_URL} · instanceId: ${_getIR()?.instanceId}`);
})();
