#!/usr/bin/env node
// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
'use strict';
/**
 * bridge-cli/nexus-cli.js  v2.1.0
 * Nexus Sovereign Node — Interactive CLI
 *
 * Features:
 *   Port auto-negotiation, LAN scan, DHT peer discovery
 *   Inbound node notifications (push to terminal while idle)
 *   module list/unload/reload
 *   Tab completion, color output, test suites
 *
 * Usage:
 *   node index.js --cli
 *   node bridge-cli/nexus-cli.js [--port N] [--host H] [--scan]
 *
 * Exports: startCLI, dispatch, negotiatePort, scanLAN, randomEphemeralPort, BLOCKED_PORTS
 */

const readline = require('readline');
const http     = require('http');
const crypto   = require('crypto');
const fs       = require('fs');
const path     = require('path');
const os       = require('os');

const modCausal = require('./mod-causal');
const modOllama = require('./mod-ollama');

const DATA_DIR  = path.join(__dirname, '../data');
const PORT_FILE = path.join(DATA_DIR, 'port.json');

// ── ANSI ──────────────────────────────────────────────────────────────────────
const C = {
  reset:'\x1b[0m', bold:'\x1b[1m', dim:'\x1b[2m',
  c:'\x1b[96m', g:'\x1b[92m', r:'\x1b[91m',
  y:'\x1b[93m', m:'\x1b[95m', w:'\x1b[97m', dg:'\x1b[2m',
};
const fx = {
  hdr: s=>`${C.bold}${C.c}${s}${C.reset}`,
  ok:  s=>`${C.g}${s}${C.reset}`,
  err: s=>`${C.r}${s}${C.reset}`,
  warn:s=>`${C.y}${s}${C.reset}`,
  dim: s=>`${C.dg}${s}${C.reset}`,
  val: s=>`${C.w}${s}${C.reset}`,
  key: s=>`${C.m}${s}${C.reset}`,
  cfr: s=>`${C.bold}${C.m}${s}${C.reset}`,
  ts:  s=>`${C.dg}[${new Date(s||Date.now()).toLocaleTimeString()}]${C.reset}`,
};

// ── Port helpers ──────────────────────────────────────────────────────────────
const BLOCKED_PORTS = new Set([
  20,21,22,23,25,53,67,68,69,80,110,119,123,143,161,162,179,194,389,443,445,465,
  514,515,587,631,636,993,995,1080,1194,1433,1521,1723,2049,2181,3306,3389,3747,
  4200,4444,5000,5432,5900,6379,6443,7777,8000,8080,8443,8888,9000,9090,9200,
  9300,11434,27017,27018,50051,
]);

function loadPersistedPort() {
  try {
    if (fs.existsSync(PORT_FILE)) {
      const d = JSON.parse(fs.readFileSync(PORT_FILE, 'utf8'));
      if (d.port && typeof d.port === 'number') return d.port;
    }
  } catch {}
  return null;
}

function persistPort(port) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(PORT_FILE, JSON.stringify({ port, savedAt: new Date().toISOString() }, null, 2));
  } catch {}
}

function randomEphemeralPort() {
  for (let i = 0; i < 500; i++) {
    const p = 49152 + Math.floor(Math.random() * (65535 - 49152));
    if (!BLOCKED_PORTS.has(p)) return p;
  }
  const h = crypto.createHash('sha256').update(os.hostname()).digest();
  const b = 49152 + (h.readUInt16BE(0) % (65535 - 49152));
  return BLOCKED_PORTS.has(b) ? b + 1 : b;
}

function getLANSubnets() {
  const s = [];
  for (const iface of Object.values(os.networkInterfaces()))
    for (const a of iface)
      if (a.family === 'IPv4' && !a.internal)
        s.push(a.address.split('.').slice(0, 3).join('.'));
  return [...new Set(s)];
}

// Get all real (non-loopback) IPv4 addresses on this machine
function getOwnIPs() {
  const ips = [];
  for (const addrs of Object.values(os.networkInterfaces()))
    for (const a of addrs)
      if (a.family === 'IPv4' && !a.internal) ips.push(a.address);
  return ips;
}

// Classify an IP's scope
function ipScope(ip) {
  if (/^127\./.test(ip)) return 'loopback';
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)) return 'lan';
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) return 'vpn';
  return 'public';
}

async function httpProbe(host, port, ms = 700) {
  return new Promise(res => {
    const req = http.get({ hostname: host, port, path: '/health', timeout: ms }, r => {
      const c = [];
      r.on('data', x => c.push(x));
      r.on('end', () => {
        try {
          const d = JSON.parse(Buffer.concat(c).toString());
          res(d.ok ? { host, port, uuid: d.uuid, version: d.version } : null);
        } catch { res(null); }
      });
    });
    req.on('error', () => res(null));
    req.on('timeout', () => { req.destroy(); res(null); });
  });
}

async function scanLAN(candidatePorts = [3747], verbose = false) {
  const subnets = getLANSubnets();
  if (verbose) console.log(fx.dim(`  Subnets: ${subnets.join(', ')}  ports: ${candidatePorts.join(', ')}`));
  const probes = [];
  for (const s of subnets)
    for (let h = 1; h <= 254; h++)
      for (const p of candidatePorts)
        probes.push(httpProbe(`${s}.${h}`, p, 600));
  for (const p of candidatePorts) {
    probes.push(httpProbe('127.0.0.1', p, 400));
  }
  const found = [];
  for (let i = 0; i < probes.length; i += 40) {
    const r = await Promise.all(probes.slice(i, i + 40));
    for (const x of r) if (x) found.push(x);
  }
  return found;
}

// Result: { port, host } — host is the real machine IP to connect to
async function negotiatePort(forced, verbose = true) {
  if (forced) {
    if (verbose) console.log(fx.dim(`  Port: ${forced} (forced)`));
    return { port: forced, host: getOwnIPs()[0] || '127.0.0.1' };
  }
  const p = loadPersistedPort();
  if (p) {
    if (verbose) console.log(fx.dim(`  Port: ${p} (from data/port.json)`));
    return { port: p, host: getOwnIPs()[0] || '127.0.0.1' };
  }
  if (verbose) process.stdout.write(fx.dim('  Scanning network… '));
  const found = await scanLAN([3747], false);

  // Separate self (this machine) from remote nodes
  const self    = found.filter(n => n.self);
  const remote  = found.filter(n => !n.self);

  if (verbose && found.length > 0) {
    console.log(fx.ok(`found ${found.length} node(s)`));
    for (const f of found) {
      const label = f.self ? fx.dim('(this machine)') : fx.ok('(remote)');
      console.log(`    ${fx.ok('●')} ${f.host}:${f.port}  ${f.scope}  uuid=${f.uuid?.slice(0,8)}  ${label}`);
    }
  }

  // Is our own node already running?
  const ownNode = self.find(n => n.port === 3747);
  if (ownNode) {
    // Use best non-loopback own IP so remote peers can also reach us
    const bestOwn = getOwnIPs()[0] || ownNode.host;
    if (verbose) console.log(fx.dim(`  Connecting to own node on ${bestOwn}:3747`));
    persistPort(3747);
    return { port: 3747, host: bestOwn };
  }

  // Port 3747 taken by a remote node? We need a different port.
  const remotePorts = new Set(remote.map(n => n.port));
  if (remotePorts.has(3747)) {
    let np; do { np = randomEphemeralPort(); } while (remotePorts.has(np));
    if (verbose) console.log(fx.warn(`  3747 in use on LAN — this node will use port ${np}`));
    persistPort(np);
    const bestOwn = getOwnIPs()[0] || '127.0.0.1';
    return { port: np, host: bestOwn };
  }

  // Nothing found — use 3747 on own best IP
  if (verbose) console.log(fx.dim('  No existing nodes found — starting on 3747'));
  persistPort(3747);
  return { port: 3747, host: getOwnIPs()[0] || '127.0.0.1' };
}

async function registerSelfToCFR(port, host) {
  // Use a deterministic UUID so the server's nodeRegistry stays UUID-keyed.
  // Derived from the machine+user string so it's stable across restarts.
  const rawId   = `cli-${os.hostname()}-${os.userInfo().username}`;
  const idHash  = crypto.createHash('sha256').update(rawId).digest('hex');
  const id      = idHash.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*/, '$1-$2-$3-$4-$5');
  const label   = `${os.hostname()} CLI`;
  await api('/cfr/node', 'POST', { id, label, type: 'cli', host: os.hostname(), port }, port, host).catch(() => null);
  await api('/pulse', 'POST', { instanceId: id, logicalId: label, capabilities: ['cli', 'mesh'], nodeCount: 0, fps: 0 }, port, host).catch(() => null);
  return id;
}

// ── HTTP helper ───────────────────────────────────────────────────────────────
function api(reqPath, method = 'GET', body = null, port = 3747, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req  = http.request({
      hostname: host, port, path: reqPath, method,
      headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) },
      timeout: 4000,
    }, res => {
      const c = [];
      res.on('data', x => c.push(x));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(c).toString()) }); }
        catch { resolve({ status: res.statusCode, data: Buffer.concat(c).toString() }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (data) req.write(data);
    req.end();
  });
}

// ── Display helpers ───────────────────────────────────────────────────────────
function printJSON(obj, indent = 0) {
  if (typeof obj !== 'object' || obj === null) { process.stdout.write(fx.val(String(obj))); return; }
  const pad = ' '.repeat(indent), pad2 = ' '.repeat(indent + 2);
  if (Array.isArray(obj)) {
    if (!obj.length) { process.stdout.write(fx.dim('[]')); return; }
    console.log('[');
    obj.forEach((v, i) => { process.stdout.write(pad2); printJSON(v, indent + 2); if (i < obj.length - 1) process.stdout.write(','); console.log(); });
    process.stdout.write(pad + ']'); return;
  }
  const keys = Object.keys(obj);
  if (!keys.length) { process.stdout.write(fx.dim('{}')); return; }
  console.log('{');
  keys.forEach((k, i) => {
    process.stdout.write(`${pad2}${fx.key(k)}: `);
    const v = obj[k];
    if (typeof v === 'boolean') process.stdout.write(v ? fx.ok('true') : fx.err('false'));
    else if (typeof v === 'number') process.stdout.write(fx.val(String(v)));
    else if (typeof v === 'string') process.stdout.write(`"${fx.val(v)}"`);
    else printJSON(v, indent + 2);
    if (i < keys.length - 1) process.stdout.write(','); console.log();
  });
  process.stdout.write(pad + '}');
}

function table(rows, cols) {
  if (!rows || !rows.length) { console.log(fx.dim('  (empty)')); return; }
  const widths = cols.map(c => Math.max(c.length, ...rows.map(r => String(r[c] ?? '').length)));
  const hr = '+' + widths.map(w => '-'.repeat(w + 2)).join('+') + '+';
  console.log(fx.dim(hr));
  console.log('|' + cols.map((c, i) => ` ${fx.hdr(c.padEnd(widths[i]))} `).join('|') + '|');
  console.log(fx.dim(hr));
  for (const row of rows) {
    console.log('|' + cols.map((c, i) => {
      const v = String(row[c] ?? '').slice(0, 50).padEnd(widths[i]);
      const col = row[c] === true ? fx.ok(v) : row[c] === false ? fx.err(v) : fx.val(v);
      return ` ${col} `;
    }).join('|') + '|');
  }
  console.log(fx.dim(hr));
}

function section(t) { console.log(`\n${fx.hdr('══')} ${fx.cfr(t)} ${fx.hdr('══')}`); }

// ── Inbound node notification ──────────────────────────────────────────────────
// Polls /nodes every 8s. When a new node appears, prints a notification line
// above the prompt without interrupting what the user is typing.
function startNodeWatcher(port, host, rl) {
  const known = new Set();
  let initialized = false;

  const poll = async () => {
    try {
      const r = await api('/nodes', 'GET', null, port, host);
      const nodes = r.data?.nodes || [];
      for (const n of nodes) {
        const id = n.uuid || n.instanceId;
        if (!id) continue;
        if (!known.has(id)) {
          known.add(id);
          if (initialized) {
            // Print notification above current prompt line
            const msg = `\n  ${C.g}◆${C.reset}  ${C.bold}Inbound node${C.reset}  ${C.c}${id.slice(0,8)}${C.reset}  ${C.dg}${n.address || n.logicalId || ''}${C.reset}\n`;
            process.stdout.write('\r\x1b[K'); // clear current line
            process.stdout.write(msg);
            rl?.prompt(true);
          }
        }
      }
      // Also check for mesh:peer:connected events via deltas
      if (initialized) {
        const d = await api('/cfr/deltas?limit=5', 'GET', null, port, host);
        for (const delta of d.data?.deltas || []) {
          if (delta.type === 'mesh:peer:connected' && !known.has('evt:'+delta.id)) {
            known.add('evt:'+delta.id);
            const msg = `\n  ${C.g}◆${C.reset}  ${C.bold}Peer connected${C.reset}  ${C.dg}${delta.msg || ''}${C.reset}\n`;
            process.stdout.write('\r\x1b[K');
            process.stdout.write(msg);
            rl?.prompt(true);
          }
        }
      }
      initialized = true;
    } catch {}
  };

  poll();
  return setInterval(poll, 8_000);
}

// ── Test suites ────────────────────────────────────────────────────────────────
async function runTestSuite(name, port, host) {
  const results = [];
  const test = async (label, fn) => {
    const t0 = Date.now();
    try {
      const res = await fn();
      const ms  = Date.now() - t0;
      results.push({ test: label, status: 'PASS', result: String(res || 'ok').slice(0, 60), ms });
      console.log(`  ${fx.ok('✓')} ${label} ${fx.dim(`(${ms}ms)`)}`);
    } catch (e) {
      const ms = Date.now() - t0;
      results.push({ test: label, status: 'FAIL', result: e.message.slice(0, 60), ms });
      console.log(`  ${fx.err('✗')} ${label} ${fx.dim(`(${ms}ms)`)} — ${fx.err(e.message.slice(0, 80))}`);
    }
  };
  const get  = async p   => { const r = await api(p, 'GET', null, port, host); if (r.status >= 400) throw new Error(`HTTP ${r.status}`); return r.data; };
  const post = async (p, b) => { const r = await api(p, 'POST', b, port, host); if (r.status >= 400) throw new Error(`HTTP ${r.status}`); return r.data; };

  const suites = {
    health: async () => {
      section('Health Tests');
      await test('GET /health ok', async () => { const d = await get('/health'); if (!d.ok) throw new Error('not ok'); return `up=${d.uptime?.toFixed(1)}s`; });
      await test('UUID present',   async () => { const d = await get('/health'); if (!d.uuid) throw new Error('no uuid'); return d.uuid.slice(0,8); });
      await test('Causal block',   async () => { const d = await get('/health'); if (!d.causal) throw new Error('no causal'); return 'ok'; });
      await test('Trust block',    async () => { const d = await get('/health'); if (!d.trust) throw new Error('no trust'); return 'ok'; });
      await test('GET /identity',  async () => { const d = await get('/identity'); if (!d.uuid) throw new Error('no uuid'); return d.uuid.slice(0,8); });
      await test('GET /nodes',     async () => { const d = await get('/nodes'); if (!Array.isArray(d.nodes)) throw new Error('not array'); return `${d.nodes.length} nodes`; });
      await test('GET /calltos',   async () => { const d = await get('/calltos'); if (!Array.isArray(d.calltos)) throw new Error('not array'); return `${d.calltos.length}`; });
    },
    cfr: async () => {
      section('CFR Tests');
      await test('GET /cfr/health',   async () => { const d = await get('/cfr/health'); if (!d.ok||!d.installed) throw new Error(`ok=${d.ok} inst=${d.installed}`); return `nodes=${d.nodes}`; });
      await test('GET /cfr/nodes',    async () => { const d = await get('/cfr/nodes'); if (!Array.isArray(d.nodes)) throw new Error('not array'); return `${d.nodes.length}`; });
      await test('GET /cfr/field',    async () => { const d = await get('/cfr/field'); if (!d.field) throw new Error('no field'); return `struct=${d.field.structure?.toFixed(2)}`; });
      await test('POST /cfr/emit',    async () => { const d = await post('/cfr/emit', { sig:'test:cli', data:{from:'cli'} }); if (!d.ok) throw new Error('not ok'); return `ts=${d.ts}`; });
      await test('Emit sig guard',    async () => { const r = await api('/cfr/emit','POST',{data:{}},port,host); if (r.data?.ok) throw new Error('should fail'); return 'guard OK'; });
    },
    sngate: async () => {
      section('SNR Gate Tests');
      await test('GET /sngate/rules', async () => { const d = await get('/sngate/rules'); return `${d.rules?.length||0} rules`; });
      await test('GET /sngate/trace', async () => { const d = await get('/sngate/trace'); return `${d.entries?.length||0} entries`; });
    },
    causal: async () => {
      section('Causal Tests');
      await test('GET /causal/stats',    async () => { const d = await get('/causal/stats'); return `events=${d.eventCount??'?'}`; });
      await test('GET /causal/classify', async () => { const d = await get('/causal/classify'); return `regime=${d.regime}`; });
      await test('POST /causal/query',   async () => { const d = await post('/causal/query', { cql:'LAST 5' }); return `${Array.isArray(d.events)?d.events.length:'?'} events`; });
    },
    trust: async () => {
      section('Trust Tests');
      await test('GET /trust/stats', async () => { const d = await get('/trust/stats'); if (!d.ok) throw new Error('not ok'); return `peers=${d.peerCount??0}`; });
    },
    dht: async () => {
      section('DHT Tests');
      await test('GET /dht/stats',       async () => { const d = await get('/dht/stats'); if (!d.ok) throw new Error('not ok'); return `table=${d.table?.size}`; });
      await test('GET /dht/peers',       async () => { const d = await get('/dht/peers'); if (!Array.isArray(d.peers)) throw new Error('not array'); return `${d.peers.length}`; });
      await test('POST /dht/find guard', async () => { const r = await api('/dht/find','POST',{},port,host); if (r.data?.ok) throw new Error('should fail'); return 'guard OK'; });
    },
  };

  const run = suites[name];
  if (!run) { console.log(fx.err(`Unknown suite: ${name}`)); console.log(`Available: ${Object.keys(suites).join(', ')}, all`); return; }
  const t0 = Date.now();
  await run();
  const total = Date.now() - t0;
  const pass = results.filter(r => r.status === 'PASS').length;
  const fail = results.filter(r => r.status === 'FAIL').length;
  section(`Results: ${pass}/${results.length} passed (${total}ms)`);
  if (fail) console.log(fx.err(`  ${fail} failed`)); else console.log(fx.ok('  All passed'));
  return results;
}

// ── Command dispatch ──────────────────────────────────────────────────────────
async function dispatch(line, opts) {
  const { port, host } = opts;
  const parts = line.trim().split(/\s+/);
  const cmd   = parts[0]?.toLowerCase();
  const args  = parts.slice(1);

  try { switch (cmd) {

    case 'help': case '?': {
      section('Nexus CLI  v2.1');
      const cmds = [
        ['status',                     'Full system health'],
        ['identity',                   'Node public record'],
        ['nodes',                      'Registered nodes'],
        ['trust [uuid]',               'Trust mesh stats / peer score'],
        ['ime <uuid>',                 'IME behavioral profile'],
        ['sngate trace',               'Recent SNR gate decisions'],
        ['sngate rules',               'Active rules'],
        ['sngate add <json>',          'Add a gate rule'],
        ['causal stats|classify',      'Causal kernel state'],
        ['causal query <cql>',         'CQL query'],
        ['causal log <msg>',           'Append to local causal log'],
        ['causal recent [n]',          'Show local causal log'],
        ['cfr nodes',                  'Canvas nodes'],
        ['cfr field [set <k> <v>]',   'Field state / override'],
        ['cfr deltas [n]',             'Last N deltas'],
        ['cfr simulate <type>',        'Inject simulation event'],
        ['cfr register',               'Re-register CLI to CFR canvas'],
        ['emit <sig> [json]',          'Emit bus event'],
        ['pulse [id]',                 'Register a CFR node'],
        ['calltos',                    'Callto registry'],
        ['mesh scan',                  'LAN scan for sovereign nodes'],
        ['mesh peers',                 'Mesh peer list'],
        ['mesh dht',                   'DHT routing table'],
        ['mesh announce <host> <port>','Announce self to peer'],
        ['dht peers|find <uuid>|stats','DHT operations'],
        ['module list',                'All loaded modules'],
        ['module <name>',              'Module diagnostics'],
        ['module <name> unload',       'Unload a non-vital module'],
        ['module <name> reload',       'Reload a module'],
        ['port [set N]',               'Show / override port'],
        ['ollama <prompt>',            'Query local Ollama LLM'],
        ['guardian status',            'Connected Guardian instances'],
        ['guardian appid create|list', 'Guardian AppID management'],
        ['ble status',                 'BLE adapter + peripheral + subscriber state'],
        ['ble scan [ms]',              'Scan for Bridge BLE nodes'],
        ['ble discovered',             'List discovered BLE nodes'],
        ['ble connect <shortId>',      'Connect to a BLE peer'],
        ['ble disconnect <shortId>',   'Disconnect from a BLE peer'],
        ['ble send <shortId> <msg>',   'Send message over BLE'],
        ['ble peers',                  'Currently connected BLE peers'],
        ['ble advertise [name]',       'Start advertising (peripheral mode, internal BT)'],
        ['ble stop-advertise',         'Stop advertising'],
        ['ble notify <msg>',           'Push message to all subscribed centrals'],
        ['mobile status',              'Mobile/Pi runtime status'],
        ['mobile power',               'Power budget + battery level'],
        ['mobile checkpoint',          'Force state checkpoint to disk'],
        ['mobile sync',                'Force an immediate sync cycle'],
        ['test health|cfr|sngate|causal|trust|dht|all', 'Run test suites'],
        ['bench <n>',                  'Throughput benchmark'],
        ['watch [sig]',                'Tail bus events live'],
        ['clear',                      'Clear screen'],
        ['exit|quit',                  'Exit'],
      ];
      table(cmds.map(([c,d]) => ({ command:c, description:d })), ['command','description']);
      break;
    }

    case 'status': {
      const r = await api('/health', 'GET', null, port, host);
      const d = r.data;
      section('System Status');
      console.log(`  ${fx.key('UUID')}      ${fx.val(d.uuid||'?')}`);
      console.log(`  ${fx.key('ShortID')}   ${fx.val(d.shortId||d.uuid?.slice(0,8)||'?')}`);
      console.log(`  ${fx.key('Port')}      ${fx.val(port)}`);
      console.log(`  ${fx.key('Uptime')}    ${fx.val((d.uptime||0).toFixed(1)+'s')}`);
      console.log(`  ${fx.key('Version')}   ${fx.val(d.version||'?')}`);
      console.log(`  ${fx.key('Causal')}    events=${fx.val(d.causal?.eventCount??'?')} ring=${fx.val(d.causal?.ringLen??'?')}`);
      console.log(`  ${fx.key('Trust')}     peers=${fx.val(d.trust?.peerCount??0)} mean=${fx.val(d.trust?.meanScore?.toFixed(3)??'n/a')}`);
      console.log(`  ${fx.key('CLI self')}  ${fx.val(opts.selfInstanceId||'not registered')}`);
      break;
    }

    case 'identity': {
      const r = await api('/identity', 'GET', null, port, host);
      section('Identity'); printJSON(r.data); console.log();
      break;
    }

    case 'nodes': {
      const r = await api('/nodes', 'GET', null, port, host);
      section(`Nodes (${(r.data.nodes||[]).length})`);
      table(r.data.nodes||[], ['uuid','address','lifecycle','trustScore','missedBeats']);
      break;
    }

    case 'trust': {
      if (args[0]) {
        const r = await api(`/trust/score/${args[0]}`, 'GET', null, port, host);
        section(`Trust: ${args[0].slice(0,12)}`); printJSON(r.data); console.log();
      } else {
        const r = await api('/trust/stats', 'GET', null, port, host);
        section('Trust Mesh'); printJSON(r.data); console.log();
      }
      break;
    }

    case 'ime': {
      if (!args[0]) { console.log(fx.err('ime <uuid>')); break; }
      const r = await api(`/ime/profile/${args[0]}`, 'GET', null, port, host);
      section(`IME: ${args[0].slice(0,12)}`); printJSON(r.data); console.log();
      break;
    }

    case 'sngate': {
      const sub = args[0];
      if (sub === 'trace') {
        const r = await api('/sngate/trace', 'GET', null, port, host);
        section('SNR Trace');
        table((r.data.entries||[]).slice(-20), ['ts','type','decision','surface','score']);
      } else if (sub === 'rules') {
        const r = await api('/sngate/rules', 'GET', null, port, host);
        section('SNR Rules');
        table(r.data.rules||[], ['id','type','value','action','surface']);
      } else if (sub === 'add') {
        const json = args.slice(1).join(' ');
        let rule;
        try { rule = JSON.parse(json); } catch { console.log(fx.err(`Bad JSON: ${json}`)); break; }
        const r = await api('/sngate/rules', 'POST', rule, port, host);
        console.log(r.data.ok ? fx.ok(`Added: ${r.data.id}`) : fx.err(r.data.error));
      } else {
        console.log(fx.err('sngate <trace|rules|add <json>>'));
      }
      break;
    }

    case 'causal': {
      const sub = args[0];
      if (sub === 'stats') {
        const r = await api('/causal/stats', 'GET', null, port, host);
        section('Causal Stats'); printJSON(r.data); console.log();
      } else if (sub === 'classify') {
        const r = await api('/causal/classify', 'GET', null, port, host);
        section('Causal Regime');
        console.log(`  regime: ${fx.cfr(r.data.regime)} — ${fx.val(r.data.reason||'')}`);
      } else if (sub === 'query') {
        const cql = args.slice(1).join(' ');
        if (!cql) { console.log(fx.err('causal query <CQL>')); break; }
        const r = await api('/causal/query', 'POST', { cql }, port, host);
        section(`Query: ${cql}`);
        console.log(`  total=${r.data.total}  dur=${r.data.durationMs}ms`);
        table((r.data.events||[]).slice(0,20), ['eventTs','type','edgeType','payload']);
      } else if (sub === 'log') {
        const msg = args.slice(1).join(' ');
        if (!msg) { console.log(fx.err('causal log <message>')); break; }
        const e = modCausal.log('command', msg, `cli@${host}:${port}`);
        console.log(fx.ok(`Logged: ${e.id}  ${fx.dim(e.timestamp)}`));
      } else if (sub === 'recent') {
        const limit = parseInt(args[1]) || 10;
        const entries = modCausal.getRecent(limit);
        section(`Local Causal Log (last ${limit})`);
        if (!entries.length) { console.log(fx.dim('  (empty)')); break; }
        table(entries, ['id','timestamp','type','author','content']);
      } else {
        console.log(fx.err('causal <stats|classify|query <cql>|log <msg>|recent [n]>'));
      }
      break;
    }

    case 'cfr': {
      const sub = args[0];
      if (sub === 'nodes') {
        const r = await api('/cfr/nodes', 'GET', null, port, host);
        section(`CFR Nodes (${(r.data.nodes||[]).length})`);
        table(r.data.nodes||[], ['id','label','type','updatedAt']);
      } else if (sub === 'field') {
        if (args[1] === 'set' && args[2] && args[3]) {
          const r = await api('/cfr/field', 'POST', { [args[2]]: parseFloat(args[3]) }, port, host);
          console.log(r.data.ok ? fx.ok(`${args[2]} = ${args[3]}`) : fx.err(r.data.error));
        } else {
          const r = await api('/cfr/field', 'GET', null, port, host);
          section('CFR Field');
          const f = r.data.field || {};
          for (const [k, v] of Object.entries(f))
            console.log(`  ${fx.key(k.padEnd(14))} ${fx.val(typeof v==='number' ? v.toFixed(4) : JSON.stringify(v))}`);
        }
      } else if (sub === 'deltas') {
        const limit = parseInt(args[1]) || 20;
        const r = await api(`/cfr/deltas?limit=${limit}`, 'GET', null, port, host);
        section(`CFR Deltas (${(r.data.deltas||[]).length}/${r.data.total})`);
        for (const d of r.data.deltas||[]) {
          const fn = { ok:fx.ok, warn:fx.warn, err:fx.err, cfr:fx.cfr }[d.cls] || fx.val;
          console.log(`  ${fx.ts(d.ts)} ${fn((d.cls||'?').padEnd(4))} ${fx.key((d.type||'').padEnd(32))} ${fx.dim(d.msg||'')}`);
        }
      } else if (sub === 'state') {
        const r = await api('/cfr/state', 'GET', null, port, host);
        section('CFR State'); printJSON(r.data.state); console.log();
      } else if (sub === 'simulate') {
        const type = args[1], fromId = args[2], toId = args[3];
        if (!type) { console.log(fx.err('cfr simulate <route|failure|heal|broadcast|cascade|snr_block> [from] [to]')); break; }
        const r = await api('/cfr/simulate', 'POST', { type, fromId, toId, intensity: 5 }, port, host);
        console.log(r.data.ok ? fx.ok(`Simulated: ${type}`) : fx.err(r.data.error));
      } else if (sub === 'register') {
        const id = await registerSelfToCFR(port, host);
        console.log(fx.ok(`Registered: ${id}`));
        opts.selfInstanceId = id;
      } else {
        console.log(fx.err('cfr <nodes|field [set k v]|deltas [n]|state|simulate <type>|register>'));
      }
      break;
    }

    case 'emit': {
      const sig = args[0];
      if (!sig) { console.log(fx.err('emit <sig> [json]')); break; }
      let data = {};
      if (args[1]) { try { data = JSON.parse(args.slice(1).join(' ')); } catch { data = { raw: args.slice(1).join(' ') }; } }
      const r = await api('/cfr/emit', 'POST', { sig, data }, port, host);
      console.log(r.data?.ok ? fx.ok(`Emitted: ${sig}`) : fx.err(r.data?.error||'failed'));
      break;
    }

    case 'pulse': {
      const id = args[0] || `cli-${crypto.randomBytes(4).toString('hex')}`;
      const r  = await api('/pulse', 'POST', { instanceId: id, logicalId: 'cli-probe', capabilities: ['cli'], nodeCount: 0, fps: 0 }, port, host);
      console.log(r.data?.ok ? fx.ok(`Pulsed: ${id} → uuid=${r.data.uuid?.slice(0,8)}`) : fx.err(r.data?.error||'failed'));
      break;
    }

    case 'calltos': {
      const r = await api('/calltos', 'GET', null, port, host);
      section(`Calltos (${(r.data.calltos||[]).length})`);
      table(r.data.calltos||[], ['action','selector','origin','tag']);
      break;
    }

    case 'mesh': {
      const sub = args[0];
      if (sub === 'scan') {
        section('LAN Scan');
        const portList = [...new Set([port, 3747])];
        console.log(fx.dim(`  Probing ports: ${portList.join(', ')}  (may take ~10s)…`));
        const found = await scanLAN(portList, true);
        if (!found.length) console.log(fx.dim('  No nodes found'));
        else table(found, ['host','port','uuid','version']);
      } else if (sub === 'peers') {
        const r = await api('/mesh/peers', 'GET', null, port, host);
        section('Mesh Peers'); printJSON(r.data); console.log();
      } else if (sub === 'dht') {
        const r = await api('/dht/peers', 'GET', null, port, host);
        section(`DHT Routing Table (${(r.data.peers||[]).length})`);
        table(r.data.peers||[], ['uuid','address','ts']);
      } else if (sub === 'announce') {
        const ph = args[1], pp = parseInt(args[2]);
        if (!ph || !pp) { console.log(fx.err('mesh announce <host> <port>')); break; }
        const id = await api('/identity','GET',null,port,host).then(r=>r.data?.uuid).catch(()=>`cli-${crypto.randomBytes(4).toString('hex')}`);
        await api('/dht/store','POST',{record:{uuid:id,address:`http://${host}:${port}`,publicKey:'cli-probe',ts:Date.now(),sig:'cli-announce'}},pp,ph).catch(()=>null);
        console.log(fx.ok(`Announced ${host}:${port} to ${ph}:${pp}`));
      } else {
        console.log(fx.err('mesh <scan|peers|dht|announce <host> <port>>'));
      }
      break;
    }

    case 'dht': {
      const sub = args[0];
      if (sub === 'peers') {
        const r = await api('/dht/peers', 'GET', null, port, host);
        section(`DHT Peers (${(r.data.peers||[]).length})`);
        table(r.data.peers||[], ['uuid','address','ts']);
      } else if (sub === 'find') {
        if (!args[1]) { console.log(fx.err('dht find <uuid>')); break; }
        const r = await api('/dht/find', 'POST', { target: args[1], k: 8 }, port, host);
        section(`Find: ${args[1].slice(0,12)}`);
        table(r.data.nodes||[], ['uuid','address','ts']);
      } else if (sub === 'stats') {
        const r = await api('/dht/stats', 'GET', null, port, host);
        section('DHT Stats'); printJSON(r.data); console.log();
      } else {
        console.log(fx.err('dht <peers|find <uuid>|stats>'));
      }
      break;
    }

    case 'module': {
      const name = args[0], action = args[1];
      if (!name || name === 'list') {
        const r = await api('/module/list', 'GET', null, port, host);
        section('Modules');
        if (r.data?.modules) {
          table(r.data.modules.map(m => ({
            name:    m.name,
            status:  m.status,
            vital:   m.vital ? 'yes' : 'no',
            uptime:  (m.uptime||0)+'s',
            version: m.version||'?',
          })), ['name','status','vital','uptime','version']);
        } else {
          console.log(fx.warn('  Module registry not available'));
        }
      } else if (!action) {
        const r = await api(`/module/${name}`, 'GET', null, port, host);
        section(`Module: ${name}`); printJSON(r.data); console.log();
      } else if (action === 'unload') {
        const r = await api(`/module/${name}/unload`, 'POST', { reason: 'cli:unload' }, port, host);
        console.log(r.data?.ok ? fx.ok(`Unloaded: ${name}`) : fx.err(r.data?.error||'failed'));
      } else if (action === 'reload') {
        const r = await api(`/module/${name}/reload`, 'POST', {}, port, host);
        console.log(r.data?.ok ? fx.ok(`Reloaded: ${name}`) : fx.err(r.data?.error||'failed'));
      } else {
        console.log(fx.err('module <list|<name>|<name> unload|<name> reload>'));
      }
      break;
    }

    case 'port': {
      if (args[0] === 'set' && args[1]) {
        const p = parseInt(args[1]);
        if (isNaN(p) || p < 1024 || p > 65535) { console.log(fx.err('Port must be 1024–65535')); break; }
        if (BLOCKED_PORTS.has(p)) console.log(fx.warn(`  ⚠ port ${p} is on the blocked list`));
        persistPort(p); opts.port = p;
        console.log(fx.ok(`Port set to ${p} — restart server to apply`));
      } else {
        section('Port Status');
        console.log(`  ${fx.key('Current')}  ${fx.val(port)}`);
        console.log(`  ${fx.key('File')}     ${fx.val(PORT_FILE)}`);
        const found = await scanLAN([port, 3747], false);
        console.log(`  ${fx.key('LAN')}      ${fx.val(found.length+' node(s) found')}`);
        for (const n of found) console.log(`    ${fx.ok('●')} ${n.host}:${n.port} uuid=${n.uuid?.slice(0,8)}`);
        const collision = found.some(n => n.port === port && n.host !== 'localhost' && n.host !== '127.0.0.1');
        if (collision) { console.log(fx.warn(`  ⚠ COLLISION on port ${port}`)); console.log(fx.warn(`  Suggested: port set ${randomEphemeralPort()}`)); }
      }
      break;
    }

    case 'ollama': {
      const prompt = args.join(' ');
      if (!prompt) { console.log(fx.err('ollama <prompt>')); break; }
      section('Ollama');
      console.log(fx.dim('  Querying… (may take a moment)'));
      try {
        const res = await modOllama.query(prompt);
        if (res.response) {
          console.log('\n' + fx.val(res.response) + '\n');
          console.log(fx.dim(`  model: ${res.model}  tokens: ${res.eval_count??'?'}  time: ${((res.total_duration||0)/1e9).toFixed(1)}s`));
          modCausal.log('chat', `ollama: ${prompt.slice(0,80)}`, `cli@${host}:${port}`);
        } else { console.log(fx.err('No response')); printJSON(res); console.log(); }
      } catch (e) {
        console.log(fx.err(`Ollama error: ${e.message}`));
        console.log(fx.dim('  Is Ollama running?  ollama serve'));
      }
      break;
    }

    case 'guardian': {
      const sub = args[0];
      if (!sub || sub === 'status') {
        const r = await api('/guardian/status', 'GET', null, port, host);
        section('Guardian');
        if (!r.data?.sessions?.length) { console.log(fx.dim('  None connected')); }
        else r.data.sessions.forEach(s => console.log(`  ${s.healthy ? fx.ok('● LIVE') : fx.warn('○ STALE')}  ${fx.val(s.instanceId?.slice(0,16))}…  ${Math.round((s.lastSeenMs||0)/1000)}s ago`));
      } else if (sub === 'appid') {
        const action = args[1];
        if (!action || action === 'list') {
          const r = await api('/guardian/appid/list', 'GET', null, port, host);
          section('Guardian AppIDs');
          (r.data?.appids||[]).forEach(a => {
            const c = a.status==='available'?fx.ok : a.status==='used'?fx.dim : fx.err;
            console.log(`  ${c(a.status.padEnd(10))}  ${fx.key(a.appId)}`);
          });
        } else if (action === 'create') {
          const label = args.slice(2).join(' ') || 'guardian-instance';
          const r = await api('/guardian/appid/create', 'POST', { label }, port, host);
          section('New AppID');
          if (r.data?.ok) console.log(`  ${fx.ok('AppID:')} ${fx.val(r.data.appId)}`);
          else console.log(fx.err('  Failed: ' + JSON.stringify(r.data)));
        }
      }
      break;
    }

    case 'test': {
      const suite = args[0] || 'health';
      if (suite === 'all') { for (const s of ['health','cfr','sngate','causal','trust','dht']) await runTestSuite(s, port, host); }
      else await runTestSuite(suite, port, host);
      break;
    }

    case 'bench': {
      const n = parseInt(args[0]) || 100;
      section(`Bench: ${n} events`);
      const t0 = Date.now();
      await Promise.all([...Array(n)].map((_, i) => api('/cfr/emit', 'POST', { sig:`bench:${i}`, data:{i} }, port, host)));
      const ms = Date.now() - t0;
      console.log(`  ${n} events in ${fx.val(ms+'ms')} = ${fx.val((n/(ms/1000)).toFixed(0))} ev/s`);
      break;
    }

    case 'watch': {
      const sigFilter = args[0] || null;
      section(`Watch${sigFilter ? ` (${sigFilter})` : ' (all)'}… Ctrl+C or any key to stop`);
      const seen = new Set();
      const poll = setInterval(async () => {
        try {
          const r = await api('/cfr/deltas?limit=50', 'GET', null, port, host);
          for (const d of r.data.deltas||[]) {
            if (seen.has(d.id)) continue;
            seen.add(d.id);
            if (sigFilter && !d.type.includes(sigFilter)) continue;
            const fn = { ok:fx.ok, warn:fx.warn, err:fx.err, cfr:fx.cfr }[d.cls] || fx.val;
            console.log(`${fx.ts(d.ts)} ${fn((d.cls||'?').padEnd(4))} ${fx.key((d.type||'').padEnd(36))} ${fx.dim(d.msg||'')}`);
          }
        } catch {}
      }, 500);
      opts._watching = poll;
      return;
    }

    case 'ble': {
      const sub = args[0];
      if (!sub || sub === 'status') {
        const r = await api('/transport/stats', 'GET', null, port, host);
        section('BLE Status');
        const ble = (r.data?.adapters || []).find(a => a.type === 'ble');
        if (!ble) { console.log(fx.warn('  BLE adapter not loaded — check transport module')); break; }
        console.log(`  ${fx.key('Backend')}    ${fx.val(ble.backend || ble.state || '?')}`);
        console.log(`  ${fx.key('State')}      ${ble.state === 'ready' ? fx.ok(ble.state) : fx.warn(ble.state || '?')}`);
        console.log(`  ${fx.key('Available')}  ${ble.available ? fx.ok('yes') : fx.err('no')}`);
        console.log(`  ${fx.key('Scanning')}   ${fx.val(String(ble.scanning || false))}`);
        console.log(`  ${fx.key('Advertising')} ${ble.advertising ? fx.ok('yes') : fx.dim('no')}`);
        console.log(`  ${fx.key('Peripheral')}  ${ble.hasPeripheral ? fx.ok('supported') : fx.warn('not supported by adapter')}`);
        if (ble.localAddress) console.log(`  ${fx.key('My address')}  ${fx.val(ble.localAddress)}`);
        console.log(`  ${fx.key('Subscribers')} ${fx.val(String(ble.subscribers || 0))} (centrals subscribed to us)`);
        console.log(`  ${fx.key('Peers')}      ${fx.val(String((ble.peers || []).length))} (we connected to these)`);
        if ((ble.stats || ble).sent !== undefined) {
          const s = ble.stats || ble;
          console.log(`  ${fx.key('Sent')}       ${fx.val(s.sent)} msgs  ${fx.val(s.bytesOut || 0)} bytes`);
          console.log(`  ${fx.key('Received')}   ${fx.val(s.received)} msgs  ${fx.val(s.bytesIn || 0)} bytes`);
        }
        if (ble.peers?.length) {
          console.log('');
          table(ble.peers, ['shortId','state','mtu']);
        }
      } else if (sub === 'scan') {
        const ms = parseInt(args[1]) || 10000;
        console.log(fx.dim(`  Scanning for Bridge BLE nodes for ${ms}ms…`));
        const r = await api('/ble/scan', 'POST', { durationMs: ms }, port, host);
        console.log(r.data?.ok ? fx.ok('  Scan started') : fx.err(r.data?.reason || 'scan failed'));
        console.log(fx.dim('  Run: ble discovered  to see results'));
      } else if (sub === 'discovered') {
        const r = await api('/ble/discovered', 'GET', null, port, host);
        section(`BLE Discovered (${(r.data?.nodes||[]).length})`);
        if (!(r.data?.nodes||[]).length) { console.log(fx.dim('  None — run: ble scan')); break; }
        table(r.data.nodes, ['shortId','rssi','address','name']);
      } else if (sub === 'peers') {
        const r = await api('/ble/peers', 'GET', null, port, host);
        section(`BLE Peers (${(r.data?.peers||[]).length})`);
        if (!(r.data?.peers||[]).length) { console.log(fx.dim('  None connected')); break; }
        table(r.data.peers, ['shortId','state','mtu']);
      } else if (sub === 'connect') {
        if (!args[1]) { console.log(fx.err('ble connect <shortId>')); break; }
        const r = await api('/ble/connect', 'POST', { shortId: args[1] }, port, host);
        console.log(r.data?.ok ? fx.ok(`Connecting to ${args[1]}…`) : fx.err(r.data?.reason || 'failed'));
      } else if (sub === 'disconnect') {
        if (!args[1]) { console.log(fx.err('ble disconnect <shortId>')); break; }
        const r = await api('/ble/disconnect', 'POST', { shortId: args[1] }, port, host);
        console.log(r.data?.ok ? fx.ok(`Disconnected: ${args[1]}`) : fx.err(r.data?.reason || 'failed'));
      } else if (sub === 'send') {
        if (!args[1] || !args[2]) { console.log(fx.err('ble send <shortId> <message>')); break; }
        const msg = args.slice(2).join(' ');
        const r   = await api('/ble/send', 'POST', { shortId: args[1], message: msg }, port, host);
        console.log(r.data?.ok ? fx.ok(`Sent to ${args[1]}: ${msg.slice(0,40)}`) : fx.err(r.data?.reason || 'failed'));
      } else if (sub === 'advertise') {
        const name = args[1] || null;
        const r    = await api('/ble/advertise', 'POST', { localName: name }, port, host);
        console.log(r.data?.ok ? fx.ok(`Advertising${name ? ' as '+name : ''}`) : fx.err(r.data?.reason || 'failed'));
      } else if (sub === 'stop-advertise') {
        const r = await api('/ble/stop-advertise', 'POST', {}, port, host);
        console.log(r.data?.ok ? fx.ok('Advertising stopped') : fx.err(r.data?.reason || 'failed'));
      } else if (sub === 'notify') {
        if (!args[1]) { console.log(fx.err('ble notify <message>')); break; }
        const msg = args.slice(1).join(' ');
        const r   = await api('/ble/notify', 'POST', { message: msg }, port, host);
        console.log(r.data?.ok ? fx.ok(`Notified ${r.data.recipients || 0} central(s)`) : fx.err(r.data?.reason || 'failed'));
      } else {
        console.log(fx.err('ble <status|scan [ms]|discovered|peers|connect <id>|disconnect <id>|send <id> <msg>|advertise [name]|stop-advertise|notify <msg>>'));
      }
      break;
    }

    case 'mobile': {
      const sub = args[0];
      if (!sub || sub === 'status') {
        const r = await api('/mobile/status', 'GET', null, port, host);
        section('Mobile / Hardware Status');
        if (r.status >= 400) { console.log(fx.warn('  Mobile runtime not loaded')); break; }
        const d = r.data;
        console.log(`  ${fx.key('Platform')}   ${fx.val(d.platform || '?')}`);
        console.log(`  ${fx.key('Uptime')}     ${fx.val(Math.round((d.uptime||0)/1000)+'s')}`);
        console.log(`  ${fx.key('Syncs')}      ${fx.val(String(d.syncs||0))}`);
        console.log(`  ${fx.key('Watchdog')}   ${d.watchdog?.active ? fx.ok('active') : fx.dim('inactive')}  fed=${fx.val(String(d.watchdog?.fed||0))}`);
        if (d.power) {
          console.log(`  ${fx.key('Battery')}    ${fx.val(d.power.battery+'%')}  ${d.power.charging ? fx.ok('charging') : fx.dim('on battery')}`);
          console.log(`  ${fx.key('Profile')}    ${fx.val(d.power.profile||'?')}`);
          console.log(`  ${fx.key('Sync rate')} ${fx.val(d.power.syncInterval ? d.power.syncInterval/1000+'s' : 'suspended')}`);
        }
      } else if (sub === 'power') {
        const r = await api('/mobile/power', 'GET', null, port, host);
        section('Power Budget');
        printJSON(r.data); console.log();
      } else if (sub === 'checkpoint') {
        const r = await api('/mobile/checkpoint', 'POST', {}, port, host);
        console.log(r.data?.ok ? fx.ok(`Checkpointed (${r.data.size} bytes)`) : fx.err(r.data?.reason || 'failed'));
      } else if (sub === 'sync') {
        const r = await api('/mobile/sync', 'POST', {}, port, host);
        console.log(r.data?.ok ? fx.ok(`Sync triggered (#${r.data.syncCount})`) : fx.err('failed'));
      } else {
        console.log(fx.err('mobile <status|power|checkpoint|sync>'));
      }
      break;
    }

    case 'clear': process.stdout.write('\x1b[2J\x1b[0f'); break;

    case 'exit': case 'quit':
      console.log(fx.dim('\nGoodbye.'));
      if (opts._watching) clearInterval(opts._watching);
      if (opts._nodeWatcher) clearInterval(opts._nodeWatcher);
      process.exit(0);
      break;

    case '': break;

    default:
      console.log(fx.err(`Unknown command: ${cmd}`) + '  — type ' + fx.key('help'));

  }} catch (e) { console.log(fx.err(`Error: ${e.message}`)); }
}

// ── Banner ─────────────────────────────────────────────────────────────────────
function banner(port, host, selfId) {
  const ps = `${host}:${port}`;
  const id = (selfId || 'not registered').slice(0, 44);
  console.log(`
${C.bold}${C.m}╔══════════════════════════════════════════════════╗${C.reset}
${C.bold}${C.m}║${C.reset}  ${C.bold}${C.c}NEXUS Sovereign Node  CLI  v2.1${C.reset}               ${C.bold}${C.m}║${C.reset}
${C.bold}${C.m}║${C.reset}  ${C.dg}Bridge: ${ps.padEnd(42)}${C.reset}${C.bold}${C.m}║${C.reset}
${C.bold}${C.m}║${C.reset}  ${C.dg}Self:   ${id.padEnd(42)}${C.reset}${C.bold}${C.m}║${C.reset}
${C.bold}${C.m}╚══════════════════════════════════════════════════╝${C.reset}
  ${C.c}help${C.reset}  ${C.c}status${C.reset}  ${C.c}mesh scan${C.reset}  ${C.c}watch${C.reset}  ${C.c}test all${C.reset}  ${C.c}module list${C.reset}
`);
}

// ── Start CLI ──────────────────────────────────────────────────────────────────
async function startCLI(opts = {}) {
  const argv   = process.argv.slice(2);
  const pi     = argv.indexOf('--port');
  const hi     = argv.indexOf('--host');
  const forced = opts.port || (pi >= 0 ? parseInt(argv[pi + 1]) : null);
  const host   = opts.host || (hi >= 0 ? argv[hi + 1] : '127.0.0.1');
  const doScan = argv.includes('--scan');

  console.log(fx.dim('\nNexus CLI v2.1 — negotiating port…'));
  const negotiated = await negotiatePort(forced, true);
  const port = negotiated.port;
  const resolvedHost = host || negotiated.host;

  let selfInstanceId = null;
  console.log(fx.dim(`  Connecting to ${resolvedHost}:${port}…`));
  try {
    selfInstanceId = await registerSelfToCFR(port, resolvedHost);
    console.log(fx.ok(`  Registered: ${selfInstanceId.slice(0,8)}`));
  } catch {
    console.log(fx.warn(`  Server not reachable at ${resolvedHost}:${port} — start the node first`));
  }

  const combined = {
    port, host: resolvedHost,
    bus:    opts.bus,
    busEmit:opts.busEmit,
    ctx:    opts.ctx || null,
    selfInstanceId,
    _watching:    null,
    _nodeWatcher: null,
  };

  banner(port, host, selfInstanceId);
  if (doScan) await dispatch('mesh scan', combined);

  const CMDS = [
    'help','status','identity','nodes','trust','ime',
    'sngate trace','sngate rules','sngate add',
    'causal stats','causal classify','causal query','causal log','causal recent',
    'cfr nodes','cfr field','cfr field set','cfr deltas','cfr state','cfr simulate','cfr register',
    'emit','pulse','calltos',
    'mesh scan','mesh peers','mesh dht','mesh announce',
    'dht peers','dht find','dht stats',
    'module list','module unload','module reload',
    'port','port set','ollama',
    'guardian status','guardian appid create','guardian appid list',
    'ble status','ble scan','ble discovered','ble peers','ble connect','ble disconnect','ble send',
    'mobile status','mobile power','mobile checkpoint','mobile sync',
    'test','test all','test health','test cfr','test sngate','test causal','test trust','test dht',
    'bench','watch','clear','exit','quit',
  ];

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${C.bold}${C.m}nexus${C.reset}${C.dg}@${C.reset}${C.c}${port}${C.reset} ${C.bold}${C.m}❯${C.reset} `,
    completer: line => {
      const hits = CMDS.filter(c => c.startsWith(line));
      return [hits.length ? hits : CMDS, line];
    },
  });

  // Start inbound node watcher — notifies when new nodes connect
  combined._nodeWatcher = startNodeWatcher(port, host, rl);

  rl.prompt();
  rl.on('line', async line => {
    if (combined._watching && line.trim()) { clearInterval(combined._watching); combined._watching = null; }
    await dispatch(line, combined);
    rl.prompt();
  });
  rl.on('close', () => {
    console.log(fx.dim('\nCLI closed.'));
    if (combined._watching) clearInterval(combined._watching);
    if (combined._nodeWatcher) clearInterval(combined._nodeWatcher);
    process.exit(0);
  });

  return rl;
}

if (require.main === module) startCLI();

module.exports = { startCLI, dispatch, negotiatePort, scanLAN, randomEphemeralPort, BLOCKED_PORTS };
