// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
'use strict';
/**
 * bridge-heartbeat/index.js
 * Pulse. Every node proves it's alive by beating. Silence = dead.
 *
 * - UDP pulse broadcast on LAN :7777 (discovery)
 * - HTTP health check every N ms (liveness)
 * - BPM calculation from inter-beat intervals
 * - Health score: BPM_consistency × SNR_fidelity × latency_grade
 * - 3 missed beats → node:degraded
 * - 10 missed beats → node:dead
 *
 * LAN Trust Invariant: pulse discovery ≠ trust increase.
 * A node discovered via LAN still requires full signed handshake.
 * Proximity is not a credential.
 */

const dgram  = require('dgram');
const http   = require('http');
const https  = require('https');
const crypto = require('crypto');

const DEFAULTS = {
  pulsePort:      7777,
  pulseInterval:  5000,    // ms between beats
  healthEndpoint: '/health',
  healthTimeout:  3000,
  degradeAt:      3,       // missed beats before degraded
  deadAt:         10,      // missed beats before dead
  bpmWindow:      10,      // last N intervals for BPM average
};

// ── BPM tracker ───────────────────────────────────────────────────────────────
function createBPMTracker(windowSize = 10) {
  const intervals = [];
  let lastBeatTs  = null;

  function beat() {
    const now = Date.now();
    if (lastBeatTs !== null) {
      intervals.push(now - lastBeatTs);
      if (intervals.length > windowSize) intervals.shift();
    }
    lastBeatTs = now;
    return bpm();
  }

  function bpm() {
    if (intervals.length === 0) return 0;
    const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    return avg > 0 ? Math.round(60000 / avg) : 0;
  }

  function consistency() {
    if (intervals.length < 2) return 1.0;
    const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    const variance = intervals.reduce((s, v) => s + Math.pow(v - avg, 2), 0) / intervals.length;
    const stddev = Math.sqrt(variance);
    // Consistency 0–1: lower stddev relative to avg = more consistent
    return Math.max(0, Math.min(1, 1 - (stddev / Math.max(avg, 1))));
  }

  return { beat, bpm, consistency, intervals: () => [...intervals] };
}

// ── Health check (HTTP GET /health) ──────────────────────────────────────────
function checkHealth(url, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const t0      = Date.now();
    const client  = url.startsWith('https') ? https : http;
    const parsed  = new URL(url);
    const req     = client.get({
      hostname: parsed.hostname,
      port:     parsed.port || (url.startsWith('https') ? 443 : 80),
      path:     parsed.pathname || '/health',
      timeout:  timeoutMs,
    }, (res) => {
      const latency = Date.now() - t0;
      resolve({
        ok:      res.statusCode === 200,
        status:  res.statusCode,
        latency,
      });
      res.resume();
    });
    req.on('error',   () => resolve({ ok: false, latency: Date.now() - t0 }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, latency: timeoutMs }); });
  });
}

// ── Latency grade 0–1 ─────────────────────────────────────────────────────────
function latencyGrade(ms) {
  if (ms <= 50)  return 1.0;
  if (ms <= 150) return 0.8;
  if (ms <= 500) return 0.5;
  if (ms <= 1500) return 0.2;
  return 0.0;
}

// ── Pulse emitter (UDP broadcast) ─────────────────────────────────────────────
function createPulseEmitter({ uuid, publicKeyB64, groupHint = null, port = DEFAULTS.pulsePort, identity = null }) {
  let _socket   = null;
  let _interval = null;

  function start(intervalMs = DEFAULTS.pulseInterval) {
    _socket = dgram.createSocket('udp4');
    _socket.bind(() => {
      _socket.setBroadcast(true);
      _interval = setInterval(_pulse, intervalMs);
      _pulse(); // immediate first pulse
    });
    _socket.on('error', (e) => {
      if (!e.message.includes('EADDRINUSE')) console.error('[heartbeat] UDP error:', e.message);
    });
  }

  function _pulse() {
    if (!_socket) return;
    const payload = JSON.stringify({
      type:      'nexus:pulse',
      uuid,
      publicKey: publicKeyB64,
      groupHint,
      ts:        Date.now(),
      sig:       identity ? identity.sign(String(Date.now())) : null,
    });
    const buf = Buffer.from(payload);
    _socket.send(buf, 0, buf.length, port, '255.255.255.255', () => {});
  }

  function stop() {
    clearInterval(_interval);
    _socket?.close();
    _socket = null;
  }

  return { start, stop };
}

// ── Pulse listener ────────────────────────────────────────────────────────────
function createPulseListener({ port = DEFAULTS.pulsePort, onPulse } = {}) {
  let _socket = null;

  function start() {
    _socket = dgram.createSocket('udp4');
    _socket.on('message', (msg, rinfo) => {
      try {
        const data = JSON.parse(msg.toString());
        if (data.type !== 'nexus:pulse') return;
        onPulse?.({ ...data, address: rinfo.address });
      } catch {}
    });
    _socket.on('error', () => {});
    _socket.bind(port);
  }

  function stop() {
    _socket?.close();
    _socket = null;
  }

  return { start, stop };
}

// ── HeartbeatManager ──────────────────────────────────────────────────────────
function createHeartbeatManager({ cfg = {}, busEmit = null, nodeRegistry = null, identity = null } = {}) {
  const config   = { ...DEFAULTS, ...cfg };
  const _nodes   = new Map();  // uuid → { bpm, missedBeats, healthUrl, timer }

  function register(uuid, healthUrl) {
    if (_nodes.has(uuid)) return;
    const bpmTracker = createBPMTracker(config.bpmWindow);
    _nodes.set(uuid, {
      uuid,
      healthUrl,
      bpmTracker,
      missedBeats:   0,
      lastLatencyMs: null,
      healthScore:   1.0,
      timer:         null,
    });
    _startMonitor(uuid);
  }

  function unregister(uuid) {
    const n = _nodes.get(uuid);
    if (n?.timer) clearInterval(n.timer);
    _nodes.delete(uuid);
  }

  function _startMonitor(uuid) {
    const node = _nodes.get(uuid);
    if (!node) return;
    node.timer = setInterval(async () => {
      const { ok, latency } = await checkHealth(node.healthUrl, config.healthTimeout);
      node.lastLatencyMs = latency;

      if (ok) {
        const bpm  = node.bpmTracker.beat();
        const cons = node.bpmTracker.consistency();
        const lgrd = latencyGrade(latency);

        // health score = BPM_consistency × latency_grade (0–1)
        node.healthScore = cons * lgrd;
        node.missedBeats = 0;

        nodeRegistry?.seen(uuid);

        busEmit?.('heartbeat:pulse', {
          _uuid:    uuid,
          uuid,
          bpm,
          latency,
          healthScore: node.healthScore,
          consistency: cons,
        }, 'DEBUG');

      } else {
        node.missedBeats++;
        // Single registry call with explicit thresholds — registry emits state transitions
        nodeRegistry?.missedBeat(uuid, { degradeAt: config.degradeAt, deadAt: config.deadAt });

        if (node.missedBeats === config.degradeAt) {
          busEmit?.('node:degraded', { _uuid: uuid, uuid, missedBeats: node.missedBeats }, 'WARN');
        }
        if (node.missedBeats >= config.deadAt) {
          // heartbeat ONLY detects and signals. It never mutates registry directly.
          // boot.js listens to 'node:dead' → calls nodeRegistry.evict(uuid).
          // nodeRegistry.evict() emits 'node:evicted' and removes from its ledger.
          // This is the single authority chain: heartbeat → bus → boot → registry.
          busEmit?.('node:dead', { _uuid: uuid, uuid, missedBeats: node.missedBeats, reason: 'missed_beats' }, 'ERROR');
          unregister(uuid); // clean heartbeat-internal state only
        }
      }
    }, config.pulseInterval);
  }

  function getStatus(uuid) {
    const n = _nodes.get(uuid);
    if (!n) return null;
    return {
      uuid,
      bpm:          n.bpmTracker.bpm(),
      consistency:  n.bpmTracker.consistency(),
      missedBeats:  n.missedBeats,
      latency:      n.lastLatencyMs,
      healthScore:  n.healthScore,
    };
  }

  function listNodes() {
    return [..._nodes.keys()].map(getStatus);
  }

  return { register, unregister, getStatus, listNodes };
}

module.exports = { createHeartbeatManager, createPulseEmitter, createPulseListener, createBPMTracker, checkHealth, latencyGrade };
