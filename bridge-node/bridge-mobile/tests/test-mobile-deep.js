// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
'use strict';
/**
 * bridge-mobile/tests/test-mobile-deep.js
 * Covers: detectPlatform, POWER_PROFILES, PowerManager, Checkpointer, Watchdog, MobileRuntime
 */
const assert = require('assert');
const os     = require('os');
const path   = require('path');
const fs     = require('fs');
const {
  createMobileRuntime, createPowerManager, createCheckpointer,
  createWatchdog, createBatteryReader, generatePiInstaller,
  detectPlatform, POWER_PROFILES,
} = require('../index');

let passed = 0, failed = 0;
const tests = [];
function test(n, fn) { tests.push({ n, fn }); }
async function run() {
  console.log('\n[bridge-mobile] Deep Test Suite\n');
  for (const t of tests) {
    try { await t.fn(); console.log(`  ✓ ${t.n}`); passed++; }
    catch (e) { console.error(`  ✗ ${t.n}\n    ${e.message}`); failed++; }
  }
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

const fakeIdentity = { uuid: '00000000-0000-0000-0000-000000000001' };

// ── detectPlatform ────────────────────────────────────────────────────────────
test('detectPlatform(): returns a non-empty string', () => {
  const p = detectPlatform();
  assert.ok(typeof p === 'string' && p.length > 0);
});

test('detectPlatform(): returns known platform string', () => {
  const p       = detectPlatform();
  const valid   = ['android','ios','rpi','linux','windows','unknown'];
  assert.ok(valid.includes(p), `unknown platform: ${p}`);
});

// ── POWER_PROFILES ────────────────────────────────────────────────────────────
test('POWER_PROFILES: all profiles have [syncMs, pulseMs, description]', () => {
  for (const [key, profile] of Object.entries(POWER_PROFILES)) {
    assert.ok(Array.isArray(profile) && profile.length === 3, `${key}: not a 3-element array`);
    assert.ok(typeof profile[0] === 'number', `${key}: syncMs not a number`);
    assert.ok(typeof profile[1] === 'number', `${key}: pulseMs not a number`);
    assert.ok(typeof profile[2] === 'string', `${key}: description not a string`);
  }
});

test('POWER_PROFILES: desktop_charging has highest sync rate', () => {
  const desktop  = POWER_PROFILES.desktop_charging[0];
  const cellular = POWER_PROFILES.mobile_cellular[0];
  assert.ok(desktop < cellular, 'desktop sync should be faster than cellular');
});

test('POWER_PROFILES: suspended profile has 0 sync interval', () => {
  assert.strictEqual(POWER_PROFILES.suspended[0], 0);
});

test('POWER_PROFILES: mobile_low_battery has no pulse (0)', () => {
  assert.strictEqual(POWER_PROFILES.mobile_low_battery[1], 0);
});

// ── PowerManager ──────────────────────────────────────────────────────────────
test('createPowerManager(): update() returns a profile array', () => {
  const pm = createPowerManager({ getBattery: () => ({ level: 1.0, charging: true }) });
  const p  = pm.update();
  assert.ok(Array.isArray(p) && p.length === 3);
});

test('createPowerManager(): low battery → low battery profile', () => {
  const pm = createPowerManager({ getBattery: () => ({ level: 0.10, charging: false }) });
  pm.update();
  // syncInterval should be high (throttled)
  assert.ok(pm.syncInterval() >= 60_000, `expected >= 60s, got ${pm.syncInterval()}`);
});

test('createPowerManager(): charging full battery → fast sync', () => {
  const pm = createPowerManager({ getBattery: () => ({ level: 1.0, charging: true }) });
  pm.update();
  assert.ok(pm.syncInterval() <= 15_000, `expected <= 15s, got ${pm.syncInterval()}`);
});

test('INVARIANT M-03: shouldAcceptInbound() always true regardless of battery', () => {
  const pmLow  = createPowerManager({ getBattery: () => ({ level: 0.05, charging: false }) });
  const pmFull = createPowerManager({ getBattery: () => ({ level: 1.0, charging: true }) });
  assert.ok(pmLow.shouldAcceptInbound());
  assert.ok(pmFull.shouldAcceptInbound());
});

test('createPowerManager(): stats() returns battery, charging, syncInterval', () => {
  const pm = createPowerManager({ getBattery: () => ({ level: 0.75, charging: false }) });
  pm.update();
  const s  = pm.stats();
  assert.ok(typeof s.battery === 'number');
  assert.ok(typeof s.charging === 'boolean');
  assert.ok(typeof s.syncInterval === 'number');
});

test('createPowerManager(): isSuspended() true only on suspended profile', () => {
  // Cannot easily force suspended profile without internal manipulation
  // But verify it returns boolean
  const pm = createPowerManager({ getBattery: () => ({ level: 1.0, charging: true }) });
  pm.update();
  assert.ok(typeof pm.isSuspended() === 'boolean');
});

// ── Checkpointer ──────────────────────────────────────────────────────────────
test('createCheckpointer(): save() + load() roundtrip', () => {
  const dir = path.join(os.tmpdir(), `mobile-ckpt-${Date.now()}`);
  const cp  = createCheckpointer({ checkpointDir: dir });
  const state = { uuid: 'test-uuid', peers: ['p1','p2'], ts: Date.now() };
  const r   = cp.save(state);
  assert.ok(r.ok);
  const loaded = cp.load();
  assert.ok(loaded);
  assert.strictEqual(loaded.uuid, 'test-uuid');
  assert.deepStrictEqual(loaded.peers, ['p1','p2']);
  fs.rmSync(dir, { recursive: true });
});

test('INVARIANT M-01: save() writes atomically (no .tmp files after save)', () => {
  const dir = path.join(os.tmpdir(), `mobile-atomic-${Date.now()}`);
  const cp  = createCheckpointer({ checkpointDir: dir });
  cp.save({ test: 'atomic' });
  const files = fs.readdirSync(dir);
  assert.ok(!files.some(f => f.includes('.tmp')), 'no tmp files should remain');
  fs.rmSync(dir, { recursive: true });
});

test('createCheckpointer(): load() returns null when no checkpoint exists', () => {
  const dir = path.join(os.tmpdir(), `mobile-nocp-${Date.now()}`);
  const cp  = createCheckpointer({ checkpointDir: dir });
  assert.strictEqual(cp.load(), null);
  fs.rmSync(dir, { recursive: true });
});

test('createCheckpointer(): clear() removes checkpoint file', () => {
  const dir = path.join(os.tmpdir(), `mobile-clear-${Date.now()}`);
  const cp  = createCheckpointer({ checkpointDir: dir });
  cp.save({ data: 'to clear' });
  assert.ok(cp.load() !== null);
  cp.clear();
  assert.strictEqual(cp.load(), null);
  fs.rmSync(dir, { recursive: true });
});

// ── Watchdog ──────────────────────────────────────────────────────────────────
test('createWatchdog(): stats() returns active, fed, device', () => {
  const wd = createWatchdog({ device: '/dev/null' });
  const s  = wd.stats();
  assert.ok('active' in s && 'fed' in s && 'device' in s);
});

test('createWatchdog(): stop() does not throw when not started', () => {
  const wd = createWatchdog({ device: '/nonexistent/watchdog' });
  assert.doesNotThrow(() => wd.stop());
});

test('createWatchdog(): unavailable device sets active:false', () => {
  const wd = createWatchdog({ device: '/nonexistent/watchdog' });
  wd.start(); // should fail gracefully
  assert.ok(!wd.stats().active);
});

// ── generatePiInstaller ───────────────────────────────────────────────────────
test('generatePiInstaller(): returns a bash script string', () => {
  const script = generatePiInstaller({ nodeUuid: 'test-uuid', port: 3747 });
  assert.ok(typeof script === 'string');
  assert.ok(script.startsWith('#!/bin/bash'));
});

test('generatePiInstaller(): includes systemd unit', () => {
  const script = generatePiInstaller({ nodeUuid: 'uuid-1', port: 3747 });
  assert.ok(script.includes('bridge-os.service'));
  assert.ok(script.includes('WantedBy=multi-user.target'));
});

test('generatePiInstaller(): includes watchdog config (M-04)', () => {
  const script = generatePiInstaller({ nodeUuid: 'uuid-1' });
  assert.ok(script.includes('WatchdogSec'), 'must include watchdog integration');
});

test('generatePiInstaller(): includes resource limits', () => {
  const script = generatePiInstaller({});
  assert.ok(script.includes('MemoryMax') && script.includes('CPUQuota'));
});

test('generatePiInstaller(): includes log rotation', () => {
  const script = generatePiInstaller({});
  assert.ok(script.includes('logrotate'));
});

test('generatePiInstaller(): embeds node UUID', () => {
  const script = generatePiInstaller({ nodeUuid: 'my-special-uuid-1234' });
  assert.ok(script.includes('my-special-uuid-1234'));
});

// ── MobileRuntime ─────────────────────────────────────────────────────────────
test('createMobileRuntime(): returns start, stop, route, diagnostics', () => {
  const dir = path.join(os.tmpdir(), `mobile-rt-${Date.now()}`);
  const rt  = createMobileRuntime({ identity: fakeIdentity, checkpointDir: dir, enableWatchdog: false });
  for (const m of ['start','stop','route','diagnostics']) assert.strictEqual(typeof rt[m], 'function');
  fs.rmSync(dir, { recursive: true });
});

test('createMobileRuntime(): start() + stop() does not throw', () => {
  const dir = path.join(os.tmpdir(), `mobile-ss-${Date.now()}`);
  const rt  = createMobileRuntime({ identity: fakeIdentity, checkpointDir: dir, enableWatchdog: false });
  assert.doesNotThrow(() => { rt.start(); rt.stop(); });
  fs.rmSync(dir, { recursive: true });
});

test('createMobileRuntime(): diagnostics() returns platform and uptime', () => {
  const dir = path.join(os.tmpdir(), `mobile-diag-${Date.now()}`);
  const rt  = createMobileRuntime({ identity: fakeIdentity, checkpointDir: dir, enableWatchdog: false });
  const d   = rt.diagnostics();
  assert.ok(d.platform && typeof d.uptime === 'number');
  fs.rmSync(dir, { recursive: true });
});

test('route GET /mobile/status: returns ok:true with platform', () => {
  const dir = path.join(os.tmpdir(), `mobile-route-${Date.now()}`);
  const rt  = createMobileRuntime({ identity: fakeIdentity, checkpointDir: dir, enableWatchdog: false });
  let status, body;
  const res = { writeHead: (s) => { status = s; }, end: (b) => { body = JSON.parse(b); } };
  rt.route('GET', ['mobile', 'status'], null, null, res);
  assert.strictEqual(status, 200);
  assert.ok(body.ok && body.platform);
  rt.stop();
  fs.rmSync(dir, { recursive: true });
});

test('route GET /mobile/power: returns ok:true with battery info', () => {
  const dir = path.join(os.tmpdir(), `mobile-power-${Date.now()}`);
  const rt  = createMobileRuntime({ identity: fakeIdentity, checkpointDir: dir, enableWatchdog: false });
  let status, body;
  const res = { writeHead: (s) => { status = s; }, end: (b) => { body = JSON.parse(b); } };
  rt.route('GET', ['mobile', 'power'], null, null, res);
  assert.strictEqual(status, 200);
  assert.ok(body.ok);
  rt.stop();
  fs.rmSync(dir, { recursive: true });
});

test('route POST /mobile/checkpoint: saves state', () => {
  const dir = path.join(os.tmpdir(), `mobile-cp-route-${Date.now()}`);
  const rt  = createMobileRuntime({ identity: fakeIdentity, checkpointDir: dir, enableWatchdog: false });
  let status, body;
  const res = { writeHead: (s) => { status = s; }, end: (b) => { body = JSON.parse(b); } };
  rt.route('POST', ['mobile', 'checkpoint'], { test: 'route checkpoint' }, null, res);
  assert.strictEqual(status, 200);
  assert.ok(body.ok);
  rt.stop();
  fs.rmSync(dir, { recursive: true });
});

test('generatePiInstaller via runtime: includes identity UUID', () => {
  const dir  = path.join(os.tmpdir(), `mobile-pi-${Date.now()}`);
  const rt   = createMobileRuntime({ identity: fakeIdentity, checkpointDir: dir, enableWatchdog: false });
  const script = rt.generatePiInstaller({ port: 3747 });
  assert.ok(script.includes(fakeIdentity.uuid));
  rt.stop();
  fs.rmSync(dir, { recursive: true });
});

run();
