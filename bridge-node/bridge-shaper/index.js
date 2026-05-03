// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
'use strict';
/**
 * bridge-shaper/index.js
 * Traffic Shaping — make mesh traffic indistinguishable from normal HTTPS.
 *
 * Two shaping strategies:
 *
 * 1. Jitter injection — randomise inter-packet delays to match observed
 *    HTTPS CDN timing distributions (Gaussian jitter around a configurable mean).
 *
 * 2. Packet padding — pad all outbound payloads to fixed-size buckets
 *    (512B, 1KB, 4KB, 16KB) so traffic analysis cannot infer payload size.
 *    Bucket sizes match common TLS record sizes.
 *
 * 3. Request mimicry — wrap mesh payloads in HTTP request shapes that look
 *    like browser CDN fetches (User-Agent, Accept, Cache-Control headers matching
 *    real browser fingerprints).
 *
 * 4. Timing normalization — schedule sends at regular intervals regardless of
 *    actual message frequency (constant-rate traffic). Messages queue internally;
 *    empty slots send padding frames.
 *
 * Wire protocol:
 *   POST /shaper/send      { payload, priority? } → queued for shaped delivery
 *   GET  /shaper/stats     → { queued, sent, padded, jittered, droppedOld }
 *   POST /shaper/config    { intervalMs, paddingBucket, jitterMs, enabled }
 *
 * Bus events:
 *   shaper:sent     { size, paddedSize, jitterMs }
 *   shaper:queue    { depth }
 *   shaper:drop     { reason }
 *
 * Invariants:
 *   SH-01: Padding is always applied before sending. Never send exact payload size.
 *   SH-02: Padding frames are indistinguishable from real frames to an observer.
 *   SH-03: Queue is bounded (default 256). Overflow drops oldest.
 *   SH-04: Jitter is always positive (floor at 1ms). Never negative delay.
 *
 * UUID: bridge-shaper-0000-0000-0000-00000000001
 * Version: 1.0.0
 */

const crypto = require('crypto');

const MODULE_UUID    = 'bridge-shaper-0000-0000-0000-00000000001';
const MODULE_VERSION = '1.0.0';

// TLS record-aligned bucket sizes (bytes) — matches common HTTPS frame sizes
const PAD_BUCKETS = [512, 1024, 2048, 4096, 8192, 16384, 32768];

// Realistic browser User-Agent strings for request mimicry
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
];

// ── Padding ───────────────────────────────────────────────────────────────────

/**
 * Pad buffer to the next bucket size. Returns padded buffer.
 * Format: [1B: pad_length_indicator] [payload] [random padding bytes]
 * The receiver strips padding using the first byte as length remainder indicator.
 */
function padToBucket(buf) {
  const size   = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf));
  // 2-byte header stores padLen as uint16BE — supports buckets up to 32768
  const target = PAD_BUCKETS.find(b => b >= size.length + 2) || PAD_BUCKETS[PAD_BUCKETS.length - 1];
  const padLen = Math.max(0, target - size.length - 2);
  const padded = Buffer.alloc(target);
  padded.writeUInt16BE(padLen, 0); // 2-byte pad length header
  size.copy(padded, 2);
  if (padLen > 0) crypto.randomFillSync(padded, 2 + size.length, padLen);
  return padded;
}

/**
 * Strip padding from a padded buffer. Returns original payload.
 */
function stripPadding(padded) {
  const buf    = Buffer.isBuffer(padded) ? padded : Buffer.from(padded);
  if (buf.length < 2) throw new Error('[shaper] invalid padding: buffer too short');
  const padLen = buf.readUInt16BE(0);
  const payLen = buf.length - 2 - padLen;
  if (payLen <= 0) throw new Error('[shaper] invalid padding: payload length <= 0');
  return buf.slice(2, 2 + payLen);
}

// ── Jitter ────────────────────────────────────────────────────────────────────

/**
 * Sample a Gaussian jitter value (Box-Muller transform).
 * Returns a delay in ms, always >= 1ms (invariant SH-04).
 */
function gaussianJitter(meanMs = 80, stddevMs = 30) {
  const u1 = Math.random() || 1e-10;
  const u2 = Math.random() || 1e-10;
  const z  = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.max(1, Math.round(meanMs + z * stddevMs));
}

// ── Request mimicry headers ───────────────────────────────────────────────────

function mimicHeaders() {
  const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  return {
    'User-Agent':       ua,
    'Accept':           'application/json, text/plain, */*',
    'Accept-Language':  'en-US,en;q=0.9',
    'Accept-Encoding':  'gzip, deflate, br',
    'Cache-Control':    'no-cache',
    'Pragma':           'no-cache',
    'Sec-Fetch-Dest':   'empty',
    'Sec-Fetch-Mode':   'cors',
    'Sec-Fetch-Site':   'cross-site',
    'Connection':       'keep-alive',
  };
}

// ── Traffic Shaper factory ────────────────────────────────────────────────────

function createTrafficShaper({
  busEmit      = null,
  intervalMs   = 200,   // send interval for constant-rate mode
  jitterMeanMs = 80,    // mean jitter delay
  jitterStdMs  = 30,    // jitter stddev
  maxQueue     = 256,   // max queued messages before dropping oldest
  enabled      = true,
} = {}) {

  let _cfg = { intervalMs, jitterMeanMs, jitterStdMs, maxQueue, enabled };
  const _queue  = [];   // { payload, priority, queuedAt }
  const _stats  = { queued: 0, sent: 0, padded: 0, jittered: 0, droppedOld: 0 };

  // ── Queue management ──────────────────────────────────────────────────────

  function enqueue(payload, priority = 0) {
    if (_queue.length >= _cfg.maxQueue) {
      // Drop oldest (lowest priority) entry
      const dropIdx = _queue.reduce((min, _, i) =>
        _queue[i].priority < _queue[min].priority ? i : min, 0);
      _queue.splice(dropIdx, 1);
      _stats.droppedOld++;
      busEmit?.('shaper:drop', { reason: 'queue_full' }, 'WARN');
    }
    _queue.push({ payload, priority, queuedAt: Date.now() });
    _stats.queued++;
    busEmit?.('shaper:queue', { depth: _queue.length }, 'DEBUG');
  }

  // ── Shaped send tick ──────────────────────────────────────────────────────
  // Called by the consumer (boot.js or caller) at whatever rate it wants.
  // Returns the next frame to send (padded + jitter hint), or a padding frame if queue empty.

  function nextFrame() {
    let raw;
    if (_queue.length > 0) {
      // Sort by priority desc, then FIFO
      _queue.sort((a, b) => b.priority - a.priority || a.queuedAt - b.queuedAt);
      raw = _queue.shift().payload;
      _stats.sent++;
    } else {
      // Padding frame — random bytes, indistinguishable from real frame to observer
      raw = JSON.stringify({ _pad: true, ts: Date.now(), nonce: crypto.randomBytes(8).toString('hex') });
    }

    const buf     = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw));
    const padded  = padToBucket(buf);
    const jitter  = gaussianJitter(_cfg.jitterMeanMs, _cfg.jitterStdMs);

    _stats.padded++;
    _stats.jittered++;

    busEmit?.('shaper:sent', { size: buf.length, paddedSize: padded.length, jitterMs: jitter }, 'DEBUG');

    return { frame: padded, jitterMs: jitter, headers: mimicHeaders() };
  }

  // ── Decode incoming shaped frame ──────────────────────────────────────────

  function decodeFrame(paddedBuf) {
    const stripped = stripPadding(paddedBuf);
    try {
      const parsed = JSON.parse(stripped.toString());
      if (parsed._pad) return null; // padding frame — discard
      return stripped;
    } catch {
      return stripped; // binary payload
    }
  }

  // ── Config update ─────────────────────────────────────────────────────────

  function configure(updates = {}) {
    Object.assign(_cfg, updates);
  }

  // ── HTTP route handler ────────────────────────────────────────────────────

  function route(method, urlParts, body, req, res) {
    const _json = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };

    if (method === 'POST' && urlParts[1] === 'send') {
      const { payload, priority } = body || {};
      if (!payload) return _json(400, { ok: false, error: 'payload required' });
      enqueue(payload, priority || 0);
      return _json(202, { ok: true, queued: _queue.length });
    }

    if (method === 'GET' && urlParts[1] === 'stats') {
      return _json(200, { ok: true, ..._stats, queueDepth: _queue.length, config: _cfg });
    }

    if (method === 'POST' && urlParts[1] === 'config') {
      configure(body || {});
      return _json(200, { ok: true, config: _cfg });
    }

    return null;
  }

  function diagnostics() {
    return { uuid: MODULE_UUID, version: MODULE_VERSION, ..._stats, queueDepth: _queue.length };
  }

  return {
    enqueue, nextFrame, decodeFrame, configure, route, diagnostics,
    padToBucket, stripPadding, gaussianJitter, mimicHeaders,
    MODULE_UUID, MODULE_VERSION,
  };
}

module.exports = { createTrafficShaper, padToBucket, stripPadding, gaussianJitter, mimicHeaders, MODULE_UUID, MODULE_VERSION };
