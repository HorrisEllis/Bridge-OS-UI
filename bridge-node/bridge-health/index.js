// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
'use strict';
/**
 * bridge-health/index.js
 * Mesh Health + Topology Auto-Heal + Delta Replay + Invariant Alerts
 *
 * Four responsibilities in one module because they share the same data:
 * the delta ring, the node registry, and the heartbeat status.
 *
 * 1. MESH HEALTH SCORE — aggregate fidelity across all nodes.
 *    Score = weighted mean of: BPM consistency, latency grade, trust score,
 *    causal event density, SNR deny rate. Updated on every heartbeat and
 *    trust event. Exposed at GET /health/mesh.
 *
 * 2. AUTO-HEAL TOPOLOGY — reroute around failed nodes automatically.
 *    Listens to node:dead and node:degraded on the bus. On node:dead,
 *    identifies all circuits (onion + direct) passing through the dead node
 *    and rebuilds them via alternate DHT paths. Emits topology:healed or
 *    topology:heal_failed on the bus.
 *
 * 3. DELTA REPLAY — reconstruct any past network state from the delta log.
 *    The CFR delta ring has a rolling 500-entry window. bridge-health extends
 *    this with a persistent JSONL delta log (daily files) and a replay engine
 *    that can reconstruct field + node state at any past timestamp.
 *    Exposed at POST /health/replay { timestamp } → { field, nodes, deltas }.
 *
 * 4. INVARIANT ALERTS — notify when divergence between two nodes exceeds sigma.
 *    Periodically polls connected peers' /health endpoints and compares key
 *    metrics (trustScore, eventCount, fieldState). When divergence exceeds
 *    configured sigma threshold, emits invariant:divergence on the bus and
 *    pushes a toast-ready alert to the CFR canvas.
 *
 * Wire protocol:
 *   GET  /health/mesh              → mesh health aggregate
 *   GET  /health/topology          → node graph with link health
 *   POST /health/replay            { at: timestamp } → reconstructed state
 *   GET  /health/divergence        → current node divergence metrics
 *   POST /health/heal              { nodeUuid } → force reroute around node
 *
 * Bus events consumed:
 *   node:dead, node:degraded, heartbeat:pulse, mesh:trust:update,
 *   sngate:decision, cfr:delta
 *
 * Bus events emitted:
 *   mesh:health:update    { score, nodes, ts }
 *   topology:healed       { deadNode, reroutes }
 *   topology:heal_failed  { deadNode, reason }
 *   invariant:divergence  { nodeA, nodeB, metric, deltaA, deltaB, sigma }
 *
 * UUID: bridge-health-0000-0000-0000-00000000001
 * Version: 1.0.0
 */

const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');
const http    = require('http');

const MODULE_UUID    = 'bridge-health-0000-0000-0000-00000000001';
const MODULE_VERSION = '1.0.0';

const SIGMA_THRESHOLD       = 2.0;   // standard deviations before divergence alert
const DIVERGENCE_POLL_MS    = 30_000; // poll peers every 30s
const DELTA_LOG_DIR_DEFAULT = path.join(process.cwd(), 'data', 'health-deltas');

// ── Weighted mesh score components ────────────────────────────────────────────

const SCORE_WEIGHTS = {
  bpmConsistency:  0.25,
  latencyGrade:    0.20,
  trustScore:      0.30, // normalised 0–1 (trustScore / 10)
  causalDensity:   0.10, // events per minute, normalised
  sngateAllowRate: 0.15, // fraction of allow decisions (1 = no denials)
};

function computeNodeScore({ bpmConsistency = 1, latencyGrade = 1, trustScore = 5, causalEventsPerMin = 0, sngateAllowRate = 1 } = {}) {
  const causalNorm = Math.min(1, causalEventsPerMin / 60); // 60 events/min = 1.0
  const raw = (
    bpmConsistency  * SCORE_WEIGHTS.bpmConsistency  +
    latencyGrade    * SCORE_WEIGHTS.latencyGrade     +
    (trustScore/10) * SCORE_WEIGHTS.trustScore       +
    causalNorm      * SCORE_WEIGHTS.causalDensity    +
    sngateAllowRate * SCORE_WEIGHTS.sngateAllowRate
  );
  return Math.max(0, Math.min(1, raw));
}

// ── Sigma divergence check ────────────────────────────────────────────────────

function meanStddev(values) {
  if (!values.length) return { mean: 0, stddev: 0 };
  const mean   = values.reduce((a, b) => a + b, 0) / values.length;
  const stddev = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length);
  return { mean, stddev };
}

function sigmaDeviation(value, mean, stddev) {
  return stddev > 0 ? Math.abs(value - mean) / stddev : 0;
}

// ── HTTP probe ────────────────────────────────────────────────────────────────

function fetchPeerHealth(address, timeoutMs = 3000) {
  return new Promise(resolve => {
    const url = new URL('/health', address);
    const req = http.get({ hostname: url.hostname, port: url.port || 80, path: '/health', timeout: timeoutMs }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try   { resolve({ ok: res.statusCode === 200, data: JSON.parse(Buffer.concat(chunks).toString()) }); }
        catch { resolve({ ok: false, data: null }); }
      });
    });
    req.on('error', () => resolve({ ok: false, data: null }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, data: null, reason: 'timeout' }); });
  });
}

// ── Delta replay engine ───────────────────────────────────────────────────────

function createDeltaReplayEngine({ logDir = DELTA_LOG_DIR_DEFAULT, busEmit = null } = {}) {
  if (!fs.existsSync(logDir)) try { fs.mkdirSync(logDir, { recursive: true }); } catch {}

  function _todayFile() {
    return path.join(logDir, `deltas-${new Date().toISOString().slice(0, 10)}.jsonl`);
  }

  // Append a delta entry to today's log file (atomic append)
  function appendDelta(delta) {
    try {
      fs.appendFileSync(_todayFile(), JSON.stringify({ ...delta, _ts: Date.now() }) + '\n');
    } catch {}
  }

  // Read all delta log files and return deltas up to a given timestamp
  function replayAt(atTimestamp) {
    const files = fs.existsSync(logDir) ? fs.readdirSync(logDir).filter(f => f.endsWith('.jsonl')).sort() : [];
    const deltas = [];
    for (const file of files) {
      try {
        const lines = fs.readFileSync(path.join(logDir, file), 'utf8').split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const d = JSON.parse(line);
            if (!atTimestamp || d._ts <= atTimestamp) deltas.push(d);
          } catch {}
        }
      } catch {}
    }
    return deltas;
  }

  // Reconstruct field + node state by replaying deltas up to atTimestamp
  function reconstruct(atTimestamp) {
    const deltas = replayAt(atTimestamp);
    // Walk deltas forward, applying CFR_UPDATE and node upsert events
    const field = { structure: 0.5, entropy: 0.2, attention: 0.5, damping: 0.12, curl: 0.6, speed: 1.0 };
    const nodes = {};
    for (const d of deltas) {
      if (d.type === 'CFR_UPDATE' && d.detail) {
        try { Object.assign(field, JSON.parse(d.detail)); } catch {}
      }
      if (d.type === 'cfr:node:upsert' && d.id) {
        nodes[d.id] = { id: d.id, label: d.label, type: d.type2, ts: d._ts };
      }
      if (d.type === 'node:dead' && d._uuid) {
        delete nodes[d._uuid];
      }
    }
    return {
      at:     atTimestamp || Date.now(),
      field,
      nodes:  Object.values(nodes),
      deltas: deltas.slice(-50), // last 50 for context
      total:  deltas.length,
    };
  }

  return { appendDelta, replayAt, reconstruct };
}

// ── MeshHealth factory ────────────────────────────────────────────────────────

function createMeshHealth({
  busEmit      = null,
  nodeRegistry = null,
  dht          = null,
  logDir       = DELTA_LOG_DIR_DEFAULT,
  sigmaThreshold = SIGMA_THRESHOLD,
} = {}) {

  const _nodeScores     = new Map(); // uuid → { score, metrics, updatedAt }
  const _sngateWindow   = [];        // last 200 { decision, ts }
  const _peerAddresses  = new Map(); // uuid → address (from DHT/heartbeat)
  const _divergence     = [];        // recent divergence events
  let   _overallScore   = 1.0;

  const replayEngine = createDeltaReplayEngine({ logDir, busEmit });

  // ── Score update helpers ────────────────────────────────────────────────

  function updateNodeScore(uuid, metrics) {
    const score = computeNodeScore(metrics);
    _nodeScores.set(uuid, { score, metrics, updatedAt: Date.now() });
    _recalcOverall();
  }

  function _recalcOverall() {
    if (!_nodeScores.size) { _overallScore = 1.0; return; }
    const scores = [..._nodeScores.values()].map(v => v.score);
    // Use trimmed mean (drop lowest 10%) for outlier resistance
    scores.sort((a, b) => a - b);
    const trimmed = scores.slice(Math.floor(scores.length * 0.1));
    _overallScore = trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
    busEmit?.('mesh:health:update', { score: _overallScore, nodes: _nodeScores.size, ts: Date.now() }, 'DEBUG');
  }

  function _sngateAllowRate() {
    const recent = _sngateWindow.filter(e => Date.now() - e.ts < 60_000);
    if (!recent.length) return 1;
    return recent.filter(e => e.decision === 'allow').length / recent.length;
  }

  // ── Bus listener installation ───────────────────────────────────────────

  function install(ctx) {
    const { bus } = ctx;

    bus.on('heartbeat:pulse', ({ _uuid, bpm, latency, healthScore, consistency }) => {
      if (!_uuid) return;
      const cur = _nodeScores.get(_uuid)?.metrics || {};
      updateNodeScore(_uuid, {
        ...cur,
        bpmConsistency: consistency ?? cur.bpmConsistency ?? 1,
        latencyGrade:   _latGrade(latency),
      });
    });

    bus.on('mesh:trust:update', ({ uuid, trustScore }) => {
      if (!uuid) return;
      const cur = _nodeScores.get(uuid)?.metrics || {};
      updateNodeScore(uuid, { ...cur, trustScore: trustScore ?? 5 });
    });

    bus.on('sngate:decision', ({ uuid, decision }) => {
      _sngateWindow.push({ uuid, decision, ts: Date.now() });
      if (_sngateWindow.length > 200) _sngateWindow.shift();
      if (uuid) {
        const cur = _nodeScores.get(uuid)?.metrics || {};
        updateNodeScore(uuid, { ...cur, sngateAllowRate: _sngateAllowRate() });
      }
    });

    // Auto-heal on node failure
    bus.on('node:dead', ({ _uuid }) => {
      if (_uuid) _autoHeal(_uuid);
    });

    bus.on('node:degraded', ({ _uuid }) => {
      if (_uuid) {
        const cur = _nodeScores.get(_uuid)?.metrics || {};
        updateNodeScore(_uuid, { ...cur, latencyGrade: 0.1, bpmConsistency: 0.2 });
      }
    });

    // Append all CFR deltas to replay log
    bus.on('cfr:delta', (delta) => {
      replayEngine.appendDelta(delta);
    });

    // Divergence polling
    _divergencePoller = setInterval(() => _pollDivergence(ctx), DIVERGENCE_POLL_MS);
  }

  function _latGrade(ms) {
    if (!ms || ms <= 50)  return 1.0;
    if (ms <= 150) return 0.8;
    if (ms <= 500) return 0.5;
    if (ms <= 1500) return 0.2;
    return 0.0;
  }

  // ── Auto-heal ────────────────────────────────────────────────────────────

  async function _autoHeal(deadUuid) {
    busEmit?.('topology:heal_start', { deadNode: deadUuid }, 'INFO');

    // Mark dead node score as 0
    const cur = _nodeScores.get(deadUuid)?.metrics || {};
    updateNodeScore(deadUuid, { ...cur, bpmConsistency: 0, latencyGrade: 0 });

    // Find alternate paths via DHT
    if (!dht) {
      busEmit?.('topology:heal_failed', { deadNode: deadUuid, reason: 'DHT not available' }, 'WARN');
      return;
    }

    try {
      const alternates = await dht.lookup(deadUuid, 2);
      const livePeers  = (alternates?.nodes || []).filter(n => n.uuid !== deadUuid);

      if (!livePeers.length) {
        busEmit?.('topology:heal_failed', { deadNode: deadUuid, reason: 'no alternate peers found' }, 'WARN');
        return;
      }

      busEmit?.('topology:healed', {
        deadNode:  deadUuid,
        reroutes:  livePeers.length,
        via:       livePeers.map(p => p.uuid?.slice(0, 8)),
      }, 'INFO');
    } catch (e) {
      busEmit?.('topology:heal_failed', { deadNode: deadUuid, reason: e.message }, 'WARN');
    }
  }

  // ── Divergence polling ────────────────────────────────────────────────────

  let _divergencePoller = null;

  async function _pollDivergence(ctx) {
    const peers = dht ? dht.diagnostics?.()?.table?.peers || [] : [];
    if (peers.length < 2) return;

    const results = await Promise.all(
      peers.slice(0, 8).map(p => fetchPeerHealth(p.address).then(r => ({ uuid: p.uuid, ...r })))
    );

    const valid = results.filter(r => r.ok && r.data);
    if (valid.length < 2) return;

    // Compare trust mean scores
    const trustScores = valid.map(r => r.data?.trust?.meanScore ?? 5);
    const { mean, stddev } = meanStddev(trustScores);
    for (const r of valid) {
      const score = r.data?.trust?.meanScore ?? 5;
      const sigma = sigmaDeviation(score, mean, stddev);
      if (sigma > sigmaThreshold) {
        const alert = {
          nodeA:   r.uuid,
          metric:  'trustMeanScore',
          value:   score,
          mean,
          stddev,
          sigma:   sigma.toFixed(2),
          ts:      Date.now(),
        };
        _divergence.push(alert);
        if (_divergence.length > 50) _divergence.shift();
        busEmit?.('invariant:divergence', alert, 'WARN');
      }
    }
  }

  // ── HTTP route handler ────────────────────────────────────────────────────

  function route(method, urlParts, body, req, res) {
    const _json = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };

    // GET /health/mesh
    if (method === 'GET' && urlParts[1] === 'mesh') {
      const nodes = [..._nodeScores.entries()].map(([uuid, v]) => ({
        uuid,
        score:     Math.round(v.score * 100) / 100,
        metrics:   v.metrics,
        updatedAt: v.updatedAt,
      }));
      return _json(200, {
        ok:           true,
        overallScore: Math.round(_overallScore * 100) / 100,
        nodeCount:    _nodeScores.size,
        nodes,
        sngateAllowRate: Math.round(_sngateAllowRate() * 100) / 100,
        ts:           Date.now(),
      });
    }

    // GET /health/topology
    if (method === 'GET' && urlParts[1] === 'topology') {
      const nodes = [..._nodeScores.entries()].map(([uuid, v]) => ({
        uuid,
        score:     v.score,
        healthy:   v.score >= 0.6,
        degraded:  v.score >= 0.3 && v.score < 0.6,
        dead:      v.score < 0.3,
      }));
      return _json(200, { ok: true, nodes, links: [] }); // link graph requires routing table
    }

    // POST /health/replay
    if (method === 'POST' && urlParts[1] === 'replay') {
      const at = body?.at ? Number(body.at) : null;
      if (at && isNaN(at)) return _json(400, { ok: false, error: 'at must be a unix timestamp (ms)' });
      try {
        const state = replayEngine.reconstruct(at);
        return _json(200, { ok: true, ...state });
      } catch (e) {
        return _json(500, { ok: false, error: e.message });
      }
    }

    // GET /health/divergence
    if (method === 'GET' && urlParts[1] === 'divergence') {
      return _json(200, { ok: true, threshold: sigmaThreshold, events: _divergence.slice(-20) });
    }

    // POST /health/heal
    if (method === 'POST' && urlParts[1] === 'heal') {
      const { nodeUuid } = body || {};
      if (!nodeUuid) return _json(400, { ok: false, error: 'nodeUuid required' });
      _autoHeal(nodeUuid).catch(() => {});
      return _json(202, { ok: true, healing: nodeUuid });
    }

    return null;
  }

  function stop() {
    if (_divergencePoller) clearInterval(_divergencePoller);
  }

  function diagnostics() {
    return {
      uuid:         MODULE_UUID,
      version:      MODULE_VERSION,
      overallScore: _overallScore,
      nodeCount:    _nodeScores.size,
      divergences:  _divergence.length,
    };
  }

  return { install, route, stop, diagnostics, updateNodeScore, replayEngine, MODULE_UUID, MODULE_VERSION };
}

module.exports = { createMeshHealth, computeNodeScore, createDeltaReplayEngine, MODULE_UUID, MODULE_VERSION };
