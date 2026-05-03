// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
/**
 * bridge-routing/index.js  v1.0.0
 * Custom binary pulse + message router — TCP mesh port :3749.
 *
 * Packet format: [NEXS:4][UUID-hex:32][payload...]
 * init(state, busShim) — matches boot.js optional module pattern.
 * busShim: { emit(sig, data), on(sig, fn) }
 */

'use strict';
const net = require('net');

const MODULE_UUID    = 'bridge-routing-000-0000-000000000001';
const MODULE_VERSION = '1.0.0';

class NexusRouter {
  constructor() {
    this.peers       = new Map();
    this.routes      = new Map();
    this.port        = Number(process.env.NEXUS_MESH_PORT) || 3749;
    this._bus        = null;
    this._state      = null;
    this._server     = null;
    this.initialized = false;
    this._stats      = { in: 0, out: 0, errors: 0, since: Date.now() };
  }

  init(state, busShim) {
    if (this.initialized) return true;
    this._state = state;
    this._bus   = busShim;

    // Wire bus: other modules can register custom route handlers
    busShim.on('router:register', ({ id, handler }) => {
      if (id && typeof handler === 'function') this.routes.set(id, handler);
    });

    this._server = net.createServer(socket => {
      socket.on('data',  buf  => this._handlePulse(socket, buf));
      socket.on('error', ()   => { this._stats.errors++; });
    });

    this._server.on('error', err => {
      const msg = err.code === 'EADDRINUSE'
        ? `[routing] Port ${this.port} already in use — mesh TCP disabled`
        : `[routing] Server error: ${err.message}`;
      busShim.emit('routing:error', { error: msg, code: err.code }, 'WARN');
      process.stdout.write(`\x1b[33m${msg}\x1b[0m\n`);
    });

    this._server.listen(this.port, '0.0.0.0', () => {
      this.initialized = true;
      busShim.emit('routing:online', { port: this.port }, 'INFO');
    });

    return true;
  }

  _handlePulse(socket, buffer) {
    if (buffer.length < 36) return;
    const header = buffer.toString('utf8', 0, 4);
    if (header !== 'NEXS') { socket.destroy(); return; }
    const uuid    = buffer.toString('hex', 4, 36);
    const payload = buffer.slice(36).toString();
    this._stats.in++;
    this._bus?.emit('router:incoming', { uuid, payload }, 'DEBUG');
    // Run registered handler if present
    const handler = this.routes.get(uuid);
    if (handler) { try { handler({ uuid, payload, socket }); } catch {} }
    // Auto-ack
    try { socket.write(Buffer.from('PULSE_ACK')); } catch {}
  }

  send(targetUUID, data) {
    return new Promise(resolve => {
      this._bus?.emit('router:resolving', { uuid: targetUUID }, 'DEBUG');
      // Resolve address via magnet bus event
      this._bus?.emit('magnet:resolve', { uuid: targetUUID }, ({ address } = {}) => {
        if (!address) { resolve({ ok: false, reason: 'no address' }); return; }
        const [ip, portStr] = address.replace('http://', '').split(':');
        const port = parseInt(portStr) || 3749;
        const client = new net.Socket();
        client.connect(port, ip, () => {
          const header  = Buffer.from('NEXS');
          const idBuf   = Buffer.alloc(32);
          const idStr   = (this._state?.identity?.uuid || '').replace(/-/g, '').slice(0, 32);
          idBuf.write(idStr, 'hex');
          const payload = Buffer.from(JSON.stringify(data));
          client.write(Buffer.concat([header, idBuf, payload]));
          client.destroy();
          this._stats.out++;
          resolve({ ok: true });
        });
        client.on('error', e => { resolve({ ok: false, reason: e.message }); });
        client.setTimeout(4000, () => { client.destroy(); resolve({ ok: false, reason: 'timeout' }); });
      });
    });
  }

  stop() {
    this._server?.close();
    this.initialized = false;
  }

  diagnostics() {
    return {
      uuid:        MODULE_UUID,
      version:     MODULE_VERSION,
      port:        this.port,
      initialized: this.initialized,
      routes:      this.routes.size,
      peers:       this.peers.size,
      stats:       { ...this._stats, uptime: Math.round((Date.now() - this._stats.since) / 1000) },
    };
  }
}

const router = new NexusRouter();
module.exports = router;
module.exports.MODULE_UUID    = MODULE_UUID;
module.exports.MODULE_VERSION = MODULE_VERSION;
