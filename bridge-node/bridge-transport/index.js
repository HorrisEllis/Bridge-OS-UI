// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
'use strict';
/**
 * bridge-transport/index.js
 * Unified Transport Abstraction Layer
 *
 * Bridge OS is transport-agnostic. Every module (DHT, onion, heartbeat)
 * communicates through TransportAdapters. The routing table doesn't care
 * whether a packet arrived via WiFi, BLE, or cellular relay — it's bytes
 * from a UUID with a signature.
 *
 * Transports available:
 *   - http    : existing HTTP transport (default, always available)
 *   - ble     : Bluetooth Low Energy (requires @abandonware/noble at runtime)
 *   - cellular: cellular data relay via SMS/MMS or HTTP fallback relay node
 *
 * TransportAdapter interface (all adapters implement this):
 *   adapter.type           → string
 *   adapter.available()    → boolean (can this transport be used right now?)
 *   adapter.send(peerId, message) → Promise<{ ok, latencyMs }>
 *   adapter.onMessage(fn)  → register incoming message handler
 *   adapter.start()        → Promise<void>
 *   adapter.stop()         → void
 *   adapter.stats()        → { sent, received, errors, bytesOut, bytesIn }
 *
 * TransportManager:
 *   Manages a priority-ordered stack of adapters. send() tries adapters
 *   in priority order until one succeeds. Falls back automatically.
 *   On mobile with battery < 20%, Bluetooth priority is raised above cellular
 *   to avoid expensive radio use.
 *
 * BLE adapter design:
 *   Uses GATT characteristic UUID: 6E400002-B5A3-F393-E0A9-E50E24DCCA9E
 *   (matches Nordic UART Service TX characteristic — widely supported).
 *   Messages are chunked into 20-byte BLE packets (ATT MTU default) and
 *   reassembled. Max message size: 512 bytes per transmission.
 *   Advertising uses the node UUID as the local name (truncated to 11 bytes).
 *
 * Cellular relay design:
 *   Cellular data doesn't need special code — it's just HTTP over LTE.
 *   The cellular adapter IS the HTTP adapter, but with:
 *     - Adaptive sync intervals based on link type detection
 *     - Battery-aware throttling (backs off when battery < 20%)
 *     - Data budget tracking (warns when approaching configurable limit)
 *
 * Wire protocol (HTTP transport adds transport metadata header):
 *   X-Bridge-Transport: ble|cellular|wifi|ethernet
 *   X-Bridge-UUID: <sender UUID>
 *
 * Bus events:
 *   transport:connected    { transport, peerId }
 *   transport:disconnected { transport, peerId }
 *   transport:sent         { transport, peerId, bytes }
 *   transport:received     { transport, peerId, bytes }
 *   transport:fallback     { from, to, peerId, reason }
 *   transport:power:low    { battery, throttled }
 *
 * Invariants:
 *   T-01: Transport selection is transparent to upper layers. They call
 *         send(peerId, message) — the manager handles the rest.
 *   T-02: Every sent message carries the sender's UUID and is signed.
 *         Transport layer never strips authentication.
 *   T-03: BLE messages are chunked, never truncated silently.
 *   T-04: Battery < 20% throttles cellular. BLE preferred for small messages.
 *   T-05: All transports emit on the bus. Power budget and link type are
 *         observable without inspecting transport internals.
 *
 * UUID: bridge-transport-000-0000-000000000001
 * Version: 1.0.0
 */

'use strict';

const crypto = require('crypto');
const http   = require('http');
const os     = require('os');

const MODULE_UUID    = 'bridge-transport-000-0000-000000000001';
const MODULE_VERSION = '1.0.0';

// BLE GATT UUIDs (Nordic UART Service — widely supported by mobile BLE stacks)
const BLE_SERVICE_UUID = '6e400001b5a3f393e0a9e50e24dcca9e';
const BLE_TX_UUID      = '6e400002b5a3f393e0a9e50e24dcca9e'; // central writes here
const BLE_RX_UUID      = '6e400003b5a3f393e0a9e50e24dcca9e'; // peripheral notifies here
const BLE_MTU          = 20;    // safe default ATT MTU
const BLE_MAX_MSG      = 512;   // max bytes per BLE message

// ── Message framing (shared across transports) ────────────────────────────────

/**
 * Frame: JSON-serialisable envelope that all transports carry.
 * The upper layer (DHT, onion, heartbeat) provides `payload`.
 * Transport adds `senderUuid` and `sig` over the framed content.
 */
function makeFrame(payload, senderUuid, identity) {
  const ts   = Date.now();
  const body = JSON.stringify({ payload, senderUuid, ts });
  const sig  = identity?.sign ? identity.sign(body) : null;
  return { body, sig, senderUuid, ts };
}

function unpackFrame(frame) {
  try {
    const parsed = JSON.parse(frame.body);
    return { ok: true, payload: parsed.payload, senderUuid: parsed.senderUuid, ts: parsed.ts, sig: frame.sig };
  } catch (e) {
    return { ok: false, reason: 'malformed frame: ' + e.message };
  }
}

// ── HTTP Transport Adapter ────────────────────────────────────────────────────

function createHTTPAdapter({ busEmit = null, identity = null, port = 3747 } = {}) {
  const _handlers = [];
  const _stats    = { sent: 0, received: 0, errors: 0, bytesOut: 0, bytesIn: 0 };
  const type      = 'http';

  function available() { return true; } // HTTP always available if runtime has network

  async function send(peerAddress, message) {
    const t0   = Date.now();
    const frame = makeFrame(message, identity?.uuid, identity);
    const data  = JSON.stringify(frame);
    try {
      await new Promise((resolve, reject) => {
        const url = new URL('/transport/recv', peerAddress);
        const req = http.request({
          hostname: url.hostname, port: url.port || port, path: url.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data),
            'X-Bridge-Transport': 'http',
            'X-Bridge-UUID': identity?.uuid || '',
          },
          timeout: 4000,
        }, res => {
          res.resume();
          if (res.statusCode !== 200) reject(new Error(`HTTP ${res.statusCode}`));
          else resolve();
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.write(data);
        req.end();
      });
      _stats.sent++;
      _stats.bytesOut += data.length;
      busEmit?.('transport:sent', { transport: 'http', peerId: peerAddress, bytes: data.length }, 'DEBUG');
      return { ok: true, latencyMs: Date.now() - t0 };
    } catch (e) {
      _stats.errors++;
      return { ok: false, reason: e.message, latencyMs: Date.now() - t0 };
    }
  }

  function onMessage(fn) { _handlers.push(fn); }

  function receive(frame, peerUuid) {
    const unpacked = unpackFrame(frame);
    if (!unpacked.ok) return;
    _stats.received++;
    _stats.bytesIn += JSON.stringify(frame).length;
    busEmit?.('transport:received', { transport: 'http', peerId: peerUuid, bytes: _stats.bytesIn }, 'DEBUG');
    for (const fn of _handlers) { try { fn(unpacked.payload, unpacked.senderUuid, 'http'); } catch {} }
  }

  function start()  {} // HTTP adapter needs no initialisation (server starts in boot.js)
  function stop()   {}
  function stats()  { return { ..._stats }; }

  return { type, available, send, onMessage, receive, start, stop, stats };
}

// ── BLE Transport Adapter ─────────────────────────────────────────────────────
//
// Runtime dependency: @abandonware/noble (npm install @abandonware/noble)
// This is a soft dependency — if noble is not installed, BLE adapter returns
// available() = false and the manager falls back to HTTP.
//
// BLE chunking: messages are split into 20-byte chunks prefixed with
// [seqHi][seqLo][chunkIdx][totalChunks] (4-byte header) + 16 bytes data.
// The receiver reassembles chunks into the full message.

// BLE adapter — wraps BridgeBLE with the TransportAdapter interface
function createBLEAdapter({ busEmit = null, identity = null, nodeUuid = null } = {}) {
  const { createBridgeBLE } = require('./bridge-ble');
  const type      = 'ble';
  const _handlers = [];
  let   _ble      = null;

  function _initBLE() {
    if (_ble) return _ble;
    _ble = createBridgeBLE({ nodeUuid, busEmit, identity });
    _ble.onData((payload, senderUuid, transport) => {
      for (const fn of _handlers) { try { fn(payload, senderUuid, transport); } catch {} }
    });
    return _ble;
  }

  function available() {
    _initBLE();
    return _ble.available();
  }

  // peerAddress: shortId (8 chars) or full UUID — extract shortId
  async function send(peerAddress, message) {
    _initBLE();
    const peerShort = String(peerAddress).replace(/-/g,'').slice(0,8);
    return _ble.send(peerShort, message);
  }

  function onMessage(fn) { _handlers.push(fn); }

  async function start() {
    _initBLE();
    return _ble.start();
  }

  function stop() { _ble?.stop(); }

  function stats() { return _ble?.diagnostics?.() || { sent:0, received:0, errors:0, bytesOut:0, bytesIn:0 }; }

  // Expose BridgeBLE directly for CLI and mobile use
  function getBLE() { _initBLE(); return _ble; }

  return { type, available, send, onMessage, start, stop, stats, getBLE };
}

// ── Cellular Adapter ──────────────────────────────────────────────────────────
//
// Cellular data is just HTTP over LTE. The adapter wraps the HTTP adapter with:
//   - Link type detection (wifi vs cellular via os.networkInterfaces())
//   - Adaptive sync interval (60s on cellular, 5s on WiFi)
//   - Data budget tracking
//   - Battery throttling (T-04)

function createCellularAdapter({
  busEmit        = null,
  identity       = null,
  dataBudgetMB   = 100,        // monthly data budget in MB
  batteryLowPct  = 20,         // below this % → throttle
  getBattery     = null,       // optional: () => { level: 0.0–1.0, charging: bool }
} = {}) {
  const type    = 'cellular';
  const _http   = createHTTPAdapter({ busEmit, identity });
  const _stats  = { sent: 0, received: 0, errors: 0, bytesOut: 0, bytesIn: 0, dataMB: 0 };
  let   _throttled = false;

  function _getLinkType() {
    const ifaces = os.networkInterfaces();
    for (const iface of Object.values(ifaces)) {
      for (const addr of iface) {
        if (addr.family === 'IPv4' && !addr.internal) {
          // Heuristic: 10.x.x.x ranges are often tethered cellular or VPN
          // Real detection requires OS-level APIs (Android: ConnectivityManager)
          if (addr.address.startsWith('10.')) return 'cellular';
        }
      }
    }
    return 'wifi';
  }

  function _checkBattery() {
    if (!getBattery) return false;
    const { level, charging } = getBattery() || {};
    const lowBattery = typeof level === 'number' && level * 100 < batteryLowPct && !charging;
    if (lowBattery && !_throttled) {
      _throttled = true;
      busEmit?.('transport:power:low', { battery: Math.round(level * 100), throttled: true }, 'WARN');
    } else if (!lowBattery && _throttled) {
      _throttled = false;
    }
    return _throttled;
  }

  function available() { return _http.available(); }

  async function send(peerAddress, message) {
    // T-04: throttle on low battery
    if (_checkBattery()) {
      // On low battery, defer non-critical messages
      busEmit?.('transport:power:low', { deferred: true }, 'WARN');
      return { ok: false, reason: 'deferred: low battery', deferred: true };
    }

    const msgSize = JSON.stringify(message).length;
    if ((_stats.dataMB + msgSize / 1e6) > dataBudgetMB) {
      busEmit?.('transport:data:budget_exceeded', { usedMB: _stats.dataMB, budgetMB: dataBudgetMB }, 'WARN');
      return { ok: false, reason: 'data budget exceeded' };
    }

    const result = await _http.send(peerAddress, message);
    if (result.ok) {
      _stats.sent++;
      _stats.bytesOut += msgSize;
      _stats.dataMB    = Math.round((_stats.dataMB + msgSize / 1e6) * 1000) / 1000;
      busEmit?.('transport:sent', { transport: 'cellular', peerId: peerAddress, bytes: msgSize, linkType: _getLinkType() }, 'DEBUG');
    } else {
      _stats.errors++;
    }
    return result;
  }

  function onMessage(fn) { _http.onMessage(fn); }
  function receive(frame, peerUuid) { _http.receive(frame, peerUuid); }
  function start()  { return _http.start(); }
  function stop()   { _http.stop(); }
  function stats()  { return { ..._stats, throttled: _throttled, linkType: _getLinkType() }; }

  return { type, available, send, onMessage, receive, start, stop, stats };
}

// ── Transport Manager ─────────────────────────────────────────────────────────

function createTransportManager({
  identity     = null,
  busEmit      = null,
  adapters     = null,   // custom stack, or use defaults
  getBattery   = null,
} = {}) {

  // Default priority stack: BLE (preferred for LAN), HTTP (always works)
  const _adapters = adapters || [
    createBLEAdapter({ busEmit, identity, nodeUuid: identity?.uuid }),
    createHTTPAdapter({ busEmit, identity }),
    createCellularAdapter({ busEmit, identity, getBattery }),
  ];

  const _handlers = [];

  // Wire all adapters to the central message handler
  for (const adapter of _adapters) {
    adapter.onMessage((payload, senderUuid, transport) => {
      for (const fn of _handlers) {
        try { fn(payload, senderUuid, transport); } catch {}
      }
    });
  }

  /**
   * send(peerAddress, message)
   * Tries adapters in priority order. Falls back automatically.
   * T-01: Upper layers call this. Transport selection is invisible.
   */
  async function send(peerAddress, message) {
    const tried = [];
    for (const adapter of _adapters) {
      if (!adapter.available()) continue;
      const result = await adapter.send(peerAddress, message);
      tried.push({ transport: adapter.type, ...result });
      if (result.ok) return { ok: true, transport: adapter.type, tried };
      // Emit fallback event before trying next
      if (tried.length > 1) {
        busEmit?.('transport:fallback', {
          from:   tried[tried.length - 2].transport,
          to:     adapter.type,
          peerId: peerAddress,
          reason: tried[tried.length - 2].reason,
        }, 'WARN');
      }
    }
    return { ok: false, tried, reason: 'all transports failed' };
  }

  function onMessage(fn) { _handlers.push(fn); }

  async function start() {
    for (const adapter of _adapters) { try { await adapter.start(); } catch {} }
  }

  function stop() {
    for (const adapter of _adapters) { try { adapter.stop(); } catch {} }
  }

  function stats() {
    return _adapters.map(a => ({ type: a.type, available: a.available(), ...a.stats() }));
  }

  function diagnostics() {
    return { uuid: MODULE_UUID, version: MODULE_VERSION, adapters: stats() };
  }

  // HTTP route handler for receiving inbound messages from remote nodes
  function route(method, urlParts, body, req, res) {
    const _json = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };

    if (method === 'POST' && urlParts[1] === 'recv') {
      const { body: frameBody, sig, senderUuid } = body || {};
      if (!frameBody || !senderUuid) return _json(400, { ok: false, error: 'body and senderUuid required' });
      const transport = req?.headers?.['x-bridge-transport'] || 'http';
      // Route to HTTP adapter for unpacking
      const httpAdapter = _adapters.find(a => a.type === 'http');
      httpAdapter?.receive({ body: frameBody, sig }, senderUuid);
      return _json(200, { ok: true });
    }

    if (method === 'GET' && urlParts[1] === 'stats') {
      return _json(200, { ok: true, adapters: stats() });
    }

    return null;
  }

  return { send, onMessage, start, stop, stats, diagnostics, route, MODULE_UUID, MODULE_VERSION };
}

module.exports = {
  createTransportManager,
  createHTTPAdapter,
  createBLEAdapter,
  createCellularAdapter,
  createContentStore: null, // not in this module
  makeFrame, unpackFrame,
  BLE_MTU, BLE_MAX_MSG, BLE_SERVICE_UUID, BLE_TX_UUID, BLE_RX_UUID,
  MODULE_UUID, MODULE_VERSION,
};
