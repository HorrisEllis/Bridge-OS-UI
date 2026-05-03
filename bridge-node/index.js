#!/usr/bin/env node
// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
'use strict';
/**
 * index.js — Bridge OS sovereign node entry point  v1.2.0
 *
 * Usage:
 *   node index.js               start the node
 *   node index.js --cli         start node + interactive CLI
 *
 * Env:
 *   NEXUS_PORT          HTTP port (default 3747)
 *   NEXUS_DATA_DIR      data directory (default ./data)
 *   NEXUS_GROUP         group hint for identity
 *   NEXUS_API_KEY       optional auth key
 *   NEXUS_PLAYWRIGHT    'true' to enable Playwright bridge
 *   NEXUS_LOG           log level INFO|DEBUG (default INFO)
 *   NEXUS_CLI           'true' to start CLI without --cli flag
 */

const { boot, attachShutdown } = require('./bridge-node/boot');
const CFR = require('./bridge-cfr/index');

const args    = process.argv.slice(2);
const withCLI = args.includes('--cli') || process.env.NEXUS_CLI === 'true';

// ── Pretty helpers (same palette as boot.js) ──────────────────────────────────
const R  = '\x1b[0m', GR = '\x1b[92m', YL = '\x1b[93m', RD = '\x1b[91m', CY = '\x1b[96m', DIM = '\x1b[2m';
function ok(m)   { console.log(`  ${GR}✓${R}  ${m}`); }
function warn(m) { console.log(`  ${YL}⚠${R}  ${m}`); }
function skip(m, e) {
  // Show a clean skip message. If the error is an internal Node path/type error,
  // show a friendlier hint rather than the raw message.
  let detail = e?.message || m;
  if (detail.includes('argument must be of type string')) detail = 'config path error (check dataDir)';
  if (detail.includes('Cannot find module'))              detail = 'module not installed';
  if (detail.includes('ENOENT'))                         detail = 'file not found';
  const label = e ? m : '';
  const msg   = label ? `${label}: ${detail}` : detail;
  console.log(`  ${DIM}·  ${msg}${R}`);
}

function tryRequire(p) { try { return require(p); } catch { return null; } }

// ── Optional v4 modules (safe if missing) ─────────────────────────────────────
const Health    = tryRequire('./bridge-health/index');
const Onion     = tryRequire('./bridge-onion/index');
const Steg      = tryRequire('./bridge-steg/index');
const Shaper    = tryRequire('./bridge-shaper/index');
const Transport = tryRequire('./bridge-transport/index');
const Mobile    = tryRequire('./bridge-mobile/index');
const IPFS      = tryRequire('./bridge-ipfs/index');
const DDNS      = tryRequire('./bridge-ddns/index');

boot().then(async (ctx) => {
  const { server, identity, busEmit, moduleRegistry } = ctx;

  // ── CFR ────────────────────────────────────────────────────────────────────
  try {
    CFR.install(ctx);
    moduleRegistry?.register('bridge-cfr', CFR, { modulePath: './bridge-cfr/index' });
    ok(`bridge-cfr online  ${DIM}${CFR.MODULE_UUID}${R}`);
  } catch (e) {
    warn(`bridge-cfr skipped: ${e.message}`);
  }

  // ── Health + auto-heal + delta replay ─────────────────────────────────────
  if (Health?.createMeshHealth) {
    try {
      const health = Health.createMeshHealth({ busEmit, dht: ctx.dht });
      health.install(ctx);
      moduleRegistry?.register('bridge-health', health, { modulePath: './bridge-health/index' });
      ok('bridge-health online');
    } catch (e) { skip('bridge-health', e); }
  }

  // ── IPFS content store ────────────────────────────────────────────────────
  if (IPFS?.createIPFS) {
    try {
      const ipfs = IPFS.createIPFS({ identity, dht: ctx.dht, busEmit });
      moduleRegistry?.register('bridge-ipfs', ipfs, { modulePath: './bridge-ipfs/index' });
      ok('bridge-ipfs online');
      ctx.ipfs = ipfs;
    } catch (e) { skip('bridge-ipfs', e); }
  }

  // ── DDNS ──────────────────────────────────────────────────────────────────
  if (DDNS?.install) {
    try {
      await DDNS.install({ busEmit, dataDir: ctx.config?.dataDir, identity });
      moduleRegistry?.register('bridge-ddns', DDNS, { modulePath: './bridge-ddns/index' });
      ok('bridge-ddns online');
    } catch (e) { skip('bridge-ddns', e); }
  }

  // ── Onion routing ────────────────────────────────────────────────────────
  if (Onion?.createOnionRouter) {
    try {
      const onion = Onion.createOnionRouter({ identity: { ...identity, _privateKey: identity._privateKey }, busEmit });
      moduleRegistry?.register('bridge-onion', onion, { modulePath: './bridge-onion/index' });
      ok('bridge-onion online');
      ctx.onion = onion;
    } catch (e) { skip('bridge-onion', e); }
  }

  // ── Steg + Shaper ────────────────────────────────────────────────────────
  if (Steg?.createStegChannel) {
    try {
      const steg = Steg.createStegChannel({ busEmit });
      moduleRegistry?.register('bridge-steg', steg, { modulePath: './bridge-steg/index' });
      ok('bridge-steg online');
      ctx.steg = steg;
    } catch (e) { skip('bridge-steg', e); }
  }
  if (Shaper?.createTrafficShaper) {
    try {
      const shaper = Shaper.createTrafficShaper({ busEmit });
      moduleRegistry?.register('bridge-shaper', shaper, { modulePath: './bridge-shaper/index' });
      ok('bridge-shaper online');
      ctx.shaper = shaper;
    } catch (e) { skip('bridge-shaper', e); }
  }

  // ── Unified transport (HTTP + BLE + cellular) ──────────────────────────────
  if (Transport?.createTransportManager) {
    try {
      const transport = Transport.createTransportManager({ identity, busEmit });
      await transport.start();
      transport.onMessage((payload, senderUuid, transportType) => {
        busEmit('transport:message', { payload, senderUuid, transport: transportType }, 'INFO');
      });
      moduleRegistry?.register('bridge-transport', transport, { modulePath: './bridge-transport/index' });
      ok('bridge-transport online');
      ctx.transport = transport;
    } catch (e) { skip('bridge-transport', e); }
  }

  // ── Mobile / Pi runtime ───────────────────────────────────────────────────
  if (Mobile?.createMobileRuntime) {
    try {
      const mobile = Mobile.createMobileRuntime({ identity, busEmit });
      mobile.start();
      moduleRegistry?.register('bridge-mobile', mobile, { modulePath: './bridge-mobile/index' });
      ok('bridge-mobile online');
      ctx.mobile = mobile;
      // Checkpoint on shutdown
      process.on('SIGTERM', () => mobile.beforeSuspend({ uuid: identity.uuid }));
      process.on('SIGINT',  () => mobile.beforeSuspend({ uuid: identity.uuid }));
    } catch (e) { skip('bridge-mobile', e); }
  }

  console.log('');

  // ── HTTP request handler ─────────────────────────────────────────────────
  // Intercept server before boot's 404 — CFR, canvas, CLI command, IPFS, health
  const bootListeners = server.rawListeners('request');
  server.removeAllListeners('request');

  server.on('request', async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin':  '*',
        'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Api-Key,X-Gateway',
      });
      return res.end();
    }

    const urlParts = (req.url || '/').split('?')[0].split('/').filter(Boolean);
    const method   = req.method;
    const top      = urlParts[0];

    const readBody = async () => {
      if (!['POST','PUT'].includes(method)) return {};
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { return {}; }
    };

    const jsonOut = (code, obj) => {
      if (res.headersSent) return;
      const d = JSON.stringify(obj, null, 2);
      res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Content-Length': Buffer.byteLength(d) });
      res.end(d);
    };

    // /cfr/*
    if (top === 'cfr') {
      const body   = await readBody();
      const result = CFR.route(method, urlParts, body, req, res);
      if (result === null) return;  // async response already sent by CFR
      if (result !== undefined) return jsonOut(result?.ok === false ? 400 : 200, result);
      return jsonOut(404, { ok: false, error: 'Unknown CFR route' });
    }

    // /ipfs/*
    if (top === 'ipfs' && ctx.ipfs) {
      const body = await readBody();
      const result = ctx.ipfs.route(method, urlParts, body, req, res);
      if (result === null || result === undefined) return;
      return jsonOut(result?.ok === false ? 404 : 200, result);
    }

    // /onion/*
    if (top === 'onion' && ctx.onion) {
      const body = await readBody();
      const result = ctx.onion.route(method, urlParts, body, req, res);
      if (result === null || result === undefined) return;
      return jsonOut(result?.ok === false ? 400 : 200, result);
    }

    // /steg/*
    if (top === 'steg' && ctx.steg) {
      const body = await readBody();
      const result = ctx.steg.route(method, urlParts, body, req, res);
      if (result === null || result === undefined) return;
      return jsonOut(result?.ok === false ? 400 : 200, result);
    }

    // /shaper/*
    if (top === 'shaper' && ctx.shaper) {
      const body = await readBody();
      const result = ctx.shaper.route(method, urlParts, body, req, res);
      if (result === null || result === undefined) return;
      return jsonOut(result?.ok === false ? 400 : 200, result);
    }

    // /transport/stats
    if (top === 'transport' && ctx.transport) {
      if (method === 'GET' && urlParts[1] === 'stats') {
        return jsonOut(200, { ok: true, adapters: ctx.transport.stats() });
      }
      const body = await readBody();
      const result = ctx.transport.route?.(method, urlParts, body, req, res);
      if (result) return jsonOut(result?.ok === false ? 400 : 200, result);
    }

    // /ble/* — BridgeBLE control surface
    if (top === 'ble' && ctx.transport) {
      const bleAdapter = ctx.transport._adapters?.find?.(a => a.type === 'ble');
      const ble = bleAdapter?.getBLE?.();
      const body = await readBody();
      if (method === 'GET' && urlParts[1] === 'status') {
        return jsonOut(200, { ok: true, ...(ble?.status?.() || { state: 'unavailable' }) });
      }
      if (method === 'GET' && urlParts[1] === 'peers') {
        return jsonOut(200, { ok: true, peers: ble?.peers?.() || [] });
      }
      if (method === 'GET' && urlParts[1] === 'discovered') {
        return jsonOut(200, { ok: true, nodes: ble?.discovered?.() || [] });
      }
      if (method === 'POST' && urlParts[1] === 'scan') {
        const r = ble?.scan?.(body.durationMs || 10000);
        return jsonOut(200, r || { ok: false, reason: 'BLE not available' });
      }
      if (method === 'POST' && urlParts[1] === 'connect') {
        if (!body.shortId) return jsonOut(400, { ok: false, error: 'shortId required' });
        const r = ble?.connect?.(body.shortId);
        return jsonOut(200, r || { ok: false, reason: 'BLE not available' });
      }
      if (method === 'POST' && urlParts[1] === 'disconnect') {
        if (!body.shortId) return jsonOut(400, { ok: false, error: 'shortId required' });
        const r = ble?.disconnect?.(body.shortId);
        return jsonOut(200, r || { ok: false, reason: 'BLE not available' });
      }
      if (method === 'POST' && urlParts[1] === 'send') {
        const { shortId, message } = body;
        if (!shortId || !message) return jsonOut(400, { ok: false, error: 'shortId and message required' });
        const r = await ble?.send?.(shortId, message);
        return jsonOut(200, r || { ok: false, reason: 'BLE not available' });
      }
      if (method === 'POST' && urlParts[1] === 'advertise') {
        const name = body.localName || `BRIDGE:${identity.uuid.slice(0,8)}`;
        ble?.startAdvertising?.(name);
        return jsonOut(200, { ok: true, localName: name });
      }
      if (method === 'POST' && urlParts[1] === 'stop-advertise') {
        ble?.stopAdvertising?.();
        return jsonOut(200, { ok: true });
      }
      if (method === 'POST' && urlParts[1] === 'notify') {
        const { message } = body;
        if (!message) return jsonOut(400, { ok: false, error: 'message required' });
        const r = await (ble?.notifyCentral?.(message) || Promise.resolve({ ok: false, reason: 'no ble' }));
        return jsonOut(200, { ok: true, ...r });
      }
      if (method === 'GET' && urlParts[1] === 'peripheral') {
        return jsonOut(200, { ok: true, ...(ble?.peripheralStatus?.() || { advertising: false }) });
      }
      // Enrich /ble/status with peripheral info
      if (method === 'GET' && urlParts[1] === 'status') {
        const pStatus = ble?.peripheralStatus?.() || {};
        return jsonOut(200, { ok: true, ...(ble?.status?.() || { state: 'unavailable' }), ...pStatus });
      }
      return jsonOut(404, { ok: false, error: 'Unknown BLE route' });
    }

    // /mobile/*
    if (top === 'mobile' && ctx.mobile) {
      const body = await readBody();
      const result = ctx.mobile.route(method, urlParts, body, req, res);
      if (result === null || result === undefined) return;
      return jsonOut(result?.ok === false ? 400 : 200, result);
    }

    // /health/mesh  /health/topology  /health/replay  /health/divergence  /health/heal
    if (top === 'health' && urlParts[1] && ctx.healthMod) {
      const body = await readBody();
      const result = ctx.healthMod.route(method, urlParts, body, req, res);
      if (result === null || result === undefined) return;
      return jsonOut(result?.ok === false ? 400 : 200, result);
    }

    // /canvas/*
    if (top === 'canvas' && ctx.canvas?.handle) {
      const handled = await ctx.canvas.handle(req, res, urlParts, method);
      if (handled) return;
    }

    // /cli/command — HTTP CLI endpoint
    if (top === 'cli' && method === 'POST' && urlParts[1] === 'command') {
      const body = await readBody();
      const cmd  = body.command;
      if (!cmd) return jsonOut(400, { ok: false, error: 'command required' });
      const { dispatch } = require('./bridge-cli/nexus-cli');
      const port    = Number(process.env.NEXUS_PORT) || 3747;
      const captured = [];
      const origWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = d => { captured.push(String(d)); return true; };
      try { await dispatch(cmd, { port, host: 'localhost', bus: ctx.bus, busEmit: ctx.busEmit, ctx }); }
      finally { process.stdout.write = origWrite; }
      const output = captured.join('').replace(/\x1b\[[0-9;]*m/g, '');
      return jsonOut(200, { ok: true, command: cmd, output });
    }

    // Fall through to boot's route table
    for (const listener of bootListeners) {
      if (!res.headersSent) listener.call(server, req, res);
      else break;
    }
  });

  attachShutdown(server, busEmit, identity.uuid);

  if (withCLI) {
    const { startCLI } = require('./bridge-cli/nexus-cli');
    const port = Number(process.env.NEXUS_PORT) || 3747;
    setTimeout(() => startCLI({ port, host: '127.0.0.1', bus: ctx.bus, busEmit: ctx.busEmit, ctx }), 350);
  }

}).catch(err => {
  console.error(`\n  \x1b[91m✗\x1b[0m  Boot failed: ${err.message}`);
  if (process.env.NEXUS_LOG === 'DEBUG') console.error(err.stack);
  process.exit(1);
});
