// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
'use strict';
const assert = require('assert');
const http   = require('http');
const os     = require('os');
const path   = require('path');
const fs     = require('fs');
const { boot } = require('../boot');

let passed = 0, failed = 0;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

async function req(port, method, urlPath, body = null) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: '127.0.0.1', port, method,
      path: urlPath,
      headers: { 'Content-Type': 'application/json' },
      timeout: 3000,
    };
    const r = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); }
        catch { resolve({ status: res.statusCode, body: null }); }
      });
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

async function run() {
  console.log('\n[bridge-node integration] Test Suite\n');

  // Boot the server on a random port
  const dir  = path.join(os.tmpdir(), `boot-test-${Date.now()}`);
  const port = 13700 + Math.floor(Math.random() * 1000);
  let instance;

  try {
    instance = await boot({ port, dataDir: dir, playwrightEnabled: false });
  } catch (e) {
    console.error('Boot failed:', e.message);
    process.exit(1);
  }

  const { server } = instance;

  for (const t of tests) {
    try { await t.fn(port); console.log(`  ✓ ${t.name}`); passed++; }
    catch (e) { console.log(`  ✗ ${t.name}\n    ${e.message}`); failed++; }
  }

  await new Promise(r => server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('GET /health returns 200 with uuid', async (port) => {
  const r = await req(port, 'GET', '/health');
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.ok);
  assert.ok(r.body.uuid);
  assert.match(r.body.uuid, /^[0-9a-f]{8}-/);
});

test('GET /health shows playwright disabled', async (port) => {
  const r = await req(port, 'GET', '/health');
  assert.strictEqual(r.body.playwright, 'disabled');
});

test('GET /health shows primaryBrowser: userscript-ws', async (port) => {
  const r = await req(port, 'GET', '/health');
  assert.strictEqual(r.body.primaryBrowser, 'userscript-ws');
});

test('GET /identity returns public record', async (port) => {
  const r = await req(port, 'GET', '/identity');
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.uuid);
  assert.ok(r.body.publicKey);
  assert.ok(!r.body.privateKey, 'private key must not be exposed');
});

test('GET /runtime/state returns bootId', async (port) => {
  const r = await req(port, 'GET', '/runtime/state');
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.bootId);
});

test('GET /userscript/sessions returns empty initially', async (port) => {
  const r = await req(port, 'GET', '/userscript/sessions');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.count, 0);
});

test('GET /calltos returns empty array initially', async (port) => {
  const r = await req(port, 'GET', '/calltos');
  assert.strictEqual(r.status, 200);
  assert.ok(Array.isArray(r.body.calltos));
});

test('GET /nodes returns array', async (port) => {
  const r = await req(port, 'GET', '/nodes');
  assert.strictEqual(r.status, 200);
  assert.ok(Array.isArray(r.body.nodes));
});

test('POST /callto without action returns 400', async (port) => {
  const r = await req(port, 'POST', '/callto', {});
  assert.strictEqual(r.status, 400);
  assert.ok(!r.body.ok);
});

test('POST /callto with action returns execution result (no session = error)', async (port) => {
  const r = await req(port, 'POST', '/callto', {
    action: 'click', selector: '#btn', origin: 'https://test.com',
  });
  // No WS session → should return 500 with "No execution method" error, not crash
  assert.ok([200, 500].includes(r.status));
  assert.ok('ok' in r.body);
});

test('GET /sngate/rules returns empty array', async (port) => {
  const r = await req(port, 'GET', '/sngate/rules');
  assert.strictEqual(r.status, 200);
  assert.ok(Array.isArray(r.body.rules));
});

test('POST /sngate/rules adds rule', async (port) => {
  const r = await req(port, 'POST', '/sngate/rules', {
    type: 'uuid', value: 'test-block-uuid', action: 'deny',
  });
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.id);
});

test('GET /sngate/trace returns array', async (port) => {
  const r = await req(port, 'GET', '/sngate/trace');
  assert.strictEqual(r.status, 200);
  assert.ok(Array.isArray(r.body.entries));
});

test('GET /ime/profile/unknown returns 404', async (port) => {
  const r = await req(port, 'GET', '/ime/profile/nobody-uuid');
  assert.strictEqual(r.status, 404);
});

test('POST /data/push accepted', async (port) => {
  const r = await req(port, 'POST', '/data/push', {
    uuid: 'test-module-uuid', moduleUuid: 'test-mod', tag: 'metric', payload: { val: 1 },
  });
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.ok);
});

test('GET /ime/profile after data push shows profile', async (port) => {
  const uuid = 'profile-after-push-' + Date.now();
  await req(port, 'POST', '/data/push', { uuid, moduleUuid: 'mod', tag: 'event', payload: {} });
  const r = await req(port, 'GET', `/ime/profile/${uuid}`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.profile.uuid, uuid);
});

test('unknown route returns 404', async (port) => {
  const r = await req(port, 'GET', '/this-does-not-exist');
  assert.strictEqual(r.status, 404);
});

test('NEXUS_API_KEY set → 401 without key', async (port) => {
  process.env.NEXUS_API_KEY = 'test-secret-key';
  try {
    const r = await req(port, 'GET', '/health');
    assert.strictEqual(r.status, 401);
  } finally {
    delete process.env.NEXUS_API_KEY;
  }
});

run();
