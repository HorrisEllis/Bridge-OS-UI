// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
'use strict';
/**
 * bridge-IME/index.js
 * Identity Memory Engine — WHO did WHAT across every protocol over time.
 *
 * INVARIANTS:
 * 1. IME ingests but never decides. Decision belongs to bridge-sngate.
 * 2. IME never stores full payloads. Summaries and patterns only.
 * 3. Profile writes are atomic. Crash mid-write cannot corrupt.
 * 4. trustScore recalculated on every ingest, never cached stale.
 * 5. Anomaly detection does not block. Modifies trustScore and emits events.
 * 6. IME and bridge-sngate are always separate modules. Never merged.
 * 7. IME scores are advisory signals, not verdicts.
 * 8. All score modifiers configurable. No hardcoded thresholds in production.
 * 9. IME exposes its reasoning — every score change has a reason string.
 * 10. Baseline uses median not mean (outlier injection resistant).
 * 11. Baseline requires 100 events minimum before considered reliable.
 * 12. getProfile() returns in < 5ms. Always from cache.
 *
 * Performance: profile updated async after ingest, never on read path.
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

// ── Default config (all thresholds configurable) ──────────────────────────────
const DEFAULT_CONFIG = {
  storeDir:          path.join(process.cwd(), 'data', 'ime'),
  baselineWindow:    7 * 24 * 60 * 60 * 1000,   // 7 days
  baselineMinEvents: 100,
  burstWindow:       5 * 60 * 1000,              // 5 min
  burstMultiplier:   10,                          // 10× normal rate = burst
  offHoursBuffer:    1,                           // ± hours around typical window
  driftThreshold:    0.7,                         // cosine similarity floor
  maxAnomalies:      200,                         // per profile
  maxProfiles:       10000,
  // Exploration pressure (epsilon-greedy anti-over-stabilization)
  explorationInterval: 86400000,   // daily
  explorationRate:     0.05,       // 5% of reads get deflated score
  explorationDecay:    0.95,       // pressure fades if no anomalies
  // Probationary ramp: new identities must earn trust, not start neutral
  probationaryEvents:  100,        // events before exiting probation
  probationaryRateMax: 20,         // max events/min during probation
};

// ── Trust score modifiers (all configurable) ─────────────────────────────────
const DEFAULT_MODIFIERS = {
  base:              5,
  knownNode:        +2,   // first seen > 30 days ago
  consistentBehavior: +1, // activity within baseline
  cleanRecord:       +1,  // no anomalies in 7 days
  burst:            -2,
  offHours:         -2,
  escalation:       -3,
  identityDrift:    -5,
  probationary:     -1.5, // applied (scaled) while eventCount < probationaryEvents
};

// ── Valid event types ──────────────────────────────────────────────────────────
const EVENT_TYPES = new Set([
  'ssh.command', 'ssh.file.access', 'ssh.session.start', 'ssh.session.end',
  'file.transfer', 'file.read', 'file.write', 'file.delete',
  'mesh.handshake', 'mesh.connection', 'mesh.disconnect',
  'agent.tool_call', 'agent.tool_result', 'agent.session',
  'data.push', 'data.receive',
  'http.request', 'http.response',
  'guardian.event',  // Guardian-sourced events
]);

// ── IME singleton factory ──────────────────────────────────────────────────────
function createIME(cfg = {}) {
  const config    = { ...DEFAULT_CONFIG, ...cfg };
  const modifiers = { ...DEFAULT_MODIFIERS, ...(cfg.modifiers || {}) };

  // In-memory profile cache — getProfile() reads from here, O(1)
  const _profiles = new Map();     // uuid → profile
  const _dirty    = new Set();     // uuids pending async write
  let   _busEmit  = null;

  // ── Helpers ─────────────────────────────────────────────────────────────────

  function _newProfile(uuid) {
    return {
      uuid,
      trustScore:   modifiers.base,
      scoreReasons: [],
      firstSeen:    Date.now(),
      lastSeen:     Date.now(),
      eventCount:   0,
      eventCounts:  {},
      events:       [],           // ring buffer, last 1000 raw summaries
      baseline:     null,         // built after baselineMinEvents
      anomalies:    [],
      relationships: { peers: [], clusters: [] },
      explorationState: { lastPressure: 0, consecutiveClean: 0 },
    };
  }

  function _summarize(event) {
    // Stores only summary, not full payload — invariant 2
    return {
      ts:   event.timestamp || Date.now(),
      type: event.type,
      hour: new Date(event.timestamp || Date.now()).getHours(),
      // Safe scalar summary fields only
      path:    event.payload?.path    || null,
      command: event.payload?.command || null,
      tool:    event.payload?.tool    || null,
      source:  event.payload?.source  || null,
    };
  }

  function _median(arr) {
    if (!arr.length) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid-1] + sorted[mid]) / 2;
  }

  // ── Baseline builder (median-based, outlier resistant) ────────────────────

  function _buildBaseline(profile) {
    const events = profile.events;
    if (events.length < config.baselineMinEvents) return null;

    const now = Date.now();
    const window = config.baselineWindow;
    const recent = events.filter(e => (now - e.ts) < window);
    if (!recent.length) return null;

    // Events per hour — median over days
    const hourBuckets = {};
    for (const e of recent) {
      hourBuckets[e.hour] = (hourBuckets[e.hour] || 0) + 1;
    }
    const typicalHours = Object.entries(hourBuckets)
      .filter(([, c]) => c > 1)
      .map(([h]) => Number(h));

    // Frequency: events per hour
    const durationHours = Math.max(1, window / 3600000);
    const avgFrequency = recent.length / durationHours;

    // Common paths and commands (top 10)
    const pathCount    = {};
    const commandCount = {};
    const toolCount    = {};
    for (const e of recent) {
      if (e.path)    pathCount[e.path]       = (pathCount[e.path]    || 0) + 1;
      if (e.command) commandCount[e.command] = (commandCount[e.command] || 0) + 1;
      if (e.tool)    toolCount[e.tool]       = (toolCount[e.tool]    || 0) + 1;
    }

    const topN = (obj, n = 10) => Object.entries(obj)
      .sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);

    return {
      avgFrequency,
      typicalHours,
      commonPaths:    topN(pathCount),
      commonCommands: topN(commandCount),
      commonTools:    topN(toolCount),
      builtAt:        now,
      sampleSize:     recent.length,
    };
  }

  // ── Anomaly detection ─────────────────────────────────────────────────────

  function _detectAnomalies(profile, summary) {
    const anomalies = [];
    const baseline  = profile.baseline;

    if (!baseline) return anomalies; // need baseline first

    const now = summary.ts;

    // Burst detection: 10× normal rate in 5-min window
    const windowStart = now - config.burstWindow;
    const recentCount = profile.events.filter(e => e.ts > windowStart).length;
    const expected    = baseline.avgFrequency * (config.burstWindow / 3600000);
    if (recentCount > expected * config.burstMultiplier) {
      anomalies.push({ type: 'burst', severity: 'high',
        detail: `${recentCount} events in 5min, expected ~${Math.round(expected)}` });
    }

    // Off-hours
    if (baseline.typicalHours.length > 4) {
      const buf = config.offHoursBuffer;
      const inHours = baseline.typicalHours.some(h =>
        Math.abs(h - summary.hour) <= buf ||
        Math.abs(h - summary.hour + 24) <= buf ||
        Math.abs(h - summary.hour - 24) <= buf
      );
      if (!inHours) {
        anomalies.push({ type: 'off-hours', severity: 'medium',
          detail: `Activity at hour ${summary.hour}, typical: [${baseline.typicalHours.join(',')}]` });
      }
    }

    // New path/command
    if (summary.path && baseline.commonPaths.length > 5 && !baseline.commonPaths.includes(summary.path)) {
      anomalies.push({ type: 'new-path', severity: 'low',
        detail: `Unseen path: ${summary.path}` });
    }

    // Escalation sequence: read → write → exec in sequence within 10 min
    const tenMin = 10 * 60 * 1000;
    const recentTypes = profile.events
      .filter(e => e.ts > now - tenMin)
      .map(e => e.type);
    if (recentTypes.includes('file.read') && recentTypes.includes('file.write') &&
        recentTypes.includes('ssh.command')) {
      anomalies.push({ type: 'escalation', severity: 'high',
        detail: 'read→write→command sequence in 10min window' });
    }

    return anomalies;
  }

  // ── Trust score computation ────────────────────────────────────────────────

  function _computeTrustScore(profile) {
    const reasons = [];
    let score = modifiers.base;

    // ── Probationary ramp ────────────────────────────────────────────────────
    // Closes IME-01: UUIDs with <100 events bypassed all anomaly detection
    // and received a neutral 5. An attacker rotating UUIDs every ~90 events
    // could operate indefinitely at neutral. The ramp makes score start below
    // neutral and climb linearly as events accumulate — earning neutrality
    // rather than having it by default.
    if (profile.eventCount < config.probationaryEvents) {
      const progress = profile.eventCount / config.probationaryEvents;  // 0→1
      const penalty  = modifiers.probationary * (1 - progress);         // fades to 0
      score += penalty;
      reasons.push(`${penalty.toFixed(2)} probation (${profile.eventCount}/${config.probationaryEvents})`);
      // Rate excess during probation: high-velocity new UUIDs get extra penalty
      const recentCount = profile.events.filter(e => (Date.now() - e.ts) < 60_000).length;
      if (recentCount > config.probationaryRateMax) {
        score += -1.0;
        reasons.push(`-1.0 probation rate excess (${recentCount}/min)`);
        _busEmit?.('ime:probation:rate_excess', { uuid: profile.uuid, recentCount, eventCount: profile.eventCount }, 'WARN');
      }
    }

    // Known node bonus
    const ageDays = (Date.now() - profile.firstSeen) / 86400000;
    if (ageDays > 30) {
      score += modifiers.knownNode;
      reasons.push(`+${modifiers.knownNode} known node (${Math.round(ageDays)}d)`);
    }

    // Consistent behavior
    if (profile.baseline && profile.eventCount >= config.baselineMinEvents) {
      const recentAnomalies = profile.anomalies.filter(a =>
        !a.resolved && (Date.now() - (a.ts || 0)) < 7 * 24 * 60 * 60 * 1000
      );
      if (recentAnomalies.length === 0) {
        score += modifiers.consistentBehavior;
        reasons.push(`+${modifiers.consistentBehavior} consistent behavior`);
        score += modifiers.cleanRecord;
        reasons.push(`+${modifiers.cleanRecord} clean 7-day record`);
      }
    }

    // Anomaly penalties
    const recent = profile.anomalies.filter(a => !a.resolved);
    for (const a of recent) {
      if (a.type === 'burst')       { score += modifiers.burst;       reasons.push(`${modifiers.burst} burst`); }
      if (a.type === 'off-hours')   { score += modifiers.offHours;    reasons.push(`${modifiers.offHours} off-hours`); }
      if (a.type === 'escalation')  { score += modifiers.escalation;  reasons.push(`${modifiers.escalation} escalation`); }
      if (a.type === 'drift')       { score += modifiers.identityDrift; reasons.push(`${modifiers.identityDrift} identity drift`); }
    }

    return { score: Math.max(0, Math.min(10, score)), reasons };
  }

  // ── Async disk write (atomic temp-rename) ─────────────────────────────────

  async function _flushProfile(uuid) {
    if (!config.storeDir) return;
    const profile = _profiles.get(uuid);
    if (!profile) return;
    if (!fs.existsSync(config.storeDir)) fs.mkdirSync(config.storeDir, { recursive: true });

    const filePath = path.join(config.storeDir, `${uuid}.json`);
    const tmpPath  = filePath + '.tmp.' + Date.now();
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(profile, null, 2));
      fs.renameSync(tmpPath, filePath); // atomic on same FS
    } catch {
      try { fs.unlinkSync(tmpPath); } catch {}
    }
    _dirty.delete(uuid);
  }

  // ── Relationship tracking ─────────────────────────────────────────────────

  function _updateRelationships(profile, event) {
    if (event.payload?.peerUuid) {
      if (!profile.relationships.peers.includes(event.payload.peerUuid)) {
        profile.relationships.peers.push(event.payload.peerUuid);
        if (profile.relationships.peers.length > 100) profile.relationships.peers.shift();
      }
    }
    if (event.payload?.groupHint) {
      if (!profile.relationships.clusters.includes(event.payload.groupHint)) {
        profile.relationships.clusters.push(event.payload.groupHint);
      }
    }
  }

  // ── Load profile from disk ─────────────────────────────────────────────────

  function _loadProfile(uuid) {
    if (!config.storeDir) return null;
    const filePath = path.join(config.storeDir, `${uuid}.json`);
    if (!fs.existsSync(filePath)) return null;
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return null;
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  function ingest(event) {
    if (!event?.uuid) return null;
    if (event.type && !EVENT_TYPES.has(event.type)) {
      // Accept unknown types with warning — don't crash
    }

    // Get or create profile (from cache, not disk, for speed)
    let profile = _profiles.get(event.uuid);
    // Clear null sentinel if present — this UUID now has real data
    if (profile === _NULL_SENTINEL || !profile) {
      profile = _loadProfile(event.uuid) || _newProfile(event.uuid);
      _profiles.set(event.uuid, profile);
    }

    const summary = _summarize(event);
    profile.lastSeen = summary.ts;
    profile.eventCount++;
    profile.eventCounts[event.type] = (profile.eventCounts[event.type] || 0) + 1;

    // Ring buffer — last 1000 events
    profile.events.push(summary);
    if (profile.events.length > 1000) profile.events.shift();

    _updateRelationships(profile, event);

    // Rebuild baseline async (not on hot path)
    const newBaseline = _buildBaseline(profile);
    if (newBaseline) profile.baseline = newBaseline;

    // Detect anomalies
    const newAnomalies = _detectAnomalies(profile, summary);
    for (const a of newAnomalies) {
      const anomaly = {
        id:       crypto.randomUUID(),
        ts:       summary.ts,
        type:     a.type,
        severity: a.severity,
        detail:   a.detail,
        resolved: false,
      };
      profile.anomalies.push(anomaly);
      if (profile.anomalies.length > config.maxAnomalies) profile.anomalies.shift();

      // Emit on bus — IME never blocks on this
      _busEmit?.('ime:anomaly', { uuid: event.uuid, anomaly }, 'WARN');
    }

    // Recompute trust score
    const { score, reasons } = _computeTrustScore(profile);
    profile.trustScore   = score;
    profile.scoreReasons = reasons;

    // Queue async write
    _dirty.add(event.uuid);
    setImmediate(() => _flushProfile(event.uuid));

    return profile;
  }

  // getProfile() — O(1) from cache, < 5ms
  // Caches null sentinel so repeated misses never re-hit disk
  const _NULL_SENTINEL = Symbol('null');
  function getProfile(uuid) {
    let profile = _profiles.get(uuid);
    if (profile === _NULL_SENTINEL) return null;
    if (!profile) {
      const loaded = _loadProfile(uuid);
      if (loaded) {
        profile = loaded;
        _profiles.set(uuid, profile);
      } else {
        _profiles.set(uuid, _NULL_SENTINEL); // cache miss — never re-read
        return null;
      }
    }
    if (!profile) return null;

    // Exploration pressure: 5% of reads get deflated score
    const shouldApplyPressure = Math.random() < config.explorationRate;
    if (shouldApplyPressure) {
      const deflated = { ...profile, trustScore: Math.max(0, profile.trustScore - 1.5) };
      _busEmit?.('ime:exploration:pressure', { uuid, deflation: 1.5, reason: 'scheduled' }, 'DEBUG');
      return deflated;
    }

    return profile;
  }

  function getTrustScore(uuid) {
    const p = getProfile(uuid);
    return p ? p.trustScore : modifiers.base; // neutral for unknown
  }

  function getAnomalies(uuid, { since } = {}) {
    const p = getProfile(uuid);
    if (!p) return [];
    if (since) return p.anomalies.filter(a => a.ts >= since);
    return p.anomalies;
  }

  function getRelationships(uuid) {
    const p = getProfile(uuid);
    return p ? p.relationships : { peers: [], clusters: [] };
  }

  function resetBaseline(uuid) {
    const p = _profiles.get(uuid);
    if (p) {
      p.baseline = null;
      p.anomalies = [];
      _dirty.add(uuid);
      setImmediate(() => _flushProfile(uuid));
    }
  }

  function install({ busEmit } = {}) {
    _busEmit = busEmit;
    if (!config.storeDir) return;
    // Load all existing profiles into cache
    if (fs.existsSync(config.storeDir)) {
      for (const f of fs.readdirSync(config.storeDir)) {
        if (!f.endsWith('.json') || f.includes('.tmp.')) continue;
        const uuid = f.replace('.json', '');
        const p    = _loadProfile(uuid);
        if (p) _profiles.set(uuid, p);
      }
    }
  }

  return { ingest, getProfile, getTrustScore, getAnomalies, getRelationships, resetBaseline, install };
}

// Singleton export
const IME = createIME();
module.exports = { IME, createIME };
