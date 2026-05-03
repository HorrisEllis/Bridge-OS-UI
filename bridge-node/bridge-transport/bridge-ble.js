// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
'use strict';
/**
 * bridge-transport/bridge-ble.js
 * BridgeBLE — sovereign BLE interface for Bridge OS.
 *
 * This is the complete BLE stack for Bridge OS. It owns the full connection
 * lifecycle: scanning, connecting, GATT negotiation, chunked write, and
 * subscription to incoming notifications. The transport adapter in index.js
 * wraps this class — upper layers only see send() / onData().
 *
 * ── Design decisions ──────────────────────────────────────────────────────────
 *
 * Why Nordic UART Service (NUS)?
 *   NUS (6E400001-...) is a well-established convention for serial-over-BLE.
 *   Every nRF52/ESP32 dev board speaks it natively. Mobile BLE apps (nRF Toolbox,
 *   Serial Bluetooth Terminal) can talk to Bridge nodes without any custom app.
 *   It uses two characteristics: TX (central writes) and RX (peripheral notifies).
 *
 * Why NOT standard BLE profiles (HID, HFP, etc.)?
 *   Those are application-layer profiles for specific device types. Bridge needs
 *   raw bidirectional bytes. NUS gives exactly that.
 *
 * Why chunking at 20 bytes?
 *   The BLE ATT MTU defaults to 23 bytes, leaving 20 bytes of payload after the
 *   ATT header. Some stacks negotiate higher MTU (up to 512 bytes) but you cannot
 *   rely on it — especially with Windows WinRT backend. We chunk at 20 bytes and
 *   reassemble, which works on every platform.
 *
 * Header format (4 bytes): [seqHi][seqLo][chunkIdx][totalChunks]
 *   seqId: 16-bit rolling counter per message, identifies which message each
 *          chunk belongs to. Wraps at 65535. Collision window: negligible at
 *          Bridge message rates.
 *   chunkIdx: 0-based index within this message (max 255 chunks → max 4080 bytes)
 *   totalChunks: total chunks in this message (1-255)
 *
 * ── Windows backend ───────────────────────────────────────────────────────────
 *
 * On Windows 10+, BridgeBLE prefers `noble-winrt` over `@abandonware/noble`.
 * noble-winrt uses the native WinRT Bluetooth LE API — no Zadig, no WinUSB
 * driver swap, works alongside normal Windows Bluetooth (mouse, keyboard, audio).
 *
 * Install order (Windows):
 *   npm install noble-winrt          ← preferred, works without Zadig
 *   npm install @abandonware/noble   ← fallback if winrt not available
 *
 * Install order (Linux/Pi):
 *   sudo apt install libbluetooth-dev
 *   npm install @abandonware/noble
 *   sudo setcap cap_net_raw+eip $(which node)
 *
 * Install order (macOS):
 *   npm install @abandonware/noble   ← CoreBluetooth, works natively
 *
 * ── Connection model ──────────────────────────────────────────────────────────
 *
 * BridgeBLE maintains a pool of active connections keyed by peer shortId
 * (first 8 chars of UUID). Connections are established on demand (send() to
 * an unconnected peer triggers connect()) and persist until the peer disconnects
 * or stop() is called. A reconnect timer retries dead connections after 5s.
 *
 * ── Advertisement ─────────────────────────────────────────────────────────────
 *
 * On platforms that support peripheral mode (bleno — Linux, macOS, some Windows):
 *   Local name: "BRIDGE:<shortId>"   e.g. "BRIDGE:18afb7ea"
 *   Service UUID: NUS service (6E400001-...)
 *
 * On Windows WinRT (no peripheral mode support in winrt backend):
 *   The node is Central-only — it can find and connect to other nodes but
 *   cannot advertise. Use a Pi or Linux node as the advertising endpoint.
 *   Windows-to-Windows BLE requires at least one side to be a peripheral
 *   (Pi, phone, or ESP32 running Bridge firmware).
 *
 * ── Bus events ────────────────────────────────────────────────────────────────
 *   ble:adapter:ready        { backend }                   adapter powered on
 *   ble:adapter:unavailable  { reason }                    no adapter / no lib
 *   ble:scan:start           {}                            scanning started
 *   ble:scan:stop            {}
 *   ble:discovered           { shortId, rssi, address? }  Bridge peer found
 *   ble:connecting           { shortId }
 *   ble:connected            { shortId }
 *   ble:disconnected         { shortId, reason }
 *   ble:sent                 { shortId, bytes, chunks }
 *   ble:received             { shortId, bytes }
 *   ble:error                { shortId?, reason }
 *   ble:mtu:negotiated       { shortId, mtu }
 *
 * UUID: bridge-ble-00000-0000-000000000001
 * Version: 1.0.0
 */

const crypto = require('crypto');
const os     = require('os');

const MODULE_UUID    = 'bridge-ble-00000-0000-000000000001';
const MODULE_VERSION = '1.0.0';

// Nordic UART Service
const NUS_SERVICE  = '6e400001b5a3f393e0a9e50e24dcca9e';
const NUS_TX       = '6e400002b5a3f393e0a9e50e24dcca9e'; // write (central → peripheral)
const NUS_RX       = '6e400003b5a3f393e0a9e50e24dcca9e'; // notify (peripheral → central)

const CHUNK_HEADER  = 4;   // bytes
const MTU_DEFAULT   = 20;  // safe minimum ATT MTU payload
const MSG_MAX       = 512; // max bytes per Bridge BLE message
const RECONNECT_MS  = 5_000;
const CONNECT_TIMEOUT = 10_000;
const SCAN_TIMEOUT  = 30_000;

// ── Noble backend loader ─────────────────────────────────────────────────────
// Backend selection — sovereign first, no external npm deps preferred:
//
//   Windows:  bridge-winrt (our PS/WinRT bridge) — zero dependencies.
//             Uses Windows.Devices.Bluetooth WinRT namespace built into Win10+.
//             No Zadig, no driver swap, works with internal hardware Bluetooth.
//             Falls back to @abandonware/noble only if bridge-winrt unavailable.
//
//   Linux:    @abandonware/noble — needs libbluetooth-dev + cap_net_raw.
//   macOS:    @abandonware/noble — CoreBluetooth, works natively.
//
// Returns { noble, backend } or null if no BLE backend is available.

function loadNoble() {
  if (process.platform === 'win32') {
    // Our sovereign WinRT backend — preferred, zero external dependencies
    try {
      const { createWinRTNoble, isAvailable } = require('./bridge-winrt');
      if (isAvailable()) {
        const noble = createWinRTNoble();
        return { noble, backend: 'bridge-winrt' };
      }
    } catch {}
    // bridge-winrt not available (script missing, PS not found) — try noble
    try { return { noble: require('@abandonware/noble'), backend: 'noble' }; } catch {}
    return null;
  }
  // Linux / macOS
  try { return { noble: require('@abandonware/noble'), backend: 'noble' }; } catch {}
  return null;
}

// ── Chunking ──────────────────────────────────────────────────────────────────

function chunkBuffer(buf, seqId, mtu = MTU_DEFAULT) {
  const dataPerChunk = mtu - CHUNK_HEADER;
  const total        = Math.ceil(buf.length / dataPerChunk);
  if (total > 255) throw new Error(`Message too large: ${buf.length} bytes (max ${255 * dataPerChunk})`);
  const chunks = [];
  for (let i = 0; i < total; i++) {
    const start = i * dataPerChunk;
    const end   = Math.min(start + dataPerChunk, buf.length);
    const data  = buf.slice(start, end);
    const chunk = Buffer.alloc(CHUNK_HEADER + data.length);
    chunk[0] = (seqId >> 8) & 0xFF;
    chunk[1] = seqId & 0xFF;
    chunk[2] = i;
    chunk[3] = total;
    data.copy(chunk, CHUNK_HEADER);
    chunks.push(chunk);
  }
  return chunks;
}

// ── Reassembly ────────────────────────────────────────────────────────────────

function createReassembler(onComplete) {
  const _bufs = new Map(); // seqId → { chunks[], total, received, ts }

  function receive(rawChunk) {
    if (rawChunk.length < CHUNK_HEADER) return;
    const seqId = (rawChunk[0] << 8) | rawChunk[1];
    const idx   = rawChunk[2];
    const total = rawChunk[3];
    const data  = rawChunk.slice(CHUNK_HEADER);

    if (!_bufs.has(seqId)) {
      _bufs.set(seqId, { chunks: new Array(total).fill(null), total, received: 0, ts: Date.now() });
    }
    const entry = _bufs.get(seqId);
    if (entry.chunks[idx] === null) {
      entry.chunks[idx] = data;
      entry.received++;
    }
    if (entry.received === entry.total) {
      _bufs.delete(seqId);
      onComplete(Buffer.concat(entry.chunks.filter(Boolean)));
    }
  }

  // Prune stale partial messages (older than 10s)
  const _pruner = setInterval(() => {
    const cutoff = Date.now() - 10_000;
    for (const [id, e] of _bufs) { if (e.ts < cutoff) _bufs.delete(id); }
  }, 5_000);

  function stop() { clearInterval(_pruner); }

  return { receive, stop };
}

// ── BridgeBLE ─────────────────────────────────────────────────────────────────

function createBridgeBLE({
  nodeUuid  = null,   // full UUID of this node
  busEmit   = null,   // bridge bus emit fn
  identity  = null,   // identity object (for signing frames)
  mtu       = MTU_DEFAULT,
} = {}) {

  const shortId    = (nodeUuid || '').slice(0, 8);
  const _emit      = busEmit || (() => {});
  const _handlers  = [];               // onData handlers
  const _peers     = new Map();        // shortId → { peripheral, txChar, mtu, state, reassembler }
  const _seqCounter = { n: 0 };
  let   _noble     = null;
  let   _backend   = null;
  let   _state     = 'off';           // off | starting | scanning | ready
  let   _scanning  = false;
  let   _scanTimer = null;
  const _stats     = { sent: 0, received: 0, errors: 0, bytesOut: 0, bytesIn: 0, peers: 0 };

  // ── Backend ──────────────────────────────────────────────────────────────────

  function available() {
    if (_noble) return true;
    const result = loadNoble();
    if (!result) return false;
    _noble   = result.noble;
    _backend = result.backend;
    return true;
  }

  function backendName() { return _backend || 'none'; }

  // ── Sequence ID ───────────────────────────────────────────────────────────────

  function nextSeqId() {
    _seqCounter.n = (_seqCounter.n + 1) & 0xFFFF;
    return _seqCounter.n;
  }

  // ── Frame sign / verify ───────────────────────────────────────────────────────

  function frameMessage(payload) {
    const ts   = Date.now();
    const body = JSON.stringify({ payload, senderUuid: nodeUuid, ts });
    const sig  = identity?.sign ? identity.sign(body) : null;
    return Buffer.from(JSON.stringify({ body, sig }));
  }

  function unframeMessage(buf) {
    try {
      const { body, sig } = JSON.parse(buf.toString());
      const { payload, senderUuid, ts } = JSON.parse(body);
      return { ok: true, payload, senderUuid, ts, sig };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }

  // ── Peer connection ───────────────────────────────────────────────────────────

  function _peerShortId(peripheral) {
    const name = peripheral.advertisement?.localName || '';
    if (name.startsWith('BRIDGE:')) return name.slice(7, 15);
    return null;
  }

  function _connectPeer(peripheral) {
    const peerShort = _peerShortId(peripheral);
    if (!peerShort) return;
    if (_peers.has(peerShort) && _peers.get(peerShort).state === 'connected') return;

    _peers.set(peerShort, { peripheral, txChar: null, mtu, state: 'connecting', reassembler: null });
    _emit('ble:connecting', { shortId: peerShort }, 'INFO');

    const connectTimeout = setTimeout(() => {
      if (_peers.get(peerShort)?.state === 'connecting') {
        peripheral.disconnect();
        _peers.delete(peerShort);
        _emit('ble:error', { shortId: peerShort, reason: 'connect timeout' }, 'WARN');
      }
    }, CONNECT_TIMEOUT);

    peripheral.connect(err => {
      clearTimeout(connectTimeout);
      if (err) {
        _peers.delete(peerShort);
        _emit('ble:error', { shortId: peerShort, reason: `connect: ${err}` }, 'WARN');
        return;
      }

      peripheral.on('disconnect', () => {
        const entry = _peers.get(peerShort);
        if (entry?.reassembler) entry.reassembler.stop();
        _peers.delete(peerShort);
        _stats.peers = _peers.size;
        _emit('ble:disconnected', { shortId: peerShort }, 'INFO');
        // Reconnect after delay if we're still running
        if (_state !== 'off') {
          setTimeout(() => {
            if (_state !== 'off' && !_peers.has(peerShort)) _connectPeer(peripheral);
          }, RECONNECT_MS);
        }
      });

      // Negotiate MTU if the backend supports it
      if (typeof peripheral.requestMtu === 'function') {
        peripheral.requestMtu(247, (err2, negotiated) => {
          const effectiveMtu = err2 ? mtu : Math.min(negotiated - 3, MSG_MAX);
          const entry = _peers.get(peerShort);
          if (entry) entry.mtu = effectiveMtu;
          _emit('ble:mtu:negotiated', { shortId: peerShort, mtu: effectiveMtu }, 'DEBUG');
          _discoverServices(peripheral, peerShort);
        });
      } else {
        _discoverServices(peripheral, peerShort);
      }
    });
  }

  function _discoverServices(peripheral, peerShort) {
    peripheral.discoverSomeServicesAndCharacteristics(
      [NUS_SERVICE],
      [NUS_TX, NUS_RX],
      (err, _svcs, chars) => {
        if (err || !chars?.length) {
          _peers.delete(peerShort);
          _emit('ble:error', { shortId: peerShort, reason: `service discovery: ${err || 'no chars'}` }, 'WARN');
          return;
        }

        const txChar = chars.find(c => c.uuid === NUS_TX);
        const rxChar = chars.find(c => c.uuid === NUS_RX);

        if (!txChar) {
          _peers.delete(peerShort);
          _emit('ble:error', { shortId: peerShort, reason: 'TX characteristic not found' }, 'WARN');
          return;
        }

        // Subscribe to incoming notifications (RX = peripheral → central)
        const reassembler = createReassembler(fullBuf => {
          const frame = unframeMessage(fullBuf);
          if (!frame.ok) return;
          _stats.received++;
          _stats.bytesIn += fullBuf.length;
          _emit('ble:received', { shortId: peerShort, bytes: fullBuf.length }, 'DEBUG');
          for (const fn of _handlers) { try { fn(frame.payload, frame.senderUuid, 'ble'); } catch {} }
        });

        if (rxChar) {
          rxChar.subscribe(err2 => {
            if (err2) _emit('ble:error', { shortId: peerShort, reason: `subscribe: ${err2}` }, 'WARN');
          });
          rxChar.on('data', chunk => reassembler.receive(chunk));
        }

        const entry = _peers.get(peerShort);
        if (entry) {
          entry.txChar      = txChar;
          entry.state       = 'connected';
          entry.reassembler = reassembler;
        }
        _stats.peers = _peers.size;
        _emit('ble:connected', { shortId: peerShort }, 'INFO');

        // Drain any queued messages for this peer
        _drainQueue(peerShort);
      }
    );
  }

  // ── Send queue (messages queued while connecting) ──────────────────────────

  const _sendQueue = new Map(); // shortId → [{ buf, seqId, resolve }]

  function _drainQueue(peerShort) {
    const queue = _sendQueue.get(peerShort) || [];
    _sendQueue.delete(peerShort);
    for (const item of queue) _writeChunks(peerShort, item.buf, item.seqId).then(item.resolve);
  }

  // ── Write chunks to TX characteristic ────────────────────────────────────────

  async function _writeChunks(peerShort, frameBuf, seqId) {
    const entry = _peers.get(peerShort);
    if (!entry?.txChar) return { ok: false, reason: 'not connected' };

    const effectiveMtu = entry.mtu || mtu;
    let chunks;
    try { chunks = chunkBuffer(frameBuf, seqId, effectiveMtu); }
    catch (e) { return { ok: false, reason: e.message }; }

    // Write chunks sequentially — BLE is not truly parallel
    for (const chunk of chunks) {
      await new Promise((resolve, reject) => {
        // withoutResponse = true (write command, no ack) for speed
        // Use write + response for reliability if needed
        entry.txChar.write(chunk, true, err => {
          if (err) reject(err);
          else resolve();
        });
      }).catch(e => {
        _stats.errors++;
        _emit('ble:error', { shortId: peerShort, reason: `write: ${e}` }, 'WARN');
        throw e;
      });
      // Small inter-chunk gap to avoid overwhelming the peripheral's receive buffer
      await new Promise(r => setTimeout(r, 5));
    }
    return { ok: true, chunks: chunks.length };
  }

  // ── Public: send ──────────────────────────────────────────────────────────────

  async function send(peerShort, payload) {
    if (!_noble) return { ok: false, reason: 'BLE not initialised — call start() first' };
    if (typeof peerShort !== 'string') return { ok: false, reason: 'peerShort must be a string (first 8 chars of UUID)' };

    const t0       = Date.now();
    const payStr   = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const frameBuf = frameMessage(payStr);

    if (frameBuf.length > MSG_MAX * 4) {
      return { ok: false, reason: `payload too large: ${frameBuf.length} bytes (max ${MSG_MAX * 4} after framing)` };
    }

    const seqId = nextSeqId();
    const peer  = _peers.get(peerShort);

    if (peer?.state === 'connected') {
      try {
        const result = await _writeChunks(peerShort, frameBuf, seqId);
        if (result.ok) {
          _stats.sent++;
          _stats.bytesOut += frameBuf.length;
          _emit('ble:sent', { shortId: peerShort, bytes: frameBuf.length, chunks: result.chunks }, 'DEBUG');
        }
        return { ...result, latencyMs: Date.now() - t0 };
      } catch (e) {
        return { ok: false, reason: e.message, latencyMs: Date.now() - t0 };
      }
    }

    // Peer not yet connected — trigger connect and queue the message
    if (peer?.state === 'connecting') {
      // Already connecting — queue
      return new Promise(resolve => {
        const q = _sendQueue.get(peerShort) || [];
        q.push({ buf: frameBuf, seqId, resolve });
        _sendQueue.set(peerShort, q);
      });
    }

    // Need to connect — but we need the peripheral object. Trigger a scan.
    return { ok: false, reason: `peer ${peerShort} not found — run ble.scan() first` };
  }

  // ── Public: scan ─────────────────────────────────────────────────────────────

  function scan(durationMs = SCAN_TIMEOUT) {
    if (!_noble || _state === 'off') return { ok: false, reason: 'not started' };
    if (_scanning) return { ok: true, already: true };

    _scanning = true;
    _noble.startScanning([NUS_SERVICE], true); // duplicates=true for RSSI updates
    _emit('ble:scan:start', {}, 'INFO');

    _scanTimer = setTimeout(() => stopScan(), durationMs);
    return { ok: true };
  }

  function stopScan() {
    if (!_scanning) return;
    _scanning = false;
    clearTimeout(_scanTimer);
    try { _noble.stopScanning(); } catch {}
    _emit('ble:scan:stop', {}, 'INFO');
  }

  // ── Public: connect ───────────────────────────────────────────────────────────
  // Connect to a specific peer by shortId (discovered via scan)

  const _discovered = new Map(); // shortId → peripheral

  function connect(peerShort) {
    const peripheral = _discovered.get(peerShort);
    if (!peripheral) return { ok: false, reason: `${peerShort} not discovered — scan first` };
    _connectPeer(peripheral);
    return { ok: true, status: 'connecting' };
  }

  function disconnect(peerShort) {
    const entry = _peers.get(peerShort);
    if (!entry) return { ok: false, reason: 'not connected' };
    entry.reassembler?.stop();
    entry.peripheral?.disconnect();
    _peers.delete(peerShort);
    _stats.peers = _peers.size;
    return { ok: true };
  }

  // ── Public: onData ────────────────────────────────────────────────────────────

  function onData(fn) { _handlers.push(fn); }

  // ── Public: start ─────────────────────────────────────────────────────────────

  async function start() {
    if (!available()) {
      const hint = process.platform === 'win32'
        ? 'npm install noble-winrt  OR  npm install @abandonware/noble (needs Zadig/WinUSB)'
        : process.platform === 'linux'
        ? 'sudo apt install libbluetooth-dev && npm install @abandonware/noble && sudo setcap cap_net_raw+eip $(which node)'
        : 'npm install @abandonware/noble';
      _emit('ble:adapter:unavailable', { reason: 'no BLE library', hint }, 'WARN');
      return { ok: false, reason: 'no BLE library', hint };
    }

    _state = 'starting';

    return new Promise(resolve => {
      _noble.on('stateChange', state => {
        _emit('ble:adapter:state', { state, backend: _backend }, 'DEBUG');

        if (state === 'poweredOn') {
          _state = 'ready';
          _emit('ble:adapter:ready', { backend: _backend, shortId }, 'INFO');
          // Start scanning for other Bridge nodes
          scan();
          // Start advertising ourselves so other nodes can find us
          // Use startAdvertising if available (bridge-winrt backend)
          if (typeof _noble.startAdvertising === 'function') {
            _noble.startAdvertising(`BRIDGE:${shortId}`, '6e400001-b5a3-f393-e0a9-e50e24dcca9e');
          }
          resolve({ ok: true, backend: _backend });
        } else if (state === 'poweredOff') {
          _state = 'off';
          _emit('ble:adapter:unavailable', { reason: 'adapter powered off', backend: _backend }, 'WARN');
          resolve({ ok: false, reason: 'adapter powered off' });
        } else if (state === 'unauthorized') {
          _state = 'off';
          const reason = process.platform === 'darwin'
            ? 'Grant Bluetooth permission in System Settings → Privacy → Bluetooth'
            : 'BLE unauthorized';
          _emit('ble:adapter:unavailable', { reason, backend: _backend }, 'WARN');
          resolve({ ok: false, reason });
        } else if (state === 'unsupported') {
          _state = 'off';
          _emit('ble:adapter:unavailable', { reason: 'adapter unsupported', backend: _backend }, 'WARN');
          resolve({ ok: false, reason: 'unsupported' });
        }
      });

      _noble.on('discover', peripheral => {
        const name     = peripheral.advertisement?.localName || '';
        const peerShort = _peerShortId(peripheral);
        if (!peerShort) return; // not a Bridge node

        _discovered.set(peerShort, peripheral);
        _emit('ble:discovered', {
          shortId:  peerShort,
          rssi:     peripheral.rssi,
          name,
          address:  peripheral.address,
        }, 'INFO');

        // Auto-connect to Bridge peers
        _connectPeer(peripheral);
      });
    });
  }

  // ── Public: stop ──────────────────────────────────────────────────────────────

  function stop() {
    stopScan();
    for (const [peerShort, entry] of _peers) {
      entry.reassembler?.stop();
      try { entry.peripheral?.disconnect(); } catch {}
    }
    _peers.clear();
    _discovered.clear();
    _sendQueue.clear();
    _state = 'off';
  }

  // ── Public: peers / status ────────────────────────────────────────────────────

  function peers() {
    return [..._peers.entries()].map(([id, e]) => ({
      shortId:   id,
      state:     e.state,
      mtu:       e.mtu || mtu,
    }));
  }

  function discovered() {
    return [..._discovered.entries()].map(([id, p]) => ({
      shortId: id,
      rssi:    p.rssi,
      address: p.address,
      name:    p.advertisement?.localName,
    }));
  }

  function status() {
    return {
      state:      _state,
      backend:    _backend || 'none',
      shortId,
      scanning:   _scanning,
      peers:      peers(),
      discovered: discovered(),
      stats:      { ..._stats },
    };
  }

  function diagnostics() {
    return { uuid: MODULE_UUID, version: MODULE_VERSION, ...status() };
  }

  // ── Notify: push chunked data to centrals that connected TO us ──────────────
  // Used when this node is acting as peripheral and a central connected to it.
  // chunks are written to the RX characteristic (notify direction).
  async function notifyCentral(payload) {
    if (typeof _noble.notify !== 'function') {
      return { ok: false, reason: 'peripheral notify not supported by this backend' };
    }
    const t0       = Date.now();
    const payStr   = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const frameBuf = Buffer.from(JSON.stringify({
      body: JSON.stringify({ payload: payStr, senderUuid: nodeUuid, ts: Date.now() }),
      sig:  identity?.sign ? identity.sign(payStr) : null,
    }));
    const seqId  = nextSeqId();
    const chunks = chunkBuffer(frameBuf, seqId, mtu);
    for (const chunk of chunks) {
      _noble.notify('6e400003b5a3f393e0a9e50e24dcca9e', chunk);
      await new Promise(r => setTimeout(r, 5));
    }
    _stats.sent++;
    _stats.bytesOut += frameBuf.length;
    _emit('ble:notified', { bytes: frameBuf.length, chunks: chunks.length }, 'DEBUG');
    return { ok: true, latencyMs: Date.now() - t0, chunks: chunks.length };
  }

  function peripheralStatus() {
    if (typeof _noble.peripheralStatus === 'function') return _noble.peripheralStatus();
    return { advertising: false, subscribers: 0, hasPeripheral: false };
  }

  return {
    start, stop,
    scan, stopScan, connect, disconnect,
    send, onData, notifyCentral, peripheralStatus,
    peers, discovered, status, diagnostics,
    available, backendName,
    // expose internals for testing
    _chunkBuffer: chunkBuffer,
    _createReassembler: createReassembler,
    MODULE_UUID, MODULE_VERSION,
  };
}

module.exports = { createBridgeBLE, chunkBuffer, createReassembler, NUS_SERVICE, NUS_TX, NUS_RX, MODULE_UUID, MODULE_VERSION };
