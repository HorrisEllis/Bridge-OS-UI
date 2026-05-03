// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
'use strict';
/**
 * bridge-node/network-identity.js
 *
 * NetworkIdentity — sovereign address resolution.
 *
 * Every Bridge node runs on a real machine with real network interfaces.
 * This module discovers all of them, classifies them by scope, and
 * provides a priority-ordered address list that the rest of the system
 * uses to tell peers "here is how to reach me."
 *
 * Address scopes (priority order for reachability):
 *   loopback   127.x.x.x / ::1              — same process only
 *   lan        10.x / 172.16-31.x / 192.168 — same physical network
 *   vpn        100.64-127.x / fd00::/8      — tunnel/VPN
 *   public     everything else               — internet-routable
 *
 * Why this matters:
 *   Two nodes on the same LAN both bind to 0.0.0.0:3747. They are both
 *   reachable — but only if you address them by their actual machine IP,
 *   not by 127.0.0.1 (which loops back to the same machine). This module
 *   finds the real LAN IP (e.g. 192.168.1.42) and makes it available so
 *   the CLI, heartbeat, and mesh layer can all use the right address.
 *
 * Design:
 *   - getAll()        → all non-loopback IPv4 addresses, annotated
 *   - getBest()       → the single best address for LAN advertisement
 *   - getByScope(s)   → addresses filtered to a specific scope
 *   - toEndpoints(port) → full http://ip:port strings, priority ordered
 *   - refresh()       → re-read interfaces (call after network changes)
 *
 * Bus events:
 *   network:addresses:changed  { added[], removed[], current[] }
 *
 * Module UUID: bridge-netid-000-0000-000000000001
 */

const os   = require('os');
const http = require('http');

const MODULE_UUID    = 'bridge-netid-000-0000-000000000001';
const MODULE_VERSION = '1.0.0';

// IP range classifiers
const RANGES = [
  // Loopback
  { scope: 'loopback', test: ip => /^127\./.test(ip) || ip === '::1' },
  // Link-local (not routable, skip)
  { scope: 'link-local', test: ip => /^169\.254\./.test(ip) || /^fe80:/i.test(ip) },
  // CGNAT / shared address space (often VPN/tunnel)
  { scope: 'vpn', test: ip => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip) },
  // Private RFC1918 — LAN
  { scope: 'lan', test: ip => /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip) },
  // ULA IPv6
  { scope: 'lan', test: ip => /^fd/i.test(ip) },
  // Everything else
  { scope: 'public', test: () => true },
];

const SCOPE_PRIORITY = { lan: 0, vpn: 1, public: 2, 'link-local': 3, loopback: 4 };

function classifyIP(ip) {
  for (const r of RANGES) {
    if (r.test(ip)) return r.scope;
  }
  return 'public';
}

function readInterfaces() {
  const result = [];
  const ifaces = os.networkInterfaces();
  for (const [ifaceName, addrs] of Object.entries(ifaces || {})) {
    for (const addr of addrs) {
      if (addr.family !== 'IPv4') continue;               // IPv4 only for now
      if (addr.internal) continue;                         // skip loopback
      if (/^169\.254\./.test(addr.address)) continue;     // skip link-local
      const scope = classifyIP(addr.address);
      result.push({
        ip:      addr.address,
        scope,
        iface:   ifaceName,
        netmask: addr.netmask,
        cidr:    addr.cidr,
      });
    }
  }
  // Sort by scope priority (LAN first)
  result.sort((a, b) => (SCOPE_PRIORITY[a.scope] ?? 9) - (SCOPE_PRIORITY[b.scope] ?? 9));
  return result;
}

// Attempt to detect public IP from external service
async function detectPublicIP(timeoutMs = 4000) {
  const sources = [
    'https://api.ipify.org',
    'https://icanhazip.com',
    'https://checkip.amazonaws.com',
  ];
  for (const url of sources) {
    try {
      const ip = await new Promise((resolve, reject) => {
        const req = http.get(url.replace('https:', 'http:'), { timeout: timeoutMs }, res => {
          let d = '';
          res.on('data', c => d += c);
          res.on('end', () => {
            const trimmed = d.trim();
            if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(trimmed)) resolve(trimmed);
            else reject(new Error('not an IP'));
          });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      });
      return ip;
    } catch {}
  }
  return null;
}

function createNetworkIdentity({ busEmit = null, port = 3747 } = {}) {
  let _addresses = readInterfaces();
  let _publicIP  = null;
  let _port      = port;

  function _changed(prev, next) {
    const prevSet = new Set(prev.map(a => a.ip));
    const nextSet = new Set(next.map(a => a.ip));
    const added   = next.filter(a => !prevSet.has(a.ip));
    const removed = prev.filter(a => !nextSet.has(a.ip));
    return { added, removed, changed: added.length > 0 || removed.length > 0 };
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /** All discovered non-loopback IPv4 addresses, sorted LAN-first */
  function getAll() {
    return [..._addresses];
  }

  /** Best single address for LAN advertisement — first LAN IP, or first of any */
  function getBest() {
    const lan = _addresses.find(a => a.scope === 'lan');
    return (lan || _addresses[0])?.ip || '127.0.0.1';
  }

  /** Addresses filtered to a specific scope */
  function getByScope(scope) {
    return _addresses.filter(a => a.scope === scope);
  }

  /** Known public IP (requires detectPublicIP() to have been called) */
  function getPublicIP() { return _publicIP; }

  /**
   * All reachable endpoints as http://ip:port strings.
   * order: LAN → VPN → public
   * Includes public IP if known.
   */
  function toEndpoints(p = _port) {
    const eps = _addresses
      .filter(a => a.scope !== 'loopback')
      .map(a => `http://${a.ip}:${p}`);

    if (_publicIP && !eps.some(e => e.includes(_publicIP))) {
      eps.push(`http://${_publicIP}:${p}`);
    }
    return [...new Set(eps)];
  }

  /**
   * Summary object suitable for /health, /identity, /pulse responses.
   * Lists all endpoints so remote peers know how to reach this node.
   */
  function summary(p = _port) {
    return {
      lan:     getByScope('lan').map(a => `http://${a.ip}:${p}`),
      vpn:     getByScope('vpn').map(a => `http://${a.ip}:${p}`),
      public:  _publicIP ? [`http://${_publicIP}:${p}`] : [],
      best:    `http://${getBest()}:${p}`,
      all:     toEndpoints(p),
    };
  }

  /** Re-read interfaces and emit change event if anything changed */
  function refresh() {
    const prev = _addresses;
    _addresses  = readInterfaces();
    const diff  = _changed(prev, _addresses);
    if (diff.changed) {
      busEmit?.('network:addresses:changed', {
        added:   diff.added.map(a => a.ip),
        removed: diff.removed.map(a => a.ip),
        current: _addresses.map(a => a.ip),
      }, 'INFO');
    }
    return _addresses;
  }

  /** Detect and cache public IP. Call once at startup. */
  async function discoverPublicIP() {
    _publicIP = await detectPublicIP();
    if (_publicIP) busEmit?.('network:public_ip', { ip: _publicIP }, 'INFO');
    return _publicIP;
  }

  function setPort(p) { _port = p; }

  function diagnostics() {
    return {
      uuid:       MODULE_UUID,
      version:    MODULE_VERSION,
      interfaces: _addresses,
      publicIP:   _publicIP,
      best:       getBest(),
      endpoints:  toEndpoints(),
    };
  }

  // Auto-refresh every 60s to catch network changes (WiFi handover, VPN connect/disconnect)
  const _refreshTimer = setInterval(refresh, 60_000);
  _refreshTimer.unref();

  return {
    getAll, getBest, getByScope, getPublicIP,
    toEndpoints, summary, refresh, discoverPublicIP,
    setPort, diagnostics,
    MODULE_UUID, MODULE_VERSION,
  };
}

module.exports = { createNetworkIdentity, classifyIP, MODULE_UUID, MODULE_VERSION };
