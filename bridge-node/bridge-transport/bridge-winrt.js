// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
'use strict';
/**
 * bridge-transport/bridge-winrt.js
 * Bridge WinRT BLE backend — zero external dependencies.
 *
 * Spawns bridge-winrt-ble.ps1 as a persistent child process.
 * Speaks JSON lines over stdin/stdout.
 * Exposes a noble-compatible EventEmitter surface so bridge-ble.js
 * can use it as a drop-in replacement for @abandonware/noble.
 *
 * Why PowerShell + WinRT?
 *   Windows 10+ ships the Windows.Devices.Bluetooth WinRT namespace.
 *   It is fully accessible from PowerShell without any native compilation,
 *   COM registration, or driver installation.  No Zadig.  No WinUSB.
 *   Works alongside normal Windows Bluetooth (mouse, keyboard, headphones).
 *
 * Architecture:
 *   Node.js (bridge-ble.js)
 *     ↕  JSON lines on stdin/stdout
 *   PowerShell (bridge-winrt-ble.ps1)
 *     ↕  WinRT COM calls
 *   Windows Bluetooth subsystem
 *
 * Noble-compatible API surface implemented:
 *   noble.state                           // 'unknown'|'poweredOn'|'poweredOff'|...
 *   noble.on('stateChange', fn)
 *   noble.on('discover', peripheral)
 *   noble.startScanning(uuids, allowDups)
 *   noble.stopScanning()
 *
 *   peripheral.advertisement.localName
 *   peripheral.address
 *   peripheral.rssi
 *   peripheral.connect(cb)
 *   peripheral.disconnect()
 *   peripheral.on('disconnect', fn)
 *   peripheral.requestMtu(mtu, cb)
 *   peripheral.discoverSomeServicesAndCharacteristics(svcs, chars, cb)
 *
 *   characteristic.uuid
 *   characteristic.write(buf, withoutResponse, cb)
 *   characteristic.subscribe(cb)
 *   characteristic.on('data', fn)
 */

const { spawn }       = require('child_process');
const { EventEmitter} = require('events');
const path            = require('path');
const fs              = require('fs');

const PS_SCRIPT = path.join(__dirname, 'bridge-winrt-ble.ps1');

// ── Characteristic ────────────────────────────────────────────────────────────

class WinRTCharacteristic extends EventEmitter {
  constructor(uuid, properties, address, noble) {
    super();
    this.uuid        = uuid;
    this.properties  = properties;
    this._address    = address;
    this._noble      = noble;
    this._subscribed = false;
  }

  write(buf, withoutResponse, cb) {
    const data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    this._noble._send({
      cmd:             'write',
      address:         this._address,
      charUUID:        this.uuid,
      data:            data.toString('base64'),
      withoutResponse: !!withoutResponse,
    });
    // Fire cb on next tick — WinRT write is fire-and-forget for withoutResponse
    // For write-with-response we'd need to wait for a writeAck event, but
    // bridge-ble.js uses withoutResponse=true for all chunk writes.
    if (typeof cb === 'function') setImmediate(() => cb(null));
  }

  subscribe(cb) {
    this._noble._send({
      cmd:     'subscribe',
      address: this._address,
      charUUID: this.uuid,
    });
    this._subscribed = true;
    if (typeof cb === 'function') setImmediate(() => cb(null));
  }

  _onData(b64) {
    const buf = Buffer.from(b64, 'base64');
    this.emit('data', buf);
  }
}

// ── Peripheral ────────────────────────────────────────────────────────────────

class WinRTPeripheral extends EventEmitter {
  constructor(address, name, rssi, rawAddr, noble) {
    super();
    this.address       = address;
    this.rssi          = rssi;
    this._rawAddr      = rawAddr;
    this._noble        = noble;
    this._chars        = new Map();  // charUUID → WinRTCharacteristic
    this.advertisement = {
      localName:        name || '',
      serviceUuids:     [],
      manufacturerData: null,
    };
    this.connectable   = true;
  }

  connect(cb) {
    this._noble._send({ cmd: 'connect', address: this.address });
    // Wait for connected event
    const onConnected = () => {
      clearTimeout(timer);
      if (typeof cb === 'function') cb(null);
    };
    const onError = ({ address, reason }) => {
      if (address !== this.address) return;
      clearTimeout(timer);
      this._noble.removeListener('_connected:' + this.address, onConnected);
      if (typeof cb === 'function') cb(new Error(reason));
    };
    const timer = setTimeout(() => {
      this._noble.removeListener('_connected:' + this.address, onConnected);
      this._noble.removeListener('_error:' + this.address, onError);
      if (typeof cb === 'function') cb(new Error('connect timeout'));
    }, 12_000);

    this._noble.once('_connected:' + this.address, onConnected);
    this._noble.once('_error:' + this.address, onError);
  }

  disconnect() {
    this._noble._send({ cmd: 'disconnect', address: this.address });
  }

  requestMtu(mtu, cb) {
    this._noble._send({ cmd: 'requestMtu', address: this.address, mtu });
    const onMtu = ({ mtu: negotiated }) => {
      if (typeof cb === 'function') cb(null, negotiated);
    };
    this._noble.once('_mtu:' + this.address, onMtu);
  }

  discoverSomeServicesAndCharacteristics(serviceUUIDs, charUUIDs, cb) {
    // Normalise UUIDs — strip dashes, lowercase (noble convention)
    const svcUUIDs  = (serviceUUIDs || []).map(u => u.replace(/-/g, '').toLowerCase());
    const cUUIDs    = (charUUIDs    || []).map(u => u.replace(/-/g, '').toLowerCase());

    this._noble._send({
      cmd:         'discoverServices',
      address:     this.address,
      serviceUUIDs: svcUUIDs,
      charUUIDs:   cUUIDs,
    });

    const onDiscovered = ({ characteristics }) => {
      const charObjs = (characteristics || []).map(c => {
        const existing = this._chars.get(c.uuid);
        if (existing) return existing;
        const ch = new WinRTCharacteristic(c.uuid, c.properties, this.address, this._noble);
        this._chars.set(c.uuid, ch);
        return ch;
      });
      if (typeof cb === 'function') cb(null, [], charObjs);
    };

    this._noble.once('_discovered:' + this.address, onDiscovered);
  }

  _onData(charUUID, b64) {
    const ch = this._chars.get(charUUID);
    if (ch) ch._onData(b64);
  }
}

// ── WinRTNoble — noble-compatible emitter ─────────────────────────────────────

class WinRTNoble extends EventEmitter {
  constructor() {
    super();
    this.state         = 'unknown';
    this._proc         = null;
    this._buf          = '';
    this._peripherals  = new Map();  // address → WinRTPeripheral
    this._started      = false;
    this._pingTimer    = null;
    this._rawMap       = new Map();  // address → uint64 raw
    this._advertising  = false;
    this._subscriberCount = 0;
    this._hasPeripheral = false;
    this._localAddress  = null;
  }

  // ── Process management ──────────────────────────────────────────────────────

  _start() {
    if (this._proc) return;
    if (!fs.existsSync(PS_SCRIPT)) {
      throw new Error(`WinRT BLE script not found: ${PS_SCRIPT}`);
    }

    this._proc = spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', PS_SCRIPT,
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    this._proc.stdout.setEncoding('utf8');
    this._proc.stdout.on('data', chunk => this._onStdout(chunk));
    this._proc.stderr.setEncoding('utf8');
    this._proc.stderr.on('data', err => {
      // PS errors go to stderr — only log if non-trivial
      const trimmed = err.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        this.emit('_debug', 'ps:stderr', trimmed);
      }
    });

    this._proc.on('exit', code => {
      this._proc = null;
      if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
      this.state = 'poweredOff';
      this.emit('stateChange', 'poweredOff');
    });

    this._proc.on('error', err => {
      this.state = 'poweredOff';
      this.emit('stateChange', 'poweredOff');
      this.emit('_debug', 'proc:error', err.message);
    });

    // Ping every 15s to keep the PowerShell process alive and detect if it dies
    this._pingTimer = setInterval(() => {
      if (this._proc) this._send({ cmd: 'ping' });
    }, 15_000);
  }

  _send(obj) {
    if (!this._proc?.stdin?.writable) return;
    try {
      this._proc.stdin.write(JSON.stringify(obj) + '\n');
    } catch {}
  }

  // ── stdout JSON line parser ──────────────────────────────────────────────────

  _onStdout(chunk) {
    this._buf += chunk;
    const lines = this._buf.split('\n');
    this._buf = lines.pop(); // keep incomplete last line
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        this._handleEvent(JSON.parse(trimmed));
      } catch {
        this.emit('_debug', 'parse:error', trimmed.slice(0, 120));
      }
    }
  }

  _handleEvent(ev) {
    switch (ev.event) {
      case 'ready':
        if (ev.hasPeripheral !== undefined) this._hasPeripheral = !!ev.hasPeripheral;
        if (ev.address) this._localAddress = ev.address;
        // fall through
      case 'stateChange': {
        const state = ev.state || 'poweredOn';
        this.state = state;
        this.emit('stateChange', state);
        break;
      }

      case 'scanStarted':
      case 'scanStopped':
        // informational — no noble equivalent
        break;

      case 'discover': {
        const addr = ev.address;
        if (ev.raw !== undefined) this._rawMap.set(addr, ev.raw);

        let peripheral = this._peripherals.get(addr);
        if (!peripheral) {
          peripheral = new WinRTPeripheral(addr, ev.name, ev.rssi, ev.raw, this);
          this._peripherals.set(addr, peripheral);
        } else {
          peripheral.rssi                    = ev.rssi;
          peripheral.advertisement.localName = ev.name || peripheral.advertisement.localName;
        }
        this.emit('discover', peripheral);
        break;
      }

      case 'connecting':
        this.emit('_debug', 'connecting', ev.address);
        break;

      case 'connected':
        this.emit('_connected:' + ev.address, ev);
        break;

      case 'disconnected': {
        const p = this._peripherals.get(ev.address);
        if (p) p.emit('disconnect');
        this.emit('_disconnected:' + ev.address, ev);
        break;
      }

      case 'mtuNegotiated':
        this.emit('_mtu:' + ev.address, { mtu: ev.mtu });
        break;

      case 'servicesDiscovered':
        this.emit('_discovered:' + ev.address, { characteristics: ev.characteristics });
        break;

      case 'subscribed':
        this.emit('_debug', 'subscribed', `${ev.address} ${ev.charUUID}`);
        break;

      case 'data': {
        const p = this._peripherals.get(ev.address);
        if (p) p._onData(ev.charUUID, ev.data);
        break;
      }

      case 'advertisingStarted':
        this._advertising = true;
        this.emit('advertisingStarted', { localName: ev.localName });
        break;

      case 'advertisingStopped':
        this._advertising = false;
        this.emit('advertisingStopped');
        break;

      case 'advertisingError':
        this._advertising = false;
        this.emit('advertisingError', ev.reason);
        this.emit('_debug', 'advertising:error', ev.reason);
        break;

      case 'subscribersChanged':
        this._subscriberCount = ev.count || 0;
        this.emit('subscribersChanged', { count: ev.count });
        break;

      case 'centralConnected':
        this.emit('centralConnected', { address: ev.address });
        break;

      case 'centralDisconnected':
        this.emit('centralDisconnected', { address: ev.address });
        break;

      case 'notified':
        this.emit('notified', { charUUID: ev.charUUID, recipients: ev.recipients });
        break;

      case 'error':
        this.emit('_error:' + (ev.address || ''), ev);
        this.emit('_debug', 'ble:error', `${ev.address || ''} ${ev.reason}`);
        break;

      case 'pong':
        // heartbeat — process is alive
        break;

      default:
        this.emit('_debug', 'unknown:event', ev.event);
    }
  }

  // ── Noble-compatible public API ──────────────────────────────────────────────

  startScanning(serviceUUIDs, allowDups) {
    if (!this._proc) this._start();
    this._send({
      cmd:          'startScanning',
      serviceUUIDs: (serviceUUIDs || []).map(u => u.replace(/-/g,'').toLowerCase()),
      allowDups:    allowDups !== false,
    });
  }

  stopScanning() {
    this._send({ cmd: 'stopScanning' });
  }

  // ── Peripheral API ──────────────────────────────────────────────────────────

  startAdvertising(localName, serviceUUID) {
    if (!this._proc) this._start();
    this._send({
      cmd:        'startAdvertising',
      localName:  localName || 'BRIDGE',
      serviceUUID: serviceUUID || '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
    });
  }

  stopAdvertising() {
    this._send({ cmd: 'stopAdvertising' });
  }

  // notify(charUUID, buf) — push data to all subscribed centrals
  notify(charUUID, buf) {
    const data = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf));
    this._send({
      cmd:     'notify',
      charUUID: charUUID || '6e400003b5a3f393e0a9e50e24dcca9e',
      data:    data.toString('base64'),
    });
  }

  peripheralStatus() {
    return {
      advertising:     this._advertising,
      subscribers:     this._subscriberCount,
      hasPeripheral:   this._hasPeripheral,
      localAddress:    this._localAddress,
    };
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  init() {
    this._start();
    return this;
  }

  stop() {
    this._send({ cmd: 'exit' });
    if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
    setTimeout(() => { try { this._proc?.kill(); } catch {} this._proc = null; }, 1000);
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

let _singleton = null;

function createWinRTNoble() {
  if (!fs.existsSync(PS_SCRIPT)) {
    throw new Error(`WinRT BLE script not found at: ${PS_SCRIPT}\nExpected: bridge-transport/bridge-winrt-ble.ps1`);
  }
  if (_singleton) return _singleton;
  const noble = new WinRTNoble();
  noble._start();
  _singleton = noble;
  return noble;
}

function isAvailable() {
  // Only available on Windows — check platform and script presence only.
  // Do NOT call execSync here: it blocks the event loop during boot.
  // Windows version check happens implicitly — if WinRT namespace load fails,
  // the PS process exits immediately with stateChange:unsupported.
  if (process.platform !== 'win32') return false;
  return fs.existsSync(PS_SCRIPT);
}

module.exports = { createWinRTNoble, WinRTNoble, WinRTPeripheral, WinRTCharacteristic, isAvailable };
