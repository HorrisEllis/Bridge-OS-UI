// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
'use strict';
const assert  = require('assert');
const { createWSGateway }     = require('../gateway/ws-gateway');
const { createCalltoRouter }  = require('../../bridge-node/callto-router');
const { NON_DOM_CALLTOS }     = require('../../bridge-core/registry/index');

let passed = 0, failed = 0;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
async function run() {
  console.log('\n[bridge-plugin] Test Suite\n');
  for (const t of tests) {
    try { await t.fn(); console.log(`  ✓ ${t.name}`); passed++; }
    catch (e) { console.log(`  ✗ ${t.name}\n    ${e.message}`); failed++; }
  }
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

// ── Mock WS session for router tests ─────────────────────────────────────────
function makeMockSessions({ origin, executeResult = { ok: true, result: 'clicked' } } = {}) {
  let session = {
    id: 'mock-session-1',
    origin,
    role: 'primary',
    capabilities: {
      url:             origin + '/page',
      visibilityState: 'visible',
      domHash:         'abc123',
      lastUpdated:     Date.now(),
    },
    execute: async () => executeResult,
  };

  return {
    getPrimaryForOrigin: (o) => o === origin ? session : null,
    _session: session,
  };
}

// ── Suite 1: WSGateway session management ─────────────────────────────────────

test('getState() returns bootId', () => {
  const gw = createWSGateway({});
  const state = gw.getState();
  assert.ok(state.bootId);
  assert.ok(typeof state.bootId === 'string');
});

test('getPrimaryForOrigin returns null when no sessions', () => {
  const gw = createWSGateway({});
  assert.strictEqual(gw.getPrimaryForOrigin('https://claude.ai'), null);
});

test('getState() includes empty sessions object', () => {
  const gw    = createWSGateway({});
  const state = gw.getState();
  assert.ok(typeof state.sessions === 'object');
});

// ── Suite 2: Callto router — WS primary path ──────────────────────────────────

test('router routes to WS when session available', async () => {
  const sessions = makeMockSessions({ origin: 'https://claude.ai' });
  const events   = [];
  const router   = createCalltoRouter({
    wsSessions: sessions,
    busEmit:    (sig, data) => events.push({ sig, data }),
  });

  const result = await router.route({
    action: 'click', selector: '#btn', origin: 'https://claude.ai',
  });

  assert.ok(result.ok, JSON.stringify(result));
  assert.strictEqual(result.method, 'ws');
});

test('router falls back when no WS session', async () => {
  const sessions = { getPrimaryForOrigin: () => null };
  const router   = createCalltoRouter({ wsSessions: sessions, playwrightEnabled: false });

  const result = await router.route({
    action: 'click', selector: '#btn', origin: 'https://unknown.com',
  });

  assert.ok(!result.ok);
  assert.ok(result.error.includes('No execution method'));
});

test('NON_DOM callto skips WS — goes to CDP or error', async () => {
  const sessions = makeMockSessions({ origin: 'https://claude.ai' });
  const router   = createCalltoRouter({ wsSessions: sessions });

  const result = await router.route({
    action: 'browser.download', selector: null, origin: 'https://claude.ai',
  });

  // Should NOT have used WS — method should be cdp or null
  assert.notStrictEqual(result.method, 'ws', 'NON_DOM callto must not use WS');
});

test('stale capabilities → skip WS and fall through', async () => {
  const sessions = makeMockSessions({ origin: 'https://stale.com' });
  // Force stale capabilities
  sessions._session.capabilities.lastUpdated = Date.now() - 60000;

  const router = createCalltoRouter({ wsSessions: sessions, playwrightEnabled: false });
  const result = await router.route({
    action: 'click', selector: '#x', origin: 'https://stale.com',
  });

  assert.notStrictEqual(result.method, 'ws', 'Stale session should not execute');
});

test('origin mismatch → skip WS', async () => {
  const sessions = makeMockSessions({ origin: 'https://claude.ai' });
  const router   = createCalltoRouter({ wsSessions: sessions });

  const result = await router.route({
    action: 'click', selector: '#x', origin: 'https://different.com',
  });

  assert.notStrictEqual(result.method, 'ws');
});

test('playwrightEnabled:false + no session → explicit error message', async () => {
  const router = createCalltoRouter({
    wsSessions: { getPrimaryForOrigin: () => null },
    playwrightEnabled: false,
  });
  const result = await router.route({ action: 'click', selector: '#btn', origin: 'https://x.com' });
  assert.ok(!result.ok);
  assert.ok(result.error.includes('No execution method'), result.error);
});

test('playwrightEnabled:true but playwright not installed → clear error', async () => {
  const router = createCalltoRouter({
    wsSessions: { getPrimaryForOrigin: () => null },
    playwrightEnabled: true,
  });
  const result = await router.route({ action: 'click', selector: '#btn', origin: 'https://x.com' });
  assert.ok(!result.ok);
  // Should mention Playwright specifically
  assert.ok(result.error.toLowerCase().includes('playwright'), result.error);
});

test('callto:executed event emitted on every route', async () => {
  const sessions = makeMockSessions({ origin: 'https://claude.ai' });
  const events   = [];
  const router   = createCalltoRouter({
    wsSessions: sessions,
    busEmit:    (sig, data) => events.push({ sig, data }),
  });

  await router.route({ action: 'click', selector: '#btn', origin: 'https://claude.ai' });
  const execs = events.filter(e => e.sig === 'callto:executed');
  assert.ok(execs.length >= 1);
  assert.ok('method' in execs[0].data);
  assert.ok('durationMs' in execs[0].data);
});

test('result includes durationMs', async () => {
  const sessions = makeMockSessions({ origin: 'https://claude.ai' });
  const router   = createCalltoRouter({ wsSessions: sessions });
  const result   = await router.route({ action: 'click', selector: '#btn', origin: 'https://claude.ai' });
  assert.ok(typeof result.durationMs === 'number');
  assert.ok(result.durationMs >= 0);
});

// ── Suite 3: NON_DOM_CALLTOS list ─────────────────────────────────────────────

test('NON_DOM_CALLTOS is populated with expected actions', () => {
  assert.ok(NON_DOM_CALLTOS.includes('browser.download'));
  assert.ok(NON_DOM_CALLTOS.includes('browser.auth.popup'));
  assert.ok(NON_DOM_CALLTOS.includes('browser.file.choose'));
  assert.ok(NON_DOM_CALLTOS.includes('browser.iframe.cross-origin'));
});

test('DOM actions not in NON_DOM_CALLTOS', () => {
  const domActions = ['click', 'type', 'extract', 'scroll', 'hover', 'select', 'check'];
  for (const a of domActions) {
    assert.ok(!NON_DOM_CALLTOS.includes(a), `${a} should not be in NON_DOM_CALLTOS`);
  }
});

// ── Suite 4: HTTP route handler ───────────────────────────────────────────────

test('/userscript/sessions returns count:0 initially', () => {
  const gw  = createWSGateway({});
  const res = mockRes();
  gw.route('GET', ['userscript', 'sessions'], null, null, res);
  assert.strictEqual(res._status, 200);
  assert.strictEqual(res._json.count, 0);
});

test('/userscript/broadcast returns sent count', () => {
  const gw  = createWSGateway({});
  const res = mockRes();
  gw.route('POST', ['userscript', 'broadcast'], { type: 'test', data: {} }, null, res);
  assert.strictEqual(res._status, 200);
  assert.strictEqual(res._json.sent, 0); // no sessions connected
});

test('unknown route returns 404', () => {
  const gw  = createWSGateway({});
  const res = mockRes();
  gw.route('GET', ['userscript', 'unknown'], null, null, res);
  assert.strictEqual(res._status, 404);
});

// ── Mock response helper ──────────────────────────────────────────────────────
function mockRes() {
  const r = { _status: null, _json: null, headersSent: false };
  r.writeHead = (s) => { r._status = s; };
  r.end = (d) => { try { r._json = JSON.parse(d); } catch { r._raw = d; } };
  return r;
}

run();
