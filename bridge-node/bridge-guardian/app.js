// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
// app.js — Guardian v4.0.0 · Master Orchestrator
// Spec: Guardian Rebuild v1.0 — 04/27/2026
//
// This file owns the event bus and wires every module together.
// NO module-to-module imports. Only app.js imports modules.
// Boot sequence matches §3 of the spec exactly.

'use strict';

/* ── Internal event bus ───────────────────────────────────────────────────── */
const _handlers = new Map(); // event → [handler, ...]
const BUS = {
  on(event, fn)  { if (!_handlers.has(event)) _handlers.set(event, []); _handlers.get(event).push(fn); },
  emit(event, data) {
    (_handlers.get(event) || []).forEach(fn => { try { fn(data); } catch (e) { console.warn('[BUS] handler error', event, e); } });
    (_handlers.get('*')   || []).forEach(fn => { try { fn({ event, data }); } catch {} });
  },
  off(event, fn) {
    const h = _handlers.get(event);
    if (h) { const i = h.indexOf(fn); if (i !== -1) h.splice(i, 1); }
  },
};

/* ── IR Layer safety accessor ─────────────────────────────────────────────── */
function _getIR() {
  if (typeof IR !== 'undefined') return IR;
  if (typeof globalThis !== 'undefined' && globalThis.IR) return globalThis.IR;
  if (typeof window !== 'undefined' && window.IR) return window.IR;
  return null;
}

const BRIDGE_URL_DEFAULT = 'http://127.0.0.1:3747';
let   BRIDGE_URL         = BRIDGE_URL_DEFAULT;

/* ── BroadcastChannel (popup ↔ background) ───────────────────────────────── */
const channel = new BroadcastChannel('guardian-bridge');

/* ─── Config ─────────────────────────────────────────────────────────────── */
let config = {
  bridgeUrl:  BRIDGE_URL_DEFAULT,
  appId:      null,
  identities: {},
};

async function loadConfig() {
  return new Promise(res => {
    browser.storage.local.get(['bridgeUrl', 'appId', 'identities'], r => {
      config.bridgeUrl  = r.bridgeUrl  || BRIDGE_URL_DEFAULT;
      config.appId      = r.appId      || null;
      config.identities = r.identities || {};
      BRIDGE_URL        = config.bridgeUrl;
      res(config);
    });
  });
}

/* ─── Bridge fetch (shared by all modules) ──────────────────────────────── */
let _sessionToken = null;

async function bridgeFetch(path, method = 'GET', body = null, timeoutMs = 5000) {
  const url = BRIDGE_URL + path;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Guardian-Token': _sessionToken || '' },
      signal:  ctrl.signal,
    };
    if (body) opts.body = JSON.stringify(body);
    const r = await fetch(url, opts);
    clearTimeout(timer);
    if (!r.ok) return { ok: false, data: null, reason: `HTTP ${r.status}`, code: r.status };
    const data = await r.json().catch(() => null);
    return { ok: true, data };
  } catch (e) {
    clearTimeout(timer);
    const reason = e.name === 'AbortError' ? `Timeout after ${timeoutMs}ms`
                 : e.message?.includes('Failed to fetch') ? `Bridge unreachable at ${BRIDGE_URL}`
                 : e.message || 'Fetch failed';
    return { ok: false, data: null, reason, code: 'NETWORK_ERROR' };
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   MODULE 1: node/index.js  — mesh identity
═══════════════════════════════════════════════════════════════════════════ */
let NODE = {
  instanceId:  null,
  shortId:     null,
  meshShortId: null,
  knownNodes:  new Map(), // instanceId → nodeInfo
};

async function initNodeIdentity() {
  return new Promise(res => {
    browser.storage.local.get('guardianInstanceId', r => {
      NODE.instanceId = r.guardianInstanceId || 'guardian-' + crypto.randomUUID();
      NODE.shortId    = NODE.instanceId.slice(0, 8);
      if (!r.guardianInstanceId) {
        browser.storage.local.set({ guardianInstanceId: NODE.instanceId });
      }
      res(NODE);
    });
  });
}

function resolveNode(instanceId) {
  return NODE.knownNodes.get(instanceId) || null;
}

function updateKnownNodes(nodes = []) {
  for (const n of nodes) {
    if (n.instanceId || n.uuid) {
      const id = n.instanceId || n.uuid;
      NODE.knownNodes.set(id, { ...n, lastSeen: Date.now() });
    }
  }
  BUS.emit('node:registry:updated', { count: NODE.knownNodes.size });
}

/* ═══════════════════════════════════════════════════════════════════════════
   MODULE 2: heartbeat/pulse.js  — mesh presence broadcast
═══════════════════════════════════════════════════════════════════════════ */
const PULSE_INTERVAL = 5000;
let _pulseTimer = null;

async function sendPulse() {
  const result = await bridgeFetch('/pulse', 'POST', {
    instanceId:   NODE.instanceId,
    shortId:      NODE.shortId,
    version:      '4.0.0',
    capabilities: ['callto', 'listener', 'link', 'snapshot', 'ir', 'route'],
    intents:      Object.keys(config.identities),
    ts:           Date.now(),
  });
  if (result.ok) {
    updateKnownNodes(result.data?.nodes || []);
    BUS.emit('pulse:ack', { nodes: NODE.knownNodes.size });
  } else {
    BUS.emit('pulse:fail', { reason: result.reason });
  }
}

function startPulse() {
  if (_pulseTimer) clearInterval(_pulseTimer);
  sendPulse();
  _pulseTimer = setInterval(sendPulse, PULSE_INTERVAL);
}

function stopPulse() {
  if (_pulseTimer) { clearInterval(_pulseTimer); _pulseTimer = null; }
}

/* ═══════════════════════════════════════════════════════════════════════════
   MODULE 3: heartbeat/heartbeat.js  — health + session watchdog
═══════════════════════════════════════════════════════════════════════════ */
const HEARTBEAT_INTERVAL   = 8000;
const HEARTBEAT_TIMEOUT    = 4000;
const HEARTBEAT_FAIL_LIMIT = 3;

let _hbTimer   = null;
let _hbFails   = 0;
let _hbStatus  = 'disconnected'; // disconnected | handshaking | connected | degraded
let _hbLastAck = null;

async function performHandshake() {
  _hbStatus = 'handshaking';
  BUS.emit('handshake:start', {});

  const payload = {
    type:            'guardian.handshake',
    challenge:       crypto.randomUUID(),
    appId:           config.appId || undefined,
    guardianVersion: '4.0.0',
    instanceId:      NODE.instanceId,
    ts:              Date.now(),
    capabilities:    ['callto', 'listener', 'link', 'snapshot', 'cookies', 'ir', 'route', 'pulse'],
  };

  const result = await bridgeFetch('/guardian/handshake', 'POST', payload, HEARTBEAT_TIMEOUT);

  if (!result.ok) {
    _hbFails++;
    _hbStatus = _hbFails >= HEARTBEAT_FAIL_LIMIT ? 'degraded' : 'disconnected';
    BUS.emit('handshake:fail', { reason: result.reason, fails: _hbFails, status: _hbStatus });
    channel.postMessage({ type: 'HANDSHAKE_STATE', state: getHandshakeState() });
    return false;
  }

  const { ack, token, meshShortId, nodes } = result.data || {};
  if (!ack || !token) {
    _hbFails++;
    _hbStatus = 'disconnected';
    BUS.emit('handshake:fail', { reason: 'Missing ack/token', fails: _hbFails });
    return false;
  }

  _sessionToken       = token;
  NODE.meshShortId    = meshShortId || null;
  _hbFails            = 0;
  _hbStatus           = 'connected';
  _hbLastAck          = Date.now();

  updateKnownNodes(nodes || []);
  BUS.emit('handshake:ok', { token: token.slice(0, 8) + '…', meshShortId, nodes: NODE.knownNodes.size });
  channel.postMessage({ type: 'HANDSHAKE_STATE', state: getHandshakeState() });
  return true;
}

async function heartbeatTick() {
  if (_hbStatus !== 'connected') {
    await performHandshake();
    return;
  }

  const result = await bridgeFetch('/guardian/heartbeat', 'POST', {
    token:         _sessionToken,
    instanceId:    NODE.instanceId,
    listenerCount: LISTENER_COUNT(),
    sessionCount:  SESSION_COUNT(),
    ts:            Date.now(),
  }, HEARTBEAT_TIMEOUT);

  if (!result.ok) {
    _hbFails++;
    if (result.data?.reauth || _hbFails >= HEARTBEAT_FAIL_LIMIT) {
      _hbStatus     = 'degraded';
      _sessionToken = null;
      BUS.emit('heartbeat:reauth', { fails: _hbFails });
    } else {
      BUS.emit('heartbeat:fail', { reason: result.reason, fails: _hbFails });
    }
  } else {
    _hbFails   = 0;
    _hbLastAck = Date.now();
    updateKnownNodes(result.data?.nodes || []);
    BUS.emit('heartbeat:ok', { nodes: NODE.knownNodes.size, ts: _hbLastAck });
  }

  channel.postMessage({ type: 'HEARTBEAT', state: getHandshakeState(), nodes: NODE.knownNodes.size, ts: Date.now() });
}

function startHeartbeat() {
  if (_hbTimer) clearInterval(_hbTimer);
  heartbeatTick();
  _hbTimer = setInterval(heartbeatTick, HEARTBEAT_INTERVAL);
}

function getHandshakeState() {
  return {
    status:        _hbStatus,
    sessionToken:  _sessionToken ? _sessionToken.slice(0, 8) + '…' : null,
    lastAckTs:     _hbLastAck,
    failCount:     _hbFails,
    meshShortId:   NODE.meshShortId,
    instanceId:    NODE.instanceId,
  };
}

// Placeholder counters — filled by module init
let LISTENER_COUNT = () => 0;
let SESSION_COUNT  = () => 0;

/* ═══════════════════════════════════════════════════════════════════════════
   MODULE 4: router/intent-router.js
═══════════════════════════════════════════════════════════════════════════ */
// Maps intent types to identity + callto combinations
const INTENT_HANDLERS = {
  code:     (intent) => routeToIdentity(intent, 'type'),
  chat:     (intent) => routeToIdentity(intent, 'type'),
  ideas:    (intent) => routeToIdentity(intent, 'read'),
  research: (intent) => routeToIdentity(intent, 'read'),
  loop:     (intent) => runFeedbackLoop(intent),
  custom:   (intent) => routeCustomCallto(intent),
};

async function dispatchIntent(intent) {
  const handler = INTENT_HANDLERS[intent.type];
  if (!handler) { BUS.emit('intent:unknown', intent); return { ok: false, reason: `Unknown intent: ${intent.type}` }; }
  BUS.emit('intent:start', intent);
  try {
    const result = await handler(intent);
    BUS.emit('intent:done', { ...intent, result });
    return result;
  } catch (e) {
    BUS.emit('intent:error', { ...intent, error: e.message });
    return { ok: false, reason: e.message };
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   MODULE 5: router/identity-router.js
═══════════════════════════════════════════════════════════════════════════ */
const BUILT_IN_IDENTITIES = {
  chatgpt: { id: 'chatgpt', name: 'ChatGPT',  url: 'https://chatgpt.com',        inputSelector: '#prompt-textarea',    outputSelector: '[data-message-author-role="assistant"]' },
  claude:  { id: 'claude',  name: 'Claude',   url: 'https://claude.ai/new',      inputSelector: '[contenteditable]',   outputSelector: '[data-is-streaming]' },
  gemini:  { id: 'gemini',  name: 'Gemini',   url: 'https://gemini.google.com',  inputSelector: '.ql-editor',          outputSelector: '.response-container' },
  ollama:  { id: 'ollama',  name: 'Ollama',   url: 'http://localhost:11434',      inputSelector: null,                  outputSelector: null, apiMode: true },
};

function getIdentity(name) {
  return BUILT_IN_IDENTITIES[name] || config.identities[name] || null;
}

async function routeToIdentity(intent, action) {
  const identity = getIdentity(intent.identity || 'chatgpt');
  if (!identity) return { ok: false, reason: `Unknown identity: ${intent.identity}` };

  // For API-mode identities (Ollama), route through bridge
  if (identity.apiMode) {
    return bridgeFetch('/callto', 'POST', {
      action:   'api.invoke',
      origin:   identity.url,
      selector: null,
      params:   { text: intent.text, model: intent.model || 'llama3' },
      tag:      'intent.' + intent.type,
    }).then(r => r.data || r);
  }

  // For browser identities, find/open the tab and dispatch callto
  const tab = await findOrOpenTab(identity.url);
  if (!tab) return { ok: false, reason: `Could not open tab for ${identity.name}` };

  const calltoResult = await browser.tabs.sendMessage(tab.id, {
    type:     'NEXUS_CMD',
    cmd: {
      type:     action === 'type' ? 'type' : 'read',
      selector: action === 'type' ? identity.inputSelector : identity.outputSelector,
      value:    intent.text || undefined,
    },
  }).catch(e => ({ ok: false, reason: e.message }));

  return calltoResult;
}

async function findOrOpenTab(url) {
  const origin = new URL(url).origin;
  const tabs   = await browser.tabs.query({ url: origin + '/*' });
  if (tabs.length) return tabs[0];
  const newTab = await browser.tabs.create({ url, active: false });
  await new Promise(res => setTimeout(res, 2000)); // wait for load
  return newTab;
}

async function runFeedbackLoop(intent) {
  const { chain = [], text } = intent;
  if (!chain.length) return { ok: false, reason: 'loop intent requires chain[]' };
  let lastOutput = text;
  const results  = [];
  for (const step of chain) {
    const result = await routeToIdentity({ ...intent, identity: step, type: 'code', text: lastOutput }, 'type');
    results.push({ identity: step, result });
    // Wait for response and read it
    const identity = getIdentity(step);
    if (identity?.outputSelector) {
      const tab = await findOrOpenTab(identity.url);
      if (tab) {
        await new Promise(r => setTimeout(r, 3000));
        const readResult = await browser.tabs.sendMessage(tab.id, {
          type: 'NEXUS_CMD', cmd: { type: 'read', selector: identity.outputSelector },
        }).catch(() => null);
        lastOutput = readResult?.result?.text || lastOutput;
      }
    }
    BUS.emit('loop:step', { step, result, nextInput: lastOutput });
  }
  return { ok: true, results, finalOutput: lastOutput };
}

async function routeCustomCallto(intent) {
  const { calltoUuid, params } = intent;
  return bridgeFetch('/callto/' + calltoUuid, 'POST', params || {}).then(r => r.data || r);
}

/* ═══════════════════════════════════════════════════════════════════════════
   MODULE 6: router/node-router.js
═══════════════════════════════════════════════════════════════════════════ */
async function routeToNode(instanceId, callto) {
  const node = NODE.knownNodes.get(instanceId);
  if (!node) {
    // Try bridge resolution
    const r = await bridgeFetch(`/nodes`, 'GET');
    const found = (r.data?.nodes || []).find(n => n.uuid === instanceId || n.instanceId === instanceId);
    if (!found) return { ok: false, reason: `Node ${instanceId} not found in mesh` };
    NODE.knownNodes.set(instanceId, { ...found, lastSeen: Date.now() });
  }
  return bridgeFetch('/callto', 'POST', { ...callto, _targetInstanceId: instanceId });
}

/* ═══════════════════════════════════════════════════════════════════════════
   TAB/SESSION TRACKING  (shared state for heartbeat counters)
═══════════════════════════════════════════════════════════════════════════ */
const sessions  = new Map(); // tabId → { sessionId, url }
const listeners = new Map(); // listenerId → listener

LISTENER_COUNT = () => listeners.size;
SESSION_COUNT  = () => sessions.size;

function getAllSessions() { return [...sessions.values()]; }

async function registerSession(tabId, url) {
  const sessionId = 'sess-' + crypto.randomUUID().slice(0, 8);
  sessions.set(tabId, { sessionId, url, tabId, connectedAt: Date.now() });
  URCK.ingest('guardian.session.connect', { tabId, sessionId, url }, { tabId });
  BUS.emit('session:connect', { tabId, sessionId, url });
  return sessionId;
}

/* ═══════════════════════════════════════════════════════════════════════════
   MESSAGE ROUTER  (browser.runtime.onMessage)
═══════════════════════════════════════════════════════════════════════════ */
browser.runtime.onMessage.addListener((msg, sender) => {
  const tabId = sender.tab?.id;

  switch (msg.type) {
    case 'GUARDIAN_INIT':
      return Promise.resolve({ ok: true, instanceId: NODE.instanceId, shortId: NODE.shortId, bridgeUrl: BRIDGE_URL });

    case 'DISPATCH_INTENT':
      return dispatchIntent(msg.intent);

    case 'ROUTE_TO_NODE':
      return routeToNode(msg.instanceId, msg.callto);

    case 'REGISTER_LISTENER': {
      const lid = 'lsn-' + crypto.randomUUID().slice(0, 8);
      listeners.set(lid, { ...msg.listener, tabId, active: true, log: [], eventCount: 0 });
      URCK.ingest('guardian.listener.registered', { listenerId: lid, selector: msg.listener.selector }, { tabId });
      BUS.emit('listener:registered', { lid, tabId });
      return Promise.resolve({ ok: true, listenerId: lid });
    }

    case 'LISTENER_EVENT': {
      const l = listeners.get(msg.listenerId);
      if (l) {
        l.log.push({ ts: Date.now(), text: msg.text?.slice(0, 200) });
        l.eventCount++;
        if (l.log.length > 50) l.log.shift();
        URCK.ingest('guardian.listener.event', { listenerId: msg.listenerId, text: msg.text, origin: msg.origin }, { tabId });
        BUS.emit('listener:event', { listenerId: msg.listenerId, text: msg.text, origin: msg.origin });
        // Push to bridge
        bridgeFetch('/data/push', 'POST', {
          uuid:    '5f6a7b8c-9d0e-1f2a-3b4c-5d6e7f8a9b0c',
          tag:     'guardian.listener.event',
          payload: { listenerId: msg.listenerId, text: msg.text, origin: msg.origin, tabId },
        }).catch(() => {});
      }
      return Promise.resolve({ ok: true });
    }

    case 'PICKER_CAPTURE': {
      URCK.ingest('guardian.picker.capture', { selector: msg.selector, origin: msg.origin, backendNodeId: msg.backendNodeId }, { tabId });
      bridgeFetch('/data/push', 'POST', {
        uuid:    'guardian-firefox-ext-0000-000000000001',
        tag:     'guardian.picker.capture',
        payload: { selector: msg.selector, origin: msg.origin, backendNodeId: msg.backendNodeId, tabId },
      }).catch(() => {});
      BUS.emit('picker:capture', { selector: msg.selector, origin: msg.origin });
      return Promise.resolve({ ok: true });
    }

    case 'NEXUS_CMD_RESULT': {
      BUS.emit('cmd:result', msg);
      return Promise.resolve({ ok: true });
    }

    case 'GET_SESSIONS':        return Promise.resolve({ sessions: getAllSessions() });
    case 'GET_CAPTURES':        return Promise.resolve({ captures: URCK.captures(), seq: URCK.clock?.seq, version: URCK.version });
    case 'BRIDGE_FETCH':        return bridgeFetch(msg.path, msg.method, msg.body).then(r => ({ result: r.data, ok: r.ok, reason: r.reason }));
    case 'GET_HANDSHAKE_STATE': return Promise.resolve({ state: getHandshakeState() });
    case 'FORCE_HANDSHAKE':     return performHandshake().then(ok => ({ ok, state: getHandshakeState() }));
    case 'GET_IDENTITIES':      return Promise.resolve({ identities: { ...BUILT_IN_IDENTITIES, ...config.identities } });
    case 'GET_NODES':           return Promise.resolve({ nodes: [...NODE.knownNodes.values()] });
    case 'PING':                return Promise.resolve({ pong: true, instanceId: NODE.instanceId });

    // Nexus CMD relay: popup → background → content script
    case 'RELAY_NEXUS_CMD': {
      return browser.tabs.query({ active: true, currentWindow: true }).then(tabs => {
        if (!tabs.length) return { ok: false, reason: 'No active tab' };
        return browser.tabs.sendMessage(tabs[0].id, { type: 'NEXUS_CMD', cmd: msg.cmd });
      });
    }

    default:
      return Promise.resolve({ ok: false, reason: `Unknown message type: ${msg.type}` });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   BUS WIRING  (cross-module event routing)
═══════════════════════════════════════════════════════════════════════════ */
BUS.on('handshake:ok',    () => { startPulse(); });
BUS.on('heartbeat:reauth', () => { performHandshake(); });
BUS.on('*', ({ event, data }) => {
  // Forward bus events to popup via BroadcastChannel (non-blocking)
  if (event.startsWith('handshake:') || event.startsWith('heartbeat:') || event === 'pulse:ack') {
    channel.postMessage({ type: 'BUS_EVENT', event, data });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   TAB LIFECYCLE
═══════════════════════════════════════════════════════════════════════════ */
browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url?.startsWith('http')) {
    if (!sessions.has(tabId)) await registerSession(tabId, tab.url);
    else sessions.get(tabId).url = tab.url;
    // Re-attach any active listeners on this tab
    for (const [lid, l] of listeners) {
      if (l.tabId === tabId && l.active) {
        browser.tabs.sendMessage(tabId, {
          type: 'ATTACH_LISTENER', listenerId: lid, selector: l.selector, xpath: l.xpath, mode: l.mode,
        }).catch(() => {});
      }
    }
  }
});

browser.tabs.onRemoved.addListener(tabId => {
  const s = sessions.get(tabId);
  if (s) {
    URCK.ingest('guardian.session.disconnect', { tabId, sessionId: s.sessionId }, { tabId });
    BUS.emit('session:disconnect', { tabId, sessionId: s.sessionId });
    sessions.delete(tabId);
  }
  for (const [lid, l] of listeners) {
    if (l.tabId === tabId) { l.active = false; listeners.delete(lid); }
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   STORAGE CHANGE LISTENER
═══════════════════════════════════════════════════════════════════════════ */
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.bridgeUrl) {
    BRIDGE_URL = config.bridgeUrl = changes.bridgeUrl.newValue || BRIDGE_URL_DEFAULT;
    _hbStatus = 'disconnected';
    _sessionToken = null;
    performHandshake();
  }
  if (changes.appId)      config.appId      = changes.appId.newValue;
  if (changes.identities) config.identities = changes.identities.newValue || {};
});

/* ═══════════════════════════════════════════════════════════════════════════
   BOOT
═══════════════════════════════════════════════════════════════════════════ */
(async () => {
  // Step 1: load config
  await loadConfig();

  // Step 2: URCK kernel (loaded by manifest as urck.js — already available)
  if (typeof URCK === 'undefined') {
    console.error('[Guardian] CRITICAL: URCK kernel not loaded');
    return;
  }

  // Step 3: IR Layer (loaded by manifest as ir-layer.js — already available)
  const _ir = _getIR();
  if (!_ir) {
    console.error('[Guardian] CRITICAL: IR Layer not loaded — check ir-layer.js in manifest');
    return;
  }
  _ir.bridgeUrl = BRIDGE_URL;

  // Step 4: node identity
  await initNodeIdentity();
  _ir.instanceId = NODE.instanceId;

  // Step 5: pulse
  startPulse();

  // Step 6: heartbeat + initial handshake
  startHeartbeat();

  // Step 7: load existing tabs into session registry
  const tabs = await browser.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  for (const tab of tabs) {
    if (tab.id && tab.url) await registerSession(tab.id, tab.url);
  }

  URCK.ingest('guardian.init', {
    instanceId: NODE.instanceId,
    version:    '4.0.0',
    bridgeUrl:  BRIDGE_URL,
  }, { source: 'app:boot' });

  console.log(`[Guardian v4.0.0] ready — ${tabs.length} tabs · instanceId: ${NODE.instanceId} · bridge: ${BRIDGE_URL}`);
})();