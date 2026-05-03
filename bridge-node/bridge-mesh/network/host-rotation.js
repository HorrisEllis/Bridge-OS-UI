// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
'use strict';
/**
 * bridge-mesh/network/host-rotation.js
 * Alternating hosts, bounce on block.
 * No fixed IP required. Survives IP changes and port blocks.
 *
 * A node has a list of known addresses (IP:port pairs).
 * On connection failure, rotate to next. On exhaustion, mark unreachable.
 * DDNS hostname [uuid].nexus.mesh always points to current active address.
 */

function createHostRotator({ addresses = [], busEmit = null } = {}) {
  let _addresses = [...addresses];  // { host, port, lastTried, failures }
  let _idx       = 0;
  let _rotations = 0;

  function add(host, port) {
    if (!_addresses.find(a => a.host === host && a.port === port)) {
      _addresses.push({ host, port, lastTried: null, failures: 0 });
    }
  }

  function remove(host, port) {
    _addresses = _addresses.filter(a => !(a.host === host && a.port === port));
    if (_idx >= _addresses.length) _idx = 0;
  }

  // Get current address — never rotates automatically
  function current() {
    if (!_addresses.length) return null;
    return _addresses[_idx % _addresses.length];
  }

  // Mark current failed, advance to next
  function reportFailure(host, port) {
    const addr = _addresses.find(a => a.host === host && a.port === port);
    if (addr) {
      addr.failures++;
      addr.lastTried = Date.now();
    }

    _idx = (_idx + 1) % Math.max(1, _addresses.length);
    _rotations++;

    busEmit?.('mesh:host:rotated', {
      failed:  { host, port },
      next:    current(),
      rotations: _rotations,
    }, 'WARN');

    return current();
  }

  function reportSuccess(host, port) {
    const addr = _addresses.find(a => a.host === host && a.port === port);
    if (addr) { addr.failures = 0; addr.lastTried = Date.now(); }
  }

  function list()     { return [..._addresses]; }
  function isExhausted() {
    return _addresses.length > 0 && _addresses.every(a => a.failures >= 3);
  }

  return { add, remove, current, reportFailure, reportSuccess, list, isExhausted,
           get rotations() { return _rotations; } };
}

module.exports = { createHostRotator };
