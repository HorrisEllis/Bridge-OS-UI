// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
'use strict';
const assert = require('assert');
const { registerGuardianHook, GUARDIAN_MODULE_UUID } = require('../guardian-bridge');
const { createDataBus }  = require('../../bridge-data/index');
const { createCalltoRegistry } = require('../../bridge-core/registry/index');
const { createIME }      = require('../../bridge-IME/index');

let passed = 0, failed = 0;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
async function run() {
  console.log('\n[guardian-bridge] Test Suite\n');
  for (const t of tests) {
    try { await t.fn(); console.log(`  ✓ ${t.name}`); passed++; }
    catch (e) { console.log(`  ✗ ${t.name}\n    ${e.message}`); failed++; }
  }
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

function makeEnv() {
  const events         = [];
  const calltoRegistry = createCalltoRegistry();
  const ime            = createIME({ storeDir: null });
  const busEmit        = (sig, data, level) => events.push({ sig, data, level });
  const dataBus        = createDataBus({ ime, busEmit });
  registerGuardianHook({ dataBus, busEmit, ime, calltoRegistry });
  return { dataBus, busEmit, ime, calltoRegistry, events };
}

async function push(env, tag, payload = {}) {
  return env.dataBus.push({
    uuid:       'guardian-tab-uuid',
    moduleUuid: GUARDIAN_MODULE_UUID,
    tag,
    payload,
    _localVerified: true,
  });
}

// ── Suite 1: Module UUID ──────────────────────────────────────────────────────

test('GUARDIAN_MODULE_UUID is a fixed stable string', () => {
  assert.strictEqual(GUARDIAN_MODULE_UUID, 'guardian-firefox-ext-0000-000000000001');
});

// ── Suite 2: Element picker ───────────────────────────────────────────────────

test('guardian.picker.capture → callto registered', async () => {
  const env = makeEnv();
  await push(env, 'guardian.picker.capture', {
    selector: '#submit-btn', origin: 'https://claude.ai',
    sessionId: 's1', backendNodeId: 12345,
  });
  const calltos = env.calltoRegistry.list({ origin: 'https://claude.ai' });
  assert.ok(calltos.length >= 1);
  assert.strictEqual(calltos[0].selector, '#submit-btn');
});

test('guardian.picker.capture → guardian:element:captured bus event', async () => {
  const env = makeEnv();
  await push(env, 'guardian.picker.capture', {
    selector: '#btn', origin: 'https://claude.ai',
  });
  const ev = env.events.find(e => e.sig === 'guardian:element:captured');
  assert.ok(ev, 'Expected guardian:element:captured event');
  assert.ok(ev.data.calltoUuid.startsWith('ct_'));
});

test('guardian.picker.capture without selector → no callto', async () => {
  const env = makeEnv();
  await push(env, 'guardian.picker.capture', { origin: 'https://claude.ai' }); // no selector
  const calltos = env.calltoRegistry.list({ origin: 'https://claude.ai' });
  assert.strictEqual(calltos.length, 0);
});

// ── Suite 3: Cookie capture ───────────────────────────────────────────────────

test('guardian.cookies.capture → guardian:cookies:captured', async () => {
  const env = makeEnv();
  await push(env, 'guardian.cookies.capture', { domain: 'claude.ai', count: 5 });
  const ev = env.events.find(e => e.sig === 'guardian:cookies:captured');
  assert.ok(ev);
  assert.strictEqual(ev.data.domain, 'claude.ai');
  assert.strictEqual(ev.data.count, 5);
});

// ── Suite 4: Chat events ──────────────────────────────────────────────────────

test('guardian.chat.message → guardian:chat:event', async () => {
  const env = makeEnv();
  await push(env, 'guardian.chat.message', {
    provider: 'claude', role: 'user', text: 'hello', conversationId: 'conv1',
  });
  const ev = env.events.find(e => e.sig === 'guardian:chat:event');
  assert.ok(ev);
  assert.strictEqual(ev.data.provider, 'claude');
});

test('guardian.chat.response → guardian:chat:event', async () => {
  const env = makeEnv();
  await push(env, 'guardian.chat.response', {
    provider: 'chatgpt', role: 'assistant', text: 'hi there',
  });
  const ev = env.events.find(e => e.sig === 'guardian:chat:event');
  assert.ok(ev);
  assert.strictEqual(ev.data.type, 'guardian.chat.response');
});

// ── Suite 5: Social events ────────────────────────────────────────────────────

test('guardian.ig.dm → guardian:social:event with platform=instagram', async () => {
  const env = makeEnv();
  await push(env, 'guardian.ig.dm', { text: 'dm text', direction: 'received', url: 'https://instagram.com/direct' });
  const ev = env.events.find(e => e.sig === 'guardian:social:event');
  assert.ok(ev);
  assert.strictEqual(ev.data.platform, 'instagram');
});

test('guardian.threads.post → guardian:social:event with platform=threads', async () => {
  const env = makeEnv();
  await push(env, 'guardian.threads.post', { text: 'post', url: 'https://threads.net/@user' });
  const ev = env.events.find(e => e.sig === 'guardian:social:event');
  assert.ok(ev);
  assert.strictEqual(ev.data.platform, 'threads');
});

// ── Suite 6: Session events ───────────────────────────────────────────────────

test('guardian.session.connect → guardian:session:event', async () => {
  const env = makeEnv();
  await push(env, 'guardian.session.connect', { tabId: 1, origin: 'https://claude.ai' });
  const ev = env.events.find(e => e.sig === 'guardian:session:event');
  assert.ok(ev);
  assert.strictEqual(ev.data.type, 'guardian.session.connect');
});

// ── Suite 7: Voice save ───────────────────────────────────────────────────────

test('guardian.voice.save → guardian:voice:saved', async () => {
  const env = makeEnv();
  await push(env, 'guardian.voice.save', { duration: 300000, size: 1048576 });
  const ev = env.events.find(e => e.sig === 'guardian:voice:saved');
  assert.ok(ev);
  assert.strictEqual(ev.data.duration, 300000);
});

// ── Suite 8: Unknown tag fallback ─────────────────────────────────────────────

test('unknown tag → guardian:event fallback', async () => {
  const env = makeEnv();
  await push(env, 'guardian.custom.unknown.tag', { x: 1 });
  const ev = env.events.find(e => e.sig === 'guardian:event');
  assert.ok(ev);
  assert.strictEqual(ev.data.tag, 'guardian.custom.unknown.tag');
});

// ── Suite 9: IME profiling ────────────────────────────────────────────────────

test('Guardian events feed IME profile', async () => {
  const env  = makeEnv();
  const uuid = 'guardian-tab-uuid';
  await push(env, 'guardian.picker.capture', { selector: '#a', origin: 'https://claude.ai' });
  await push(env, 'guardian.chat.response', { provider: 'claude', text: 'hello' });
  const profile = env.ime.getProfile(uuid);
  assert.ok(profile, 'IME should have profile');
  assert.ok(profile.eventCount >= 2);
});

// ── Suite 10: Data flow integrity ─────────────────────────────────────────────

test('push returns ok:true for all guardian tags', async () => {
  const env  = makeEnv();
  const tags = [
    'guardian.picker.capture', 'guardian.cookies.capture',
    'guardian.chat.message', 'guardian.ig.dm', 'guardian.session.connect',
  ];
  for (const tag of tags) {
    const r = await push(env, tag, { selector: '#x', origin: 'https://test.com' });
    assert.ok(r.ok, `push for ${tag} should return ok:true, got: ${JSON.stringify(r)}`);
  }
});

run();
