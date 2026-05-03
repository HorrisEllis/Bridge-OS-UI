// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
'use strict';

/**
 * NEXUS Bridge Node — Canvas Persistence Module
 */

const MODULE_UUID    = 'brainos-node-canvas-persist-v230-000000000001';
const MODULE_VERSION = '2.3.0';

// ── Load the persistence engine ───────────────────────────────────────────────
const CanvasPersist = require('../../bridge-canvas-persistence');

let _installed = false;
let _bus       = null;

// ── Install — called from boot after dataDir is established ──────────────────
function install({ dataDir, bus }) {
  if (_installed) return;
  _installed = true;
  _bus = bus;

  // Bridge busEmit to the system bus
  function busEmit(event, data, level = 'INFO') {
    bus.emit(event, data, { source: 'canvas-persist', level });
  }

  // Install the persistence engine
  CanvasPersist.install(dataDir, busEmit, () => {});

  // Run watchdog
  const wd = CanvasPersist.watchdog();
  bus.emit('canvas:watchdog', wd, { source: 'canvas-persist', level: wd.ok ? 'INFO' : 'ERROR' });

  // --- FAILURE HANDLER ---
  if (!wd.ok) {
    // If the module fails, we log the specific details to the console
    console.error('\n\x1b[31m[!] CANVAS-PERSIST CRITICAL FAILURE\x1b[0m');
    console.error(`\x1b[31mDetails:\x1b[0m ${JSON.stringify(wd.results, null, 2)}`);
    
    // Throwing here stops the boot sequence in app.js Phase 03
    throw new Error('Canvas Storage Watchdog failed');
  }

  // Silent on success to keep the boot sequence clean
  bus.emit('canvas:module:ready', { uuid: MODULE_UUID, dataDir }, { source: 'canvas-persist' });
}

// ── Route handler ────────────────────────────────────────────────────────────
async function handle(req, res, parts, method) {
  if (!_installed) return null;
  if (parts[0] !== 'canvas') return null;
  return CanvasPersist.handle(req, res, parts, method);
}

// ── Diagnostics hook ──────────────────────────────────────────────────────────
function diagnostics() {
  const wd = _installed ? CanvasPersist.watchdog() : { ok: false };
  return {
    uuid:      MODULE_UUID,
    version:   MODULE_VERSION,
    installed: _installed,
    watchdog:  wd,
    fileSizes: _installed ? (() => {
      const P = CanvasPersist._P();
      const fs = require('fs');
      const out = {};
      for (const [k, v] of Object.entries(P)) {
        try { out[k] = fs.existsSync(v) ? fs.statSync(v).size : null; } catch { out[k] = null; }
      }
      return out;
    })() : {},
  };
}

module.exports = { install, handle, diagnostics, MODULE_UUID, MODULE_VERSION };