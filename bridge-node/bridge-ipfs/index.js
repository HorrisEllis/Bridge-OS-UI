// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
'use strict';
/**
 * bridge-ipfs/index.js
 * Content-Addressed Storage — IPFS-compatible record types in the Bridge DHT.
 *
 * What this does:
 *   1. Content records: any blob of data gets a CID (SHA-256 multihash, base58).
 *      CIDs slot into the existing Kademlia DHT as keys — the same XOR routing
 *      table that finds peers by UUID can find content holders by CID.
 *
 *   2. Provider records: when this node stores a content chunk, it announces
 *      itself as a provider to the k-closest DHT peers. Any node can then
 *      look up who holds a given CID and retrieve it.
 *
 *   3. Content retrieval: GET /ipfs/:cid fetches from local store, or falls
 *      back to querying DHT providers and fetching over HTTP.
 *
 *   4. Content pinning: POST /ipfs/pin { cid } marks content as permanent
 *      (survives GC). Unpinned content is evicted after TTL.
 *
 * CID format:
 *   'Qm' + base58(sha256(content))  — matches IPFS CIDv0 shape for compat
 *   Full CIDv1 (multibase/multicodec) is future work.
 *
 * Record types in DHT:
 *   type: 'peer'    — existing: UUID → http://host:port
 *   type: 'content' — new:      CID  → { providers: [{uuid, address}], size, ts }
 *
 * Wire protocol:
 *   POST /ipfs/put        { data: base64 }          → { ok, cid, size }
 *   GET  /ipfs/:cid                                  → raw content (or 404)
 *   POST /ipfs/find       { cid }                   → { ok, providers: [] }
 *   POST /ipfs/pin        { cid }                   → { ok, pinned }
 *   DELETE /ipfs/pin/:cid                           → { ok, unpinned }
 *   GET  /ipfs/stats                                 → store stats
 *   GET  /ipfs/ls                                   → pinned CID list
 *
 * Bus events:
 *   ipfs:content:stored    { cid, size, pinned }
 *   ipfs:content:retrieved { cid, size, source }  (source: local|remote)
 *   ipfs:provider:announced { cid, peers }
 *   ipfs:gc:evicted        { cid, size, reason }
 *
 * Invariants:
 *   I-01: CID is always SHA-256 of the raw content. Never set directly.
 *   I-02: Content is stored before provider record is announced.
 *   I-03: Retrieval returns null (not partial) if content hash does not match CID.
 *   I-04: Pinned content is never GC'd. Eviction only touches unpinned.
 *   I-05: DHT content records use the same routing table as peer records.
 *         The routing table does not differentiate — any key maps to any record type.
 *
 * UUID: bridge-ipfs-0000-0000-0000-000000000001
 * Version: 1.0.0
 */

'use strict';

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const http   = require('http');

const MODULE_UUID    = 'bridge-ipfs-0000-0000-0000-000000000001';
const MODULE_VERSION = '1.0.0';

const CONTENT_TTL_MS   = 24 * 60 * 60 * 1000; // 24 hours for unpinned
const MAX_CHUNK_BYTES  = 256 * 1024;            // 256KB max per CID
const GC_INTERVAL_MS   = 10 * 60 * 1000;        // GC every 10 min
const PROVIDER_TTL_MS  = 30 * 60 * 1000;        // provider record TTL

// ── CID derivation (CIDv0-compatible shape) ───────────────────────────────────

const BASE58_CHARS = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(buf) {
  let num = BigInt('0x' + buf.toString('hex'));
  let result = '';
  while (num > 0n) {
    result = BASE58_CHARS[Number(num % 58n)] + result;
    num = num / 58n;
  }
  // Leading zeroes
  for (const b of buf) {
    if (b !== 0) break;
    result = '1' + result;
  }
  return result;
}

/**
 * Derive a CID from raw content bytes.
 * Returns a 'Qm'-prefixed base58 string matching IPFS CIDv0 shape.
 * Invariant I-01: always computed from content, never set directly.
 */
function deriveCID(contentBuf) {
  const hash = crypto.createHash('sha256').update(contentBuf).digest();
  // Prepend multihash prefix: 0x12 (sha2-256) + 0x20 (32 bytes)
  const mh = Buffer.concat([Buffer.from([0x12, 0x20]), hash]);
  return 'Qm' + base58Encode(mh);
}

/**
 * Verify that content matches a CID.
 * Returns true/false. Invariant I-03: never return partial on mismatch.
 */
function verifyCID(cid, contentBuf) {
  return deriveCID(contentBuf) === cid;
}

// ── Content record for DHT ────────────────────────────────────────────────────

function makeContentRecord({ cid, size, providers = [], identity }) {
  const ts  = Date.now();
  // Sign over canonical payload so providers can verify the announcement
  const payload = `ipfs:${cid}:${size}:${ts}`;
  const sig     = identity?.sign ? identity.sign(payload) : null;
  return {
    type:      'content',
    cid,
    size,
    providers, // [{ uuid, address }]
    ts,
    sig,
    publisherUuid: identity?.uuid || null,
  };
}

// ── Content store (local) ─────────────────────────────────────────────────────

function createContentStore({ storeDir, busEmit = null } = {}) {
  const _store  = new Map(); // cid → { content: Buffer, pinned, ts, size }
  const _pinned = new Set(); // pinned CIDs — exempt from GC
  let   _gcTimer = null;

  if (storeDir && !fs.existsSync(storeDir)) {
    try { fs.mkdirSync(storeDir, { recursive: true }); } catch {}
  }

  function _filePath(cid) {
    return storeDir ? path.join(storeDir, cid + '.bin') : null;
  }

  function put(contentBuf, { pin = false } = {}) {
    if (!Buffer.isBuffer(contentBuf)) contentBuf = Buffer.from(contentBuf);
    if (contentBuf.length > MAX_CHUNK_BYTES) {
      throw new Error(`[ipfs] content too large: ${contentBuf.length} > ${MAX_CHUNK_BYTES}`);
    }

    const cid = deriveCID(contentBuf);

    // Invariant I-02: store before announcing
    _store.set(cid, {
      content: contentBuf,
      pinned:  pin,
      ts:      Date.now(),
      size:    contentBuf.length,
    });

    if (pin) _pinned.add(cid);

    // Persist to disk if storeDir configured
    if (storeDir) {
      try {
        const tmp = _filePath(cid) + '.tmp';
        fs.writeFileSync(tmp, contentBuf);
        fs.renameSync(tmp, _filePath(cid));
      } catch {}
    }

    busEmit?.('ipfs:content:stored', { cid, size: contentBuf.length, pinned: pin }, 'INFO');
    return cid;
  }

  function get(cid) {
    // Memory first
    const entry = _store.get(cid);
    if (entry) {
      // Invariant I-03: verify hash on retrieval
      if (!verifyCID(cid, entry.content)) {
        _store.delete(cid);
        busEmit?.('ipfs:error', { cid, reason: 'content hash mismatch on retrieval' }, 'WARN');
        return null;
      }
      return entry.content;
    }

    // Disk fallback
    if (storeDir) {
      const fp = _filePath(cid);
      if (fp && fs.existsSync(fp)) {
        try {
          const buf = fs.readFileSync(fp);
          if (!verifyCID(cid, buf)) {
            fs.unlinkSync(fp);
            busEmit?.('ipfs:error', { cid, reason: 'disk content hash mismatch' }, 'WARN');
            return null;
          }
          _store.set(cid, { content: buf, pinned: _pinned.has(cid), ts: Date.now(), size: buf.length });
          return buf;
        } catch { return null; }
      }
    }
    return null;
  }

  function has(cid)  { return _store.has(cid) || (storeDir && fs.existsSync(_filePath(cid) || '')); }
  function pin(cid)  { _pinned.add(cid); const e = _store.get(cid); if (e) e.pinned = true; return has(cid); }
  function unpin(cid){ _pinned.delete(cid); const e = _store.get(cid); if (e) e.pinned = false; }

  function gc() {
    const now    = Date.now();
    const before = _store.size;
    for (const [cid, entry] of _store) {
      // Invariant I-04: pinned content is never GC'd
      if (entry.pinned || _pinned.has(cid)) continue;
      if (now - entry.ts > CONTENT_TTL_MS) {
        _store.delete(cid);
        if (storeDir) try { fs.unlinkSync(_filePath(cid)); } catch {}
        busEmit?.('ipfs:gc:evicted', { cid, size: entry.size, reason: 'ttl_expired' }, 'DEBUG');
      }
    }
    return before - _store.size; // evicted count
  }

  function startGC() {
    _gcTimer = setInterval(gc, GC_INTERVAL_MS);
  }

  function stopGC() {
    clearInterval(_gcTimer);
  }

  function list() {
    return [..._store.entries()].map(([cid, e]) => ({
      cid, size: e.size, pinned: e.pinned, ts: e.ts,
    }));
  }

  function stats() {
    const entries = [..._store.values()];
    return {
      count:      _store.size,
      pinned:     _pinned.size,
      totalBytes: entries.reduce((s, e) => s + e.size, 0),
    };
  }

  return { put, get, has, pin, unpin, gc, startGC, stopGC, list, stats, deriveCID, verifyCID };
}

// ── IPFS module factory ───────────────────────────────────────────────────────

function createIPFS({
  identity,
  dht        = null,  // bridge-dht instance — for provider announcements + lookups
  busEmit    = null,
  storeDir   = path.join(process.cwd(), 'data', 'ipfs'),
} = {}) {

  if (!identity) throw new Error('[ipfs] identity required');

  const store = createContentStore({ storeDir, busEmit });
  store.startGC();

  // ── Announce this node as provider for a CID ──────────────────────────────

  async function announce(cid, size) {
    if (!dht) return;
    const record = makeContentRecord({
      cid,
      size,
      providers: [{ uuid: identity.uuid, address: dht._selfRecord?.()?.address || 'unknown' }],
      identity,
    });
    // Store the content record into the DHT under the CID as the key.
    // The DHT routing table uses XOR distance on the key — we need to map the
    // CID to a UUID-shaped key for routing. We use the first 32 hex chars of
    // SHA-256(cid), formatted as a UUID.
    const cidKey = _cidToKey(cid);
    // Use DHT's underlying table directly (type:'content' records co-exist with type:'peer')
    const peers = dht.table?.kClosest(cidKey, 8) || [];
    let announced = 0;
    for (const peer of peers) {
      try {
        await _httpPost(peer.address, '/ipfs/provide', { record });
        announced++;
      } catch {}
    }
    busEmit?.('ipfs:provider:announced', { cid, peers: announced }, 'INFO');
  }

  function _cidToKey(cid) {
    const hash = crypto.createHash('sha256').update(cid).digest('hex');
    return [hash.slice(0,8), hash.slice(8,12), hash.slice(12,16), hash.slice(16,20), hash.slice(20,32)].join('-');
  }

  // ── Find providers for a CID via DHT ─────────────────────────────────────

  async function findProviders(cid) {
    if (!dht) return [];
    const cidKey = _cidToKey(cid);
    const peers  = dht.table?.kClosest(cidKey, 8) || [];
    const providers = [];

    await Promise.all(peers.map(async peer => {
      try {
        const r = await _httpPost(peer.address, '/ipfs/find', { cid });
        if (r?.providers) {
          for (const p of r.providers) {
            if (!providers.find(x => x.uuid === p.uuid)) providers.push(p);
          }
        }
      } catch {}
    }));

    return providers;
  }

  // ── Fetch content from a remote provider ──────────────────────────────────

  async function fetchFrom(address, cid) {
    return new Promise(resolve => {
      const url = new URL(`/ipfs/${encodeURIComponent(cid)}`, address);
      const req = http.get({ hostname: url.hostname, port: url.port || 80, path: url.pathname, timeout: 5000 }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          if (res.statusCode !== 200) { resolve(null); return; }
          const buf = Buffer.concat(chunks);
          // Invariant I-03: verify hash
          if (!verifyCID(cid, buf)) { resolve(null); return; }
          resolve(buf);
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    });
  }

  // ── Public: store content ─────────────────────────────────────────────────

  async function put(data, { pin = false, announce: doAnnounce = true } = {}) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    const cid = store.put(buf, { pin });
    if (doAnnounce) await announce(cid, buf.length);
    return { cid, size: buf.length, pinned: pin };
  }

  // ── Public: get content (local → DHT fallback) ────────────────────────────

  async function get(cid) {
    // Local first (invariant I-05 direction)
    const local = store.get(cid);
    if (local) {
      busEmit?.('ipfs:content:retrieved', { cid, size: local.length, source: 'local' }, 'DEBUG');
      return local;
    }

    // DHT provider lookup + remote fetch
    const providers = await findProviders(cid);
    for (const provider of providers) {
      const content = await fetchFrom(provider.address, cid);
      if (content) {
        // Cache locally (unpinned)
        store.put(content, { pin: false });
        busEmit?.('ipfs:content:retrieved', { cid, size: content.length, source: provider.address }, 'INFO');
        return content;
      }
    }

    return null;
  }

  // ── HTTP helper ───────────────────────────────────────────────────────────

  function _httpPost(address, urlPath, body) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const url  = new URL(urlPath, address);
      const req  = http.request({
        hostname: url.hostname, port: url.port || 80, path: url.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        timeout: 5000,
      }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
          catch { resolve(null); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.write(data);
      req.end();
    });
  }

  // ── HTTP route handler ────────────────────────────────────────────────────

  function route(method, urlParts, body, req, res) {
    const _json = (s, o) => {
      res.writeHead(s, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(o));
    };
    const _raw = (s, buf, ct = 'application/octet-stream') => {
      res.writeHead(s, { 'Content-Type': ct, 'Content-Length': buf.length });
      res.end(buf);
    };

    // POST /ipfs/put — store content, announce to DHT
    if (method === 'POST' && urlParts[1] === 'put') {
      const { data, pin } = body || {};
      if (!data) return _json(400, { ok: false, error: 'data required (base64)' });
      try {
        const buf = Buffer.from(data, 'base64');
        put(buf, { pin: !!pin }).then(r => _json(200, { ok: true, ...r })).catch(e => _json(500, { ok: false, error: e.message }));
      } catch (e) { return _json(400, { ok: false, error: e.message }); }
      return; // async response
    }

    // GET /ipfs/:cid — retrieve content
    if (method === 'GET' && urlParts[1] && urlParts[1] !== 'stats' && urlParts[1] !== 'ls') {
      const cid = decodeURIComponent(urlParts[1]);
      get(cid).then(buf => {
        if (!buf) return _json(404, { ok: false, error: 'content not found', cid });
        _raw(200, buf);
      }).catch(e => _json(500, { ok: false, error: e.message }));
      return; // async
    }

    // POST /ipfs/find — find providers for a CID
    if (method === 'POST' && urlParts[1] === 'find') {
      const { cid } = body || {};
      if (!cid) return _json(400, { ok: false, error: 'cid required' });
      // Return local provider record if we have the content
      const providers = store.has(cid)
        ? [{ uuid: identity.uuid, address: dht?._selfRecord?.()?.address || 'unknown' }]
        : [];
      return _json(200, { ok: true, cid, providers });
    }

    // POST /ipfs/provide — accept a provider announcement from a remote node
    if (method === 'POST' && urlParts[1] === 'provide') {
      const { record } = body || {};
      if (!record?.cid) return _json(400, { ok: false, error: 'record.cid required' });
      // Store the provider record in our DHT table under the CID key
      if (dht) {
        const cidKey = _cidToKey(record.cid);
        // We inject it as a synthetic peer record so the routing table can reference it
        dht.table?.add({ uuid: cidKey, address: record.providers?.[0]?.address || '', ts: Date.now(), type: 'content', cid: record.cid });
      }
      return _json(200, { ok: true });
    }

    // POST /ipfs/pin — pin a CID
    if (method === 'POST' && urlParts[1] === 'pin') {
      const { cid } = body || {};
      if (!cid) return _json(400, { ok: false, error: 'cid required' });
      const pinned = store.pin(cid);
      return _json(200, { ok: true, cid, pinned });
    }

    // DELETE /ipfs/pin/:cid
    if (method === 'DELETE' && urlParts[1] === 'pin' && urlParts[2]) {
      const cid = decodeURIComponent(urlParts[2]);
      store.unpin(cid);
      return _json(200, { ok: true, unpinned: cid });
    }

    // GET /ipfs/stats
    if (method === 'GET' && urlParts[1] === 'stats') {
      return _json(200, { ok: true, ...store.stats(), module: MODULE_UUID, version: MODULE_VERSION });
    }

    // GET /ipfs/ls — list pinned CIDs
    if (method === 'GET' && urlParts[1] === 'ls') {
      return _json(200, { ok: true, items: store.list() });
    }

    return null;
  }

  function stop() { store.stopGC(); }

  function diagnostics() {
    return { uuid: MODULE_UUID, version: MODULE_VERSION, store: store.stats() };
  }

  return {
    put, get, announce, findProviders,
    store,
    route, stop, diagnostics,
    deriveCID, verifyCID,
    MODULE_UUID, MODULE_VERSION,
  };
}

module.exports = { createIPFS, createContentStore, deriveCID, verifyCID, makeContentRecord, MODULE_UUID, MODULE_VERSION };
