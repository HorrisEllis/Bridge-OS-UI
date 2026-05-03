// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
'use strict';
/**
 * bridge-steg/index.js
 * Steganographic Channel — hide mesh traffic inside legitimate-looking HTTP requests.
 *
 * Two covert channel techniques:
 *
 * 1. JSON Field Steganography — payload encoded into innocuous-looking JSON
 *    field names and values (timestamps, UUIDs, metric values). An observer
 *    sees a normal telemetry/analytics POST. The receiver extracts the payload
 *    from the encoded fields.
 *
 * 2. HTTP Header Steganography — payload encoded in X-Request-ID, X-Trace-ID,
 *    X-Session-Token, and ETag headers. Each header carries a fragment. The
 *    receiver assembles fragments in order.
 *
 * Both channels use AES-256-GCM encryption before encoding. Steganography
 * provides traffic pattern cover; encryption provides payload confidentiality.
 * They are not substitutes for each other.
 *
 * Wire protocol:
 *   POST /steg/inject    { channel, payload, key }  → { ok, cover }
 *   POST /steg/extract   { channel, cover, key }    → { ok, payload }
 *   GET  /steg/stats     → { injected, extracted, errors }
 *
 * Bus events:
 *   steg:injected   { channel, size }
 *   steg:extracted  { channel, size }
 *   steg:error      { channel, reason }
 *
 * Invariants:
 *   S-01: Steganographic encoding is always layered on top of AES-256-GCM.
 *   S-02: Cover traffic mimics realistic telemetry payloads (reasonable field counts, values).
 *   S-03: Key material is never stored — always passed per-operation.
 *   S-04: extract() returns null if auth tag fails — never partial plaintext.
 *
 * UUID: bridge-steg-0000-0000-0000-000000000001
 * Version: 1.0.0
 */

const crypto = require('crypto');

const MODULE_UUID    = 'bridge-steg-0000-0000-0000-000000000001';
const MODULE_VERSION = '1.0.0';

// ── AES-256-GCM helpers ───────────────────────────────────────────────────────

function encrypt(keyBuf, plaintext) {
  const iv     = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBuf, iv);
  const enc    = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
  const tag    = cipher.getAuthTag();
  // Pack: 12B IV + 16B tag + ciphertext
  return Buffer.concat([iv, tag, enc]);
}

function decrypt(keyBuf, packed) {
  const buf   = Buffer.isBuffer(packed) ? packed : Buffer.from(packed, 'base64');
  const iv    = buf.slice(0, 12);
  const tag   = buf.slice(12, 28);
  const enc   = buf.slice(28);
  const d     = crypto.createDecipheriv('aes-256-gcm', keyBuf, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]);
}

function keyFromSecret(secret) {
  // Derive a 32-byte AES key from an arbitrary secret string
  return crypto.createHash('sha256').update(String(secret)).digest();
}

// ── Channel 1: JSON Field Steganography ──────────────────────────────────────
//
// Cover: a telemetry JSON object with plausible-looking metric fields.
// Encoding: the encrypted payload is base64'd, then split into chunks.
// Each chunk is encoded as a hex timestamp offset (disguised as a metric value).
// The field names are drawn from a realistic telemetry vocabulary.

const TELEM_KEYS = [
  'session_latency_p99', 'cache_hit_ratio', 'req_duration_ms', 'bytes_recv',
  'bytes_sent', 'gc_pause_ms', 'heap_used_bytes', 'connection_pool_size',
  'queue_depth', 'error_rate', 'cpu_user_pct', 'mem_rss_bytes',
  'db_query_ms', 'dns_lookup_ms', 'tls_handshake_ms', 'redirect_count',
];

const HEADER_FIELDS = [
  'trace_id', 'span_id', 'request_id', 'correlation_id',
  'session_token', 'client_version', 'region_code', 'shard_key',
];

// Encode encrypted blob into a telemetry JSON object
function jsonEncode(encryptedBuf) {
  const b64     = encryptedBuf.toString('base64');
  const chunkSz = 8; // characters per field
  const chunks  = [];
  for (let i = 0; i < b64.length; i += chunkSz) chunks.push(b64.slice(i, i + chunkSz));

  const cover = {
    // Authentic-looking envelope
    ts:         Date.now(),
    version:    '2.4.' + Math.floor(Math.random() * 10),
    env:        'production',
    region:     ['us-east-1','eu-west-1','ap-south-1'][Math.floor(Math.random()*3)],
    instance:   crypto.randomBytes(4).toString('hex') + '-prod',
    // Sentinel: number of chunks (encoded as a plausible metric)
    _chunk_count: chunks.length,
    metrics:    {},
    headers:    {},
  };

  // Embed chunks into metric values as scaled integers (realistic-looking)
  for (let i = 0; i < chunks.length; i++) {
    const key = TELEM_KEYS[i % TELEM_KEYS.length] + (i >= TELEM_KEYS.length ? '_' + Math.floor(i / TELEM_KEYS.length) : '');
    // Encode chunk index as a plausible-looking metric value
    // Use chunk index + length as value to avoid partial buffer reads
    cover.metrics[key] = (i * 31337 + chunks[i].length * 997) % 1_000_000;
    // Also store the actual chunk in a header field for faithful decode
    cover.headers[HEADER_FIELDS[i % HEADER_FIELDS.length] + (i >= HEADER_FIELDS.length ? '_' + i : '')] = chunks[i];
  }

  return cover;
}

// Decode telemetry JSON object back to encrypted blob
function jsonDecode(cover) {
  const count = cover._chunk_count;
  if (!count || count <= 0) throw new Error('[steg] missing _chunk_count sentinel');
  const chunks = [];
  for (let i = 0; i < count; i++) {
    const key = HEADER_FIELDS[i % HEADER_FIELDS.length] + (i >= HEADER_FIELDS.length ? '_' + i : '');
    const chunk = cover.headers?.[key];
    if (chunk == null) throw new Error(`[steg] missing chunk ${i} (key: ${key})`);
    chunks.push(chunk);
  }
  return Buffer.from(chunks.join(''), 'base64');
}

// ── Channel 2: HTTP Header Steganography ─────────────────────────────────────
//
// Cover: a set of HTTP-style headers that look like normal request metadata.
// Encoding: encrypted blob split into 20-char hex fragments, one per header.

const COVER_HEADERS = [
  'X-Request-ID', 'X-Trace-ID', 'X-Correlation-ID', 'X-Session-Token',
  'X-Client-Build', 'ETag', 'X-Forwarded-For', 'X-Real-IP',
  'X-Content-Hash', 'X-Region-Token', 'X-Deploy-ID', 'X-Cache-Key',
];

function headerEncode(encryptedBuf) {
  const hex     = encryptedBuf.toString('hex');
  const chunkSz = 20;
  const chunks  = [];
  for (let i = 0; i < hex.length; i += chunkSz) chunks.push(hex.slice(i, i + chunkSz));
  const headers = { 'X-Chunk-Count': String(chunks.length) };
  for (let i = 0; i < chunks.length; i++) {
    headers[COVER_HEADERS[i % COVER_HEADERS.length] + (i >= COVER_HEADERS.length ? '-' + Math.floor(i / COVER_HEADERS.length) : '')] = chunks[i];
  }
  return headers;
}

function headerDecode(headers) {
  const count = parseInt(headers['X-Chunk-Count'] || '0');
  if (!count) throw new Error('[steg] missing X-Chunk-Count');
  const chunks = [];
  for (let i = 0; i < count; i++) {
    const key = COVER_HEADERS[i % COVER_HEADERS.length] + (i >= COVER_HEADERS.length ? '-' + Math.floor(i / COVER_HEADERS.length) : '');
    const chunk = headers[key] || headers[key.toLowerCase()];
    if (!chunk) throw new Error(`[steg] missing header chunk ${i}`);
    chunks.push(chunk);
  }
  return Buffer.from(chunks.join(''), 'hex');
}

// ── Public API ────────────────────────────────────────────────────────────────

function createStegChannel({ busEmit = null } = {}) {
  const _stats = { injected: 0, extracted: 0, errors: 0 };

  /**
   * inject({ channel, payload, secret })
   * channel: 'json' | 'header'
   * payload: string or Buffer
   * secret:  shared secret string (both sides must have same secret)
   * Returns: cover object (JSON object or headers map)
   */
  function inject({ channel = 'json', payload, secret }) {
    if (!payload) throw new Error('[steg] payload required');
    if (!secret)  throw new Error('[steg] secret required');
    const key     = keyFromSecret(secret);
    const plain   = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
    const enc     = encrypt(key, plain);
    let cover;
    try {
      cover = channel === 'header' ? headerEncode(enc) : jsonEncode(enc);
    } catch (e) {
      _stats.errors++;
      busEmit?.('steg:error', { channel, reason: e.message }, 'WARN');
      throw e;
    }
    _stats.injected++;
    busEmit?.('steg:injected', { channel, size: plain.length }, 'DEBUG');
    return cover;
  }

  /**
   * extract({ channel, cover, secret })
   * cover: the cover object returned by inject()
   * Returns: original payload Buffer, or null if auth fails
   */
  function extract({ channel = 'json', cover, secret }) {
    if (!cover)  throw new Error('[steg] cover required');
    if (!secret) throw new Error('[steg] secret required');
    const key = keyFromSecret(secret);
    let enc;
    try {
      enc = channel === 'header' ? headerDecode(cover) : jsonDecode(cover);
    } catch (e) {
      _stats.errors++;
      busEmit?.('steg:error', { channel, reason: `decode: ${e.message}` }, 'WARN');
      return null;
    }
    try {
      const plain = decrypt(key, enc);
      _stats.extracted++;
      busEmit?.('steg:extracted', { channel, size: plain.length }, 'DEBUG');
      return plain;
    } catch {
      // Auth tag failure — S-04: never return partial plaintext
      _stats.errors++;
      busEmit?.('steg:error', { channel, reason: 'auth tag failure' }, 'WARN');
      return null;
    }
  }

  function route(method, urlParts, body, req, res) {
    const _json = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };

    if (method === 'POST' && urlParts[1] === 'inject') {
      const { channel, payload, secret } = body || {};
      try {
        const cover = inject({ channel, payload, secret });
        return _json(200, { ok: true, cover });
      } catch (e) { return _json(400, { ok: false, error: e.message }); }
    }

    if (method === 'POST' && urlParts[1] === 'extract') {
      const { channel, cover, secret } = body || {};
      try {
        const result = extract({ channel, cover, secret });
        if (!result) return _json(400, { ok: false, error: 'auth tag failure or bad cover' });
        return _json(200, { ok: true, payload: result.toString('utf8') });
      } catch (e) { return _json(400, { ok: false, error: e.message }); }
    }

    if (method === 'GET' && urlParts[1] === 'stats') {
      return _json(200, { ok: true, ..._stats });
    }

    return null;
  }

  function diagnostics() {
    return { uuid: MODULE_UUID, version: MODULE_VERSION, ..._stats };
  }

  return { inject, extract, route, diagnostics, MODULE_UUID, MODULE_VERSION };
}

module.exports = { createStegChannel, MODULE_UUID, MODULE_VERSION };
