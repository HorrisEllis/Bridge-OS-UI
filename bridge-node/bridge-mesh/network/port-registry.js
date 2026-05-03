// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
'use strict';
/**
 * bridge-mesh/network/port-registry.js
 * Dynamic port range mapping.
 * Primary → fallback chain → dynamic (10000–65535).
 *
 * Port registry from architecture spec:
 *   3747 — Bridge primary
 *   3748 → 3749 → 3750 → dynamic 10000-65535
 */

const net = require('net');

const PORT_PLAN = {
  bridge:     [3747, 3748, 3749, 3750],
  hub:        [3748],
  sentinel:   [3749],
  cdp:        [9222, 9229, 9333, 9444],
  turn:       [3478, 5349],
  stun:       [3479, 19302],
  dynamicMin: 10000,
  dynamicMax: 65535,
};

// Check if a port is free
function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => { server.close(() => resolve(true)); });
    server.listen(port);
  });
}

// Find first free port from list, then dynamic range
async function findFreePort(preferred = PORT_PLAN.bridge) {
  for (const port of preferred) {
    if (await isPortFree(port)) return port;
  }
  // Dynamic fallback
  for (let attempts = 0; attempts < 100; attempts++) {
    const port = PORT_PLAN.dynamicMin +
      Math.floor(Math.random() * (PORT_PLAN.dynamicMax - PORT_PLAN.dynamicMin));
    if (await isPortFree(port)) return port;
  }
  throw new Error('[port-registry] No free port found in any range');
}

// ── Port registry singleton ───────────────────────────────────────────────────
function createPortRegistry() {
  const _claimed = new Map();  // service → port

  async function claim(service, preferred) {
    const ports = preferred || PORT_PLAN[service] || PORT_PLAN.bridge;
    const port  = await findFreePort(ports);
    _claimed.set(service, port);
    return port;
  }

  function release(service) { _claimed.delete(service); }
  function get(service)     { return _claimed.get(service) || null; }
  function list()           { return Object.fromEntries(_claimed); }

  return { claim, release, get, list, isPortFree, findFreePort };
}

module.exports = { createPortRegistry, PORT_PLAN, isPortFree, findFreePort };
