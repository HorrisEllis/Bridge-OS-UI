// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
'use strict';
/**
 * bridge-dht/index.js
 * Kademlia-style DHT peer registry for sovereign-node.
 *
 * Replaces DDNS (dns-server.js / bridge-mesh-identity.js) for peer discovery.
 *
 * Design axioms (from MANIFEST):
 *   - Local first: lookup checks local routing table before issuing network queries
 *   - Identity is cryptographic: every record is signed by the peer's Ed25519 key
 *   - Trust is earned: DHT records are verified but not automatically trusted;
 *     sngate + IME remain the trust authority
 *   - No central authority: no DNS resolver, no zone file, no A-record owner
 *
 * What this does:
 *   1. Maintains a routing table keyed by XOR-distance from this node's UUID
 *   2. Publishes this node's address record to the k-closest known peers (k=8)
 *   3. Resolves peer addresses by querying the routing table or issuing FIND_NODE
 *   4. All records are Ed25519-signed by the announcing node
 *   5. Expired records (TTL) are evicted automatically
 *
 * Wire protocol (HTTP POST — uses the existing HTTP server):
 *   POST /dht/store   { record: DHTRecord }
 *   POST /dht/find    { target: uuid, k?: number }  → { nodes: DHTRecord[] }
 *   GET  /dht/stats                                  → routing table stats
 *
 * Bus events:
 *   dht:record:stored   { uuid, address, source }
 *   dht:lookup:hit      { target, address, hops }
 *   dht:lookup:miss     { target }
 *   dht:bootstrap:done  { peers: number }
 *
 * UUID: bridge-dht-ka6d-5200-0000-000000000001
 * Version: 1.0.0
 */

const crypto = require('crypto');
const http   = require('http');

const MODULE_UUID    = 'bridge-dht-ka6d-5200-0000-000000000001';
const MODULE_VERSION = '1.0.0';

const K_BUCKET_SIZE   = 8;    // max peers per bucket
const ALPHA           = 3;    // parallel lookups
const RECORD_TTL_MS   = 30 * 60 * 1000;   // 30 min
const REPUBLISH_MS    = 10 * 60 * 1000;   // re-announce every 10 min
const LOOKUP_TIMEOUT  = 4000;             // ms per FIND_NODE call
const MAX_ROUTE_TABLE = 256;              // hard cap on routing table size

// ── XOR distance (first 8 bytes of UUID hex treated as a BigInt) ──────────────

function uuidToBigInt(uuid) {
    // Take the first 16 hex chars (64 bits) — enough for bucket math
    const hex = uuid.replace(/-/g, '').slice(0, 16);
    return BigInt('0x' + hex);
}

function xorDistance(a, b) {
    return uuidToBigInt(a) ^ uuidToBigInt(b);
}

// ── DHTRecord ─────────────────────────────────────────────────────────────────

/**
 * A signed address record.
 * {
 *   uuid:      string   — node UUID
 *   address:   string   — http://host:port
 *   publicKey: string   — base64 Ed25519 public key
 *   ts:        number   — unix ms
 *   sig:       string   — base64 Ed25519 sig over canonical payload
 * }
 */
function makeRecord({ uuid, address, identity }) {
    const ts      = Date.now();
    const payload = canonicalPayload(uuid, address, ts);
    const sig     = identity.sign(payload);
    return {
        uuid,
        address,
        publicKey: identity.publicKeyB64,
        ts,
        sig,
    };
}

function canonicalPayload(uuid, address, ts) {
    return `dht:${uuid}:${address}:${ts}`;
}

function verifyRecord(record) {
    if (!record || !record.uuid || !record.address || !record.publicKey || !record.sig || !record.ts) {
        return { ok: false, reason: 'missing fields' };
    }
    // Verify signature — wrap DER buffer with createPublicKey (required on Node 22+)
    try {
        const pubKeyBuf = Buffer.from(record.publicKey, 'base64');
        const pubKeyObj = crypto.createPublicKey({ key: pubKeyBuf, type: 'spki', format: 'der' });
        const sigBuf    = Buffer.from(record.sig, 'base64');
        const payload   = Buffer.from(canonicalPayload(record.uuid, record.address, record.ts));
        const ok        = crypto.verify(null, payload, pubKeyObj, sigBuf);
        if (!ok) return { ok: false, reason: 'invalid signature' };
    } catch (e) {
        return { ok: false, reason: `sig error: ${e.message}` };
    }
    // Check freshness
    if (Date.now() - record.ts > RECORD_TTL_MS) {
        return { ok: false, reason: 'record expired' };
    }
    return { ok: true };
}

// ── Routing table ─────────────────────────────────────────────────────────────

function createRoutingTable(selfUuid) {
    // Map: uuid → DHTRecord  (sorted by XOR distance on read)
    const _table = new Map();
    let   _evictions = 0;

    function add(record) {
        if (record.uuid === selfUuid) return; // never store self
        if (_table.size >= MAX_ROUTE_TABLE) {
            // Evict the farthest entry
            const sorted = _sorted();
            _table.delete(sorted[sorted.length - 1].uuid);
            _evictions++;
        }
        _table.set(record.uuid, { ...record, _addedAt: Date.now() });
    }

    function get(uuid) { return _table.get(uuid) || null; }

    function remove(uuid) { _table.delete(uuid); }

    function evictExpired() {
        const cutoff = Date.now() - RECORD_TTL_MS;
        for (const [uuid, rec] of _table) {
            if (rec.ts < cutoff) { _table.delete(uuid); _evictions++; }
        }
    }

    // k closest nodes to target
    function kClosest(targetUuid, k = K_BUCKET_SIZE) {
        return _sorted(targetUuid).slice(0, k);
    }

    function _sorted(target = selfUuid) {
        return [..._table.values()].sort((a, b) => {
            const da = xorDistance(a.uuid, target);
            const db = xorDistance(b.uuid, target);
            return da < db ? -1 : da > db ? 1 : 0;
        });
    }

    function size()  { return _table.size; }
    function all()   { return [..._table.values()]; }
    function stats() { return { size: _table.size, evictions: _evictions }; }

    return { add, get, remove, kClosest, evictExpired, size, all, stats };
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

function httpPost(address, path, body, timeoutMs = LOOKUP_TIMEOUT) {
    return new Promise((resolve, reject) => {
        const url = new URL(path, address);
        const payload = JSON.stringify(body);
        const req = http.request({
            hostname: url.hostname,
            port:     Number(url.port) || 3747,
            path:     url.pathname,
            method:   'POST',
            headers:  {
                'Content-Type':   'application/json',
                'Content-Length': Buffer.byteLength(payload),
            },
            timeout:  timeoutMs,
        }, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
                catch { resolve(null); }
            });
        });
        req.on('error',   (e) => reject(e));
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.write(payload);
        req.end();
    });
}

// ── DHT node ──────────────────────────────────────────────────────────────────

function createDHT({ identity, busEmit = null, bootstrapPeers = [], port = 3747, announcedHost = null } = {}) {
    if (!identity) throw new Error('bridge-dht: identity required');

    const selfUuid    = identity.uuid;
    const table       = createRoutingTable(selfUuid);
    let   _republish  = null;
    let   _evictTimer = null;
    let   _stats      = { stores: 0, lookups: 0, hits: 0, misses: 0, announcements: 0 };

    // ── Self-record (updated whenever announcedHost changes) ────────────────
    function _selfRecord() {
        const host = announcedHost || '127.0.0.1';
        return makeRecord({ uuid: selfUuid, address: `http://${host}:${port}`, identity });
    }

    // ── Store a remote record ────────────────────────────────────────────────
    function storeRecord(record) {
        const v = verifyRecord(record);
        if (!v.ok) {
            busEmit?.('dht:record:rejected', { uuid: record?.uuid, reason: v.reason }, 'WARN');
            return { ok: false, reason: v.reason };
        }
        const existing = table.get(record.uuid);
        if (existing && existing.ts >= record.ts) return { ok: true, noop: true }; // already fresher
        table.add(record);
        _stats.stores++;
        busEmit?.('dht:record:stored', { uuid: record.uuid, address: record.address, source: 'remote' }, 'DEBUG');
        return { ok: true };
    }

    // ── Lookup: local table first, then iterative FIND_NODE ──────────────────
    async function lookup(targetUuid, maxHops = 3) {
        _stats.lookups++;

        // 1. Local hit
        const local = table.get(targetUuid);
        if (local && (Date.now() - local.ts < RECORD_TTL_MS)) {
            _stats.hits++;
            busEmit?.('dht:lookup:hit', { target: targetUuid, address: local.address, hops: 0 }, 'DEBUG');
            return { ok: true, record: local, hops: 0 };
        }

        // 2. Iterative FIND_NODE
        const contacted = new Set([selfUuid]);
        let   candidates = table.kClosest(targetUuid, ALPHA);

        for (let hop = 1; hop <= maxHops && candidates.length > 0; hop++) {
            const batch = candidates.filter(c => !contacted.has(c.uuid)).slice(0, ALPHA);
            if (!batch.length) break;

            const results = await Promise.allSettled(
                batch.map(async (peer) => {
                    contacted.add(peer.uuid);
                    try {
                        const res = await httpPost(peer.address, '/dht/find', { target: targetUuid, k: K_BUCKET_SIZE });
                        // Absorb new nodes into routing table
                        if (res?.nodes) {
                            for (const r of res.nodes) storeRecord(r);
                        }
                        return res?.nodes || [];
                    } catch { return []; }
                })
            );

            // Check if any returned a direct hit (the target itself)
            for (const r of results) {
                if (r.status === 'fulfilled') {
                    const hit = r.value.find(n => n.uuid === targetUuid);
                    if (hit) {
                        const v = verifyRecord(hit);
                        if (v.ok) {
                            table.add(hit);
                            _stats.hits++;
                            busEmit?.('dht:lookup:hit', { target: targetUuid, address: hit.address, hops: hop }, 'DEBUG');
                            return { ok: true, record: hit, hops: hop };
                        }
                    }
                }
            }

            // Merge new candidates for next hop
            const newNodes = results
                .filter(r => r.status === 'fulfilled')
                .flatMap(r => r.value)
                .filter(n => n && !contacted.has(n.uuid));
            candidates = [...newNodes].sort((a, b) => {
                const da = xorDistance(a.uuid, targetUuid);
                const db = xorDistance(b.uuid, targetUuid);
                return da < db ? -1 : da > db ? 1 : 0;
            }).slice(0, ALPHA);
        }

        _stats.misses++;
        busEmit?.('dht:lookup:miss', { target: targetUuid }, 'DEBUG');
        return { ok: false, reason: 'not found' };
    }

    // ── Announce self to k-closest peers ─────────────────────────────────────
    async function announce() {
        const record = _selfRecord();
        const peers  = table.kClosest(selfUuid, K_BUCKET_SIZE);
        _stats.announcements++;

        const results = await Promise.allSettled(
            peers.map(peer =>
                httpPost(peer.address, '/dht/store', { record }).catch(() => null)
            )
        );

        const ok = results.filter(r => r.status === 'fulfilled' && r.value?.ok).length;
        busEmit?.('dht:announce:done', { peers: peers.length, acknowledged: ok }, 'DEBUG');
        return { peers: peers.length, acknowledged: ok };
    }

    // ── Bootstrap: ping known peers, absorb their routing tables ─────────────
    async function bootstrap(peers = bootstrapPeers) {
        let absorbed = 0;
        await Promise.allSettled(
            peers.map(async (addr) => {
                try {
                    const res = await httpPost(addr, '/dht/find', { target: selfUuid, k: K_BUCKET_SIZE });
                    if (res?.nodes) {
                        for (const r of res.nodes) {
                            if (storeRecord(r).ok) absorbed++;
                        }
                    }
                    // Also store the bootstrap peer itself by hitting /identity
                    // (handled at boot-wiring level — see boot.js integration below)
                } catch { /* bootstrap peer unreachable — not fatal */ }
            })
        );
        busEmit?.('dht:bootstrap:done', { peers: peers.length, absorbed }, 'INFO');
        return { peers: peers.length, absorbed };
    }

    // ── Start background timers ───────────────────────────────────────────────
    function start() {
        // Periodic re-announce
        _republish = setInterval(() => announce().catch(() => {}), REPUBLISH_MS);
        // Periodic eviction of expired records
        _evictTimer = setInterval(() => table.evictExpired(), 60_000);
        // Initial bootstrap
        if (bootstrapPeers.length > 0) {
            bootstrap().catch(() => {});
        }
    }

    function stop() {
        clearInterval(_republish);
        clearInterval(_evictTimer);
    }

    // ── HTTP route handler (/dht/*) ───────────────────────────────────────────
    function route(method, urlParts, body) {
        const sub = urlParts[1];

        // POST /dht/store — accept a record from a remote peer
        if (method === 'POST' && sub === 'store') {
            const record = body?.record;
            if (!record) return { ok: false, error: 'record required' };
            return storeRecord(record);
        }

        // POST /dht/find — return k closest nodes to target
        if (method === 'POST' && sub === 'find') {
            const target = body?.target;
            const k      = Math.min(Number(body?.k) || K_BUCKET_SIZE, K_BUCKET_SIZE);
            if (!target) return { ok: false, error: 'target required' };
            // Always include self record in response if we're close to target
            const nodes  = table.kClosest(target, k);
            const self   = _selfRecord();
            const merged = [self, ...nodes].slice(0, k);
            return { ok: true, nodes: merged };
        }

        // GET /dht/stats
        if (method === 'GET' && sub === 'stats') {
            return {
                ok:    true,
                uuid:  selfUuid,
                table: table.stats(),
                ops:   { ..._stats },
            };
        }

        // GET /dht/peers — list all known peers (admin use)
        if (method === 'GET' && sub === 'peers') {
            return { ok: true, peers: table.all().map(r => ({ uuid: r.uuid, address: r.address, ts: r.ts })) };
        }

        return null; // not our route
    }

    function diagnostics() {
        return {
            uuid:  selfUuid,
            table: table.stats(),
            ops:   { ..._stats },
        };
    }

    return {
        uuid:        MODULE_UUID,
        version:     MODULE_VERSION,
        start,
        stop,
        storeRecord,
        lookup,
        announce,
        bootstrap,
        route,
        diagnostics,
        table,          // exposed for boot.js integration with magnet
        _selfRecord,
    };
}

module.exports = { createDHT, verifyRecord, makeRecord, MODULE_UUID, MODULE_VERSION };
