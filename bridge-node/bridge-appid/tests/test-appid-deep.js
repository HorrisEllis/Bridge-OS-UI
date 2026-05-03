// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
'use strict';
/**
 * bridge-appid/tests/test-appid-deep.js
 * Deep test suite — AppID Registry, one-time codes, session tokens
 * §4.1 §1.1 §1.2 §4.3
 */

const assert = require('assert');
const os     = require('os');
const path   = require('path');
const fs     = require('fs');
const { AppIDRegistry, MODULE_UUID, MODULE_VERSION } = require('../index');

let passed = 0, failed = 0;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
async function run() {
  console.log('\n[bridge-appid] Deep Test Suite\n');
  for (const t of tests) {
    try { await t.fn(); console.log(`  ✓ ${t.name}`); passed++; }
    catch (e) { console.error(`  ✗ ${t.name}\n    ${e.message}`); failed++; }
  }
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

function makeRegistry(opts = {}) {
  const dataDir = opts.dataDir || path.join(os.tmpdir(), `appid-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const identity = opts.identity || { uuid: 'test-node-uuid-abcd1234', sessionSeed: 'test-seed-xyz' };
  const busEmit  = opts.busEmit  || (() => {});
  return { reg: new AppIDRegistry({ dataDir, identity, busEmit }), dataDir };
}

// ── Module identity ───────────────────────────────────────────────────────────

test('MODULE_UUID is non-empty string', () => {
  assert.ok(typeof MODULE_UUID === 'string' && MODULE_UUID.length > 0);
});
test('MODULE_VERSION is semver-like', () => {
  assert.match(MODULE_VERSION, /^\d+\.\d+\.\d+$/);
});

// ── create() ─────────────────────────────────────────────────────────────────

test('create(): ok:true for valid appId', () => {
  const { reg } = makeRegistry();
  const r = reg.create('guardian');
  assert.ok(r.ok, JSON.stringify(r));
});
test('create(): returns code with nxt- prefix', () => {
  const { reg } = makeRegistry();
  const r = reg.create('guardian');
  assert.ok(r.code.startsWith('nxt-'), `code=${r.code}`);
});
test('create(): returns nexus:// URI', () => {
  const { reg } = makeRegistry();
  const r = reg.create('guardian');
  assert.ok(r.uri.startsWith('nexus://'), `uri=${r.uri}`);
});
test('create(): URI contains code and appId', () => {
  const { reg } = makeRegistry();
  const r = reg.create('cfr');
  assert.ok(r.uri.includes(r.code));
  assert.ok(r.uri.includes('cfr'));
});
test('create(): returns capabilities array', () => {
  const { reg } = makeRegistry();
  const r = reg.create('guardian');
  assert.ok(Array.isArray(r.capabilities) && r.capabilities.length > 0);
});
test('create(): guardian gets callto,listener,bus,dom capabilities', () => {
  const { reg } = makeRegistry();
  const r = reg.create('guardian');
  assert.ok(r.capabilities.includes('callto'));
  assert.ok(r.capabilities.includes('bus'));
});
test('create(): cfr gets render,physics,pulse capabilities', () => {
  const { reg } = makeRegistry();
  const r = reg.create('cfr');
  assert.ok(r.capabilities.includes('render'));
  assert.ok(r.capabilities.includes('physics'));
});
test('create(): unknown appId gets default capabilities', () => {
  const { reg } = makeRegistry();
  const r = reg.create('unknown-app-xyz');
  assert.ok(Array.isArray(r.capabilities));
  assert.ok(r.capabilities.includes('bus:read'));
});
test('create(): appUuid is deterministic per nodeUuid+appId', () => {
  const identity = { uuid: 'stable-node', sessionSeed: 'seed' };
  const { reg: r1, dataDir: d1 } = makeRegistry({ identity });
  const { reg: r2, dataDir: d2 } = makeRegistry({ identity });
  const a1 = r1.create('guardian').appUuid;
  const a2 = r2.create('guardian').appUuid;
  assert.strictEqual(a1, a2);
  fs.rmSync(d1, { recursive: true });
  fs.rmSync(d2, { recursive: true });
});
test('create(): rejects invalid appId (uppercase)', () => {
  const { reg } = makeRegistry();
  const r = reg.create('GUARDIAN');
  assert.ok(!r.ok);
  assert.match(r.error, /Invalid appId/);
});
test('create(): rejects appId with spaces', () => {
  const { reg } = makeRegistry();
  const r = reg.create('my app');
  assert.ok(!r.ok);
});
test('create(): rejects empty appId', () => {
  const { reg } = makeRegistry();
  const r = reg.create('');
  assert.ok(!r.ok);
});
test('create(): rejects appId > 32 chars', () => {
  const { reg } = makeRegistry();
  const r = reg.create('a'.repeat(33));
  assert.ok(!r.ok);
});
test('create(): accepts hyphenated appId', () => {
  const { reg } = makeRegistry();
  const r = reg.create('my-app-123');
  assert.ok(r.ok);
});
test('create(): expiresAt is ISO string in future', () => {
  const { reg } = makeRegistry();
  const r = reg.create('guardian');
  assert.ok(new Date(r.expiresAt) > new Date());
});
test('create(): sequential calls with delay produce unique codes', async () => {
  // Codes are HMAC(appId+ts) — same ms = same code. Real uniqueness is per-ms.
  const { reg } = makeRegistry();
  const codes = [];
  for (let i = 0; i < 5; i++) {
    codes.push(reg.create('guardian').code);
    await new Promise(r => setTimeout(r, 2)); // different ms = different code
  }
  const unique = new Set(codes);
  assert.strictEqual(unique.size, 5);
});
test('create(): emits appid:code:created on bus', () => {
  const emitted = [];
  const { reg } = makeRegistry({ busEmit: (sig, d) => emitted.push({ sig, d }) });
  reg.create('sentinel');
  assert.ok(emitted.find(e => e.sig === 'appid:code:created'));
});
test('create(): persists appId to disk (appids.json)', () => {
  const { reg, dataDir } = makeRegistry();
  reg.create('guardian');
  const file = path.join(dataDir, 'appids.json');
  assert.ok(fs.existsSync(file));
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(data.apps.guardian);
  fs.rmSync(dataDir, { recursive: true });
});
test('create(): loads persisted appId on new registry instance', () => {
  const identity = { uuid: 'persist-node', sessionSeed: 'seed' };
  const dataDir  = path.join(os.tmpdir(), `appid-persist-${Date.now()}`);
  const r1 = new AppIDRegistry({ dataDir, identity, busEmit: () => {} });
  r1.create('erosmancer');
  const r2 = new AppIDRegistry({ dataDir, identity, busEmit: () => {} });
  const apps = r2.list();
  assert.ok(apps.find(a => a.appId === 'erosmancer'));
  fs.rmSync(dataDir, { recursive: true });
});

// ── redeem() ──────────────────────────────────────────────────────────────────

test('redeem(): ok:true with valid code and appId', () => {
  const { reg } = makeRegistry();
  const created = reg.create('guardian');
  const r = reg.redeem(created.code, 'guardian');
  assert.ok(r.ok, JSON.stringify(r));
});
test('redeem(): returns token starting with stk-', () => {
  const { reg } = makeRegistry();
  const created = reg.create('guardian');
  const r = reg.redeem(created.code, 'guardian');
  assert.ok(r.token.startsWith('stk-'));
});
test('redeem(): returns appId and appUuid', () => {
  const { reg } = makeRegistry();
  const created = reg.create('cfr');
  const r = reg.redeem(created.code, 'cfr');
  assert.strictEqual(r.appId, 'cfr');
  assert.ok(r.appUuid);
});
test('redeem(): returns capabilities', () => {
  const { reg } = makeRegistry();
  const created = reg.create('cfr');
  const r = reg.redeem(created.code, 'cfr');
  assert.ok(Array.isArray(r.capabilities));
});
test('redeem(): code is single-use — second redeem fails', () => {
  const { reg } = makeRegistry();
  const created = reg.create('guardian');
  reg.redeem(created.code, 'guardian');
  const r = reg.redeem(created.code, 'guardian');
  assert.ok(!r.ok);
  assert.match(r.error, /already used/);
});
test('redeem(): wrong appId fails', () => {
  const { reg } = makeRegistry();
  const created = reg.create('guardian');
  const r = reg.redeem(created.code, 'cfr');
  assert.ok(!r.ok);
  assert.match(r.error, /mismatch/);
});
test('redeem(): nonexistent code fails', () => {
  const { reg } = makeRegistry();
  const r = reg.redeem('nxt-fake-code', 'guardian');
  assert.ok(!r.ok);
  assert.match(r.error, /not found|expired/);
});
test('redeem(): emits appid:session:created on bus', () => {
  const emitted = [];
  const { reg } = makeRegistry({ busEmit: (sig, d) => emitted.push({ sig, d }) });
  const created = reg.create('guardian');
  reg.redeem(created.code, 'guardian');
  assert.ok(emitted.find(e => e.sig === 'appid:session:created'));
});
test('redeem(): increments session count in app record', () => {
  const { reg } = makeRegistry();
  reg.create('sentinel');
  const code1 = reg.create('sentinel').code;
  reg.redeem(code1, 'sentinel');
  const apps = reg.list();
  const app = apps.find(a => a.appId === 'sentinel');
  assert.ok(app.sessions >= 1);
});

// ── validateSession() ─────────────────────────────────────────────────────────

test('validateSession(): ok:true for fresh token', () => {
  const { reg } = makeRegistry();
  const created = reg.create('guardian');
  const { token } = reg.redeem(created.code, 'guardian');
  const r = reg.validateSession(token);
  assert.ok(r.ok, JSON.stringify(r));
});
test('validateSession(): returns appId', () => {
  const { reg } = makeRegistry();
  const created = reg.create('cfr');
  const { token } = reg.redeem(created.code, 'cfr');
  const r = reg.validateSession(token);
  assert.strictEqual(r.appId, 'cfr');
});
test('validateSession(): returns capabilities', () => {
  const { reg } = makeRegistry();
  const created = reg.create('guardian');
  const { token } = reg.redeem(created.code, 'guardian');
  const r = reg.validateSession(token);
  assert.ok(Array.isArray(r.capabilities));
});
test('validateSession(): invalid token returns ok:false', () => {
  const { reg } = makeRegistry();
  const r = reg.validateSession('stk-fake-token-that-does-not-exist');
  assert.ok(!r.ok);
  assert.match(r.error, /Invalid token/);
});

// ── list() ────────────────────────────────────────────────────────────────────

test('list(): returns array', () => {
  const { reg } = makeRegistry();
  assert.ok(Array.isArray(reg.list()));
});
test('list(): empty before any creates', () => {
  const { reg } = makeRegistry();
  assert.strictEqual(reg.list().length, 0);
});
test('list(): contains created appIds', () => {
  const { reg } = makeRegistry();
  reg.create('guardian');
  reg.create('sentinel');
  const apps = reg.list();
  assert.ok(apps.find(a => a.appId === 'guardian'));
  assert.ok(apps.find(a => a.appId === 'sentinel'));
});
test('list(): each entry has required fields', () => {
  const { reg } = makeRegistry();
  reg.create('guardian');
  const apps = reg.list();
  for (const a of apps) {
    assert.ok(a.appId, 'missing appId');
    assert.ok(a.appUuid, 'missing appUuid');
    assert.ok(Array.isArray(a.capabilities), 'capabilities not array');
    assert.ok(typeof a.sessions === 'number', 'sessions not number');
    assert.ok(a.createdAt, 'missing createdAt');
  }
});

// ── diagnostics() ─────────────────────────────────────────────────────────────

test('diagnostics(): online:true', () => {
  const { reg } = makeRegistry();
  assert.ok(reg.diagnostics().online);
});
test('diagnostics(): apps count matches created', () => {
  const { reg } = makeRegistry();
  reg.create('guardian');
  reg.create('cfr');
  assert.strictEqual(reg.diagnostics().apps, 2);
});
test('diagnostics(): pendingCodes counts unused valid codes', () => {
  const { reg } = makeRegistry();
  reg.create('guardian');
  reg.create('guardian');
  const d = reg.diagnostics();
  assert.ok(d.pendingCodes >= 1);
});
test('diagnostics(): activeSessions reflects redeemed tokens', () => {
  const { reg } = makeRegistry();
  const c1 = reg.create('guardian');
  reg.redeem(c1.code, 'guardian');
  const d = reg.diagnostics();
  assert.ok(d.activeSessions >= 1);
});

// ── HTTP route() ──────────────────────────────────────────────────────────────

test('route(): POST /appid/create returns ok:true', () => {
  const { reg } = makeRegistry();
  const r = reg.route('POST', ['appid', 'create'], { appId: 'guardian' });
  assert.ok(r.ok);
});
test('route(): POST /appid/create requires appId', () => {
  const { reg } = makeRegistry();
  const r = reg.route('POST', ['appid', 'create'], {});
  assert.ok(!r.ok);
  assert.match(r.error, /appId required/);
});
test('route(): POST /appid/redeem full flow', () => {
  const { reg } = makeRegistry();
  const { code } = reg.route('POST', ['appid', 'create'], { appId: 'cfr' });
  const r = reg.route('POST', ['appid', 'redeem'], { code, appId: 'cfr' });
  assert.ok(r.ok);
  assert.ok(r.token.startsWith('stk-'));
});
test('route(): POST /appid/redeem requires code and appId', () => {
  const { reg } = makeRegistry();
  const r = reg.route('POST', ['appid', 'redeem'], { code: 'nxt-only' });
  assert.ok(!r.ok);
  assert.match(r.error, /code and appId required/);
});
test('route(): POST /appid/session validates token', () => {
  const { reg } = makeRegistry();
  const { code } = reg.route('POST', ['appid', 'create'], { appId: 'guardian' });
  const { token } = reg.route('POST', ['appid', 'redeem'], { code, appId: 'guardian' });
  const r = reg.route('POST', ['appid', 'session'], { token });
  assert.ok(r.ok);
});
test('route(): GET /appid/list returns apps array', () => {
  const { reg } = makeRegistry();
  reg.create('guardian');
  const r = reg.route('GET', ['appid', 'list'], {});
  assert.ok(r.ok);
  assert.ok(Array.isArray(r.apps));
});
test('route(): GET /appid/stats returns diagnostics', () => {
  const { reg } = makeRegistry();
  const r = reg.route('GET', ['appid', 'stats'], {});
  assert.ok(r.ok);
  assert.ok(typeof r.apps === 'number');
});
test('route(): unknown sub returns null', () => {
  const { reg } = makeRegistry();
  const r = reg.route('GET', ['appid', 'nonexistent'], {});
  assert.strictEqual(r, null);
});
test('route(): wrong top-level returns null', () => {
  const { reg } = makeRegistry();
  const r = reg.route('GET', ['other', 'list'], {});
  assert.strictEqual(r, null);
});

run();
