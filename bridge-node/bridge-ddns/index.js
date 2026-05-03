// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
'use strict';
/**
 * bridge-ddns/index.js  v1.0.0
 * DDNS module index — exposes DDNSClient, DNS server, and bus-integrated install().
 *
 * DDNSClient (bridge-mesh-identity.js):
 *   Detects public IP changes and updates Cloudflare, No-IP, or DynDNS.
 *   Falls back to emitting net.dns.add_record on internal mesh DNS.
 *   Polls every 5 minutes by default.
 *
 * BrainOSDNS (dns-server.js):
 *   Full UDP DNS server from scratch. Local zone overrides + upstream forwarder.
 *   Binds to :53 (fallback :5353 if EACCES/EADDRINUSE).
 *
 * install({ busEmit, dataDir, identity }):
 *   Wires DDNSClient to the bus and optionally starts the DNS server.
 *   Safe to call multiple times — only installs once.
 *
 * Bus events consumed:
 *   net.ddns.force_check   → triggers immediate IP check
 *   net.ddns.add_entry     → adds a new DDNS hostname entry
 *   net.proxy.add_route    → (forwarded to proxy if present)
 *
 * Bus events emitted:
 *   net.ddns.started       { interval }
 *   net.ddns.ip_detected   { ip, changed }
 *   net.ddns.updated       { hostname, ip, provider }
 *   net.ddns.entry_added   { hostname, token }
 *   ddns:dns:started       { port }
 *   system.error           { source:'ddns', context, message }
 *
 * UUID: bridge-ddns-module-v5000-0000-000000000005
 * Version: 1.0.0
 */

const { DDNSClient, client: _defaultClient, propagate, getPublicIP } = require('./bridge-mesh-identity');
const { BrainOSDNS, server: _defaultDNS, start: startDNS } = require('./dns-server');

const MODULE_UUID    = 'bridge-ddns-module-v5000-0000-000000000005';
const MODULE_VERSION = '1.0.0';

let _installed = false;
let _client    = null;
let _dns       = null;
let _busEmit   = null;

/**
 * install({ busEmit, dataDir, identity, enableDNS, dnsPort })
 * Wire DDNSClient to the bus and optionally start the DNS server.
 */
async function install({ busEmit, dataDir, identity, enableDNS = false, dnsPort = 5353 } = {}) {
  if (_installed) return { client: _client, dns: _dns };
  _installed = true;
  _busEmit   = busEmit || (() => {});

  // Create a fresh client bound to this node's dataDir
  _client = new DDNSClient({ dataDir: dataDir || process.cwd() + '/data' });

  // Wire bus events → client methods
  const busShim = {
    on:   (ev, fn) => {},   // bus.on wired separately via boot ctx
    emit: (ev, data, meta) => _busEmit(ev, data, typeof meta === 'string' ? meta : 'INFO'),
  };
  _client.setBus(busShim);

  // Propagate (initial IP detect + start polling)
  try {
    await propagate(busShim);
    _busEmit('ddns:started', { uuid: MODULE_UUID, version: MODULE_VERSION }, 'INFO');
  } catch (e) {
    _busEmit('ddns:error', { reason: e.message }, 'WARN');
  }

  // Optionally start the internal DNS server
  if (enableDNS) {
    _dns = new BrainOSDNS({ port: dnsPort });
    try {
      await _dns.start();
      _busEmit('ddns:dns:started', { port: dnsPort }, 'INFO');
    } catch (e) {
      // Try fallback port
      _dns.port = dnsPort === 53 ? 5353 : dnsPort + 1;
      try {
        await _dns.start();
        _busEmit('ddns:dns:started', { port: _dns.port }, 'INFO');
      } catch {
        _busEmit('ddns:dns:failed', { reason: e.message }, 'WARN');
        _dns = null;
      }
    }
  }

  return { client: _client, dns: _dns };
}

/**
 * addRecord(name, ip, ttl) — add a local DNS override record
 * Works whether or not the DNS server is running (emits to mesh if not).
 */
function addRecord(name, ip, ttl = 300) {
  if (_dns) {
    const zone = _dns.localZone;
    const records = zone.get(name.toLowerCase()) || [];
    records.push({ type: 'A', value: ip, ttl });
    zone.set(name.toLowerCase(), records);
  } else {
    _busEmit?.('net.dns.add_record', { name, type: 'A', value: ip, ttl }, 'INFO');
  }
}

function diagnostics() {
  return {
    uuid:      MODULE_UUID,
    version:   MODULE_VERSION,
    installed: _installed,
    client:    _client?.health?.() || null,
    dns:       _dns ? { port: _dns.port, zone: _dns.localZone?.size || 0 } : null,
  };
}

function stop() {
  _client?.stop?.();
  // DNS server has no stop method — UDP socket stays open until process exit
  _installed = false;
}

module.exports = {
  install,
  stop,
  addRecord,
  diagnostics,
  DDNSClient,
  BrainOSDNS,
  getPublicIP,
  MODULE_UUID,
  MODULE_VERSION,
};
