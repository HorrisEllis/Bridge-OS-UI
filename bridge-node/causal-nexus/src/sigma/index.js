// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
/**
 * @module       sigma
 * @uuid         c3d4e5f6-a7b8-4c9d-0e1f-2a3b4c5d6e7f
 * @version      5.0.0
 *
 * Trajectory classifier (σ engine). Pure observer — no write path to event
 * store or causal graph. Output is never stored in event records.
 *
 * classify(kinematicWindow, featureTree?, constraintConfig?) → SigmaResult
 *
 * Input: a window of kinematic delta records from computeDeltaStream().
 * Output: regime classification with confidence, dominant cause, and timing.
 *
 * Five regimes:
 *   stable            — no signal above threshold
 *   degraded          — S (latencyImpact) >= slopeThreshold
 *   collapsing        — K (throughputChange acceleration) >= accelThreshold
 *   oscillatory       — O (latencyImpact sign flips) >= oscillationCount
 *   insufficient_data — window below minWindow
 *
 * Four feature axes (from delta module):
 *   S — latencyImpact:      z-score of inter-event gap (≥0)
 *   K — throughputChange:   signed rate delta (acceleration proxy)
 *   O — oscillation count:  sign flips in latencyImpact across window
 *   C — structuralDeviation:z-score of causal depth deviation
 *
 * Classification precedence:
 *   insufficient_data > collapsing > oscillatory > degraded > stable
 *   C (structural) is a dominant_cause modifier, not a primary regime driver.
 *   When C is the only signal above threshold in a stable window, dominant_cause = 'C'.
 *
 * constraintConfig is versioned and hot-swappable. All thresholds are fluid —
 * no consts buried in logic. Every threshold has a settings hook UUID.
 *
 * Invariants:
 *   - σ output is NEVER stored in event records or causal graph
 *   - Minimum window: 3 records — below that: insufficient_data
 *   - classify() is a pure function — same input always produces same output
 *
 * @hook c3d4e5f6-a7b8-4c9d-0e1f-2a3b4c5d6e7f  createSigmaEngine
 * @hook d4e5f6a7-b8c9-4d0e-1f2a-3b4c5d6e7f8a  classify
 * @hook e5f6a7b8-c9d0-4e1f-2a3b-4c5d6e7f8a9b  DEFAULT_CONSTRAINT_CONFIG
 * @hook f6a7b8c9-d0e1-4f2a-3b4c-5d6e7f8a9b0c  REGIMES
 * @hook a7b8c9d0-e1f2-4a3b-4c5d-6e7f8a9b0c1d  DOMINANT_CAUSES
 * @hook b8c9d0e1-f2a3-4b4c-5d6e-7f8a9b0c1d2e  computeFeatureTree
 *
 * Settings hooks (fluid constraintConfig values):
 * @hook sigma-minWindow        c9d0e1f2-a3b4-4c5d-6e7f-8a9b0c1d2e3f
 * @hook sigma-slopeThreshold   d0e1f2a3-b4c5-4d6e-7f8a-9b0c1d2e3f4a
 * @hook sigma-accelThreshold   e1f2a3b4-c5d6-4e7f-8a9b-0c1d2e3f4a5b
 * @hook sigma-oscillationCount f2a3b4c5-d6e7-4f8a-9b0c-1d2e3f4a5b6c
 * @hook sigma-depthDeviation   a3b4c5d6-e7f8-4a9b-0c1d-2e3f4a5b6c7d
 */

'use strict';

// ── Regime and cause constants ────────────────────────────────────────────────

/**
 * @hook f6a7b8c9-d0e1-4f2a-3b4c-5d6e7f8a9b0c  sigma:REGIMES
 */
export const REGIMES = Object.freeze({
  STABLE:            'stable',
  DEGRADED:          'degraded',
  COLLAPSING:        'collapsing',
  OSCILLATORY:       'oscillatory',
  INSUFFICIENT_DATA: 'insufficient_data',
});

/**
 * @hook a7b8c9d0-e1f2-4a3b-4c5d-6e7f8a9b0c1d  sigma:DOMINANT_CAUSES
 */
export const DOMINANT_CAUSES = Object.freeze({
  S: 'S',  // latencyImpact — temporal gap signal
  K: 'K',  // throughputChange — acceleration signal
  O: 'O',  // oscillation count — instability signal
  C: 'C',  // structuralDeviation — causal depth signal
});

// ── Default constraint config ─────────────────────────────────────────────────

/**
 * All thresholds are fluid — versioned constraintConfig, never buried consts.
 * Each has a registered settings hook UUID (see module header).
 *
 * @hook e5f6a7b8-c9d0-4e1f-2a3b-4c5d6e7f8a9b  sigma:DEFAULT_CONSTRAINT_CONFIG
 */
export const DEFAULT_CONSTRAINT_CONFIG = Object.freeze({
  version:          '4.5.2',
  minWindow:        3,      // @hook sigma-minWindow
  slopeThreshold:   0.3,    // @hook sigma-slopeThreshold   S → degraded
  accelThreshold:   0.5,    // @hook sigma-accelThreshold   K → collapsing
  oscillationCount: 3,      // @hook sigma-oscillationCount O → oscillatory
  depthDeviation:   2.0,    // @hook sigma-depthDeviation   C → structural flag
});

// ── computeFeatureTree ────────────────────────────────────────────────────────

/**
 * Derive S / K / O / C feature values from a kinematic window.
 *
 * S = max latencyImpact in window (peak gap signal)
 * K = max |throughputChange| in window (peak acceleration)
 * O = number of sign flips in latencyImpact sequence
 * C = max |structuralDeviation| in window (peak depth signal)
 *
 * Returns { S, K, O, C, meanS, meanK, meanC } — all non-negative.
 *
 * @hook b8c9d0e1-f2a3-4b4c-5d6e-7f8a9b0c1d2e  sigma:computeFeatureTree
 * @param {object[]} window — array of delta records from computeDeltaStream()
 * @returns {object} feature tree
 */
export function computeFeatureTree(window) {
  if (!window || window.length === 0) {
    return { S: 0, K: 0, O: 0, C: 0, meanS: 0, meanK: 0, meanC: 0 };
  }

  let maxS = 0, maxK = 0, maxC = 0;
  let sumS = 0, sumK = 0, sumC = 0;
  let oscCount = 0;
  let prevSign = 0; // sign of previous latencyImpact

  for (const d of window) {
    const s = typeof d.latencyImpact     === 'number' ? Math.abs(d.latencyImpact)     : 0;
    const k = typeof d.throughputChange  === 'number' ? Math.abs(d.throughputChange)  : 0;
    const c = typeof d.structuralDeviation === 'number' ? Math.abs(d.structuralDeviation) : 0;

    if (s > maxS) maxS = s;
    if (k > maxK) maxK = k;
    if (c > maxC) maxC = c;
    sumS += s; sumK += k; sumC += c;

    // Oscillation: sign flip in raw latencyImpact (not abs — negative↔positive counts)
    const rawL = typeof d.latencyImpact === 'number' ? d.latencyImpact : 0;
    const sign = rawL > 0 ? 1 : rawL < 0 ? -1 : 0;
    if (prevSign !== 0 && sign !== 0 && sign !== prevSign) oscCount++;
    if (sign !== 0) prevSign = sign;
  }

  const n = window.length;
  return {
    S:     r3(maxS),
    K:     r3(maxK),
    O:     oscCount,
    C:     r3(maxC),
    meanS: r3(sumS / n),
    meanK: r3(sumK / n),
    meanC: r3(sumC / n),
  };
}

// ── classify ──────────────────────────────────────────────────────────────────

/**
 * Classify a kinematic window into a regime.
 *
 * classify() is a pure function — same inputs always produce same output.
 * Output is NEVER stored in event records or the causal graph.
 *
 * @hook d4e5f6a7-b8c9-4d0e-1f2a-3b4c5d6e7f8a  sigma:classify
 *
 * @param {object[]} kinematicWindow    — delta records (computeDeltaStream output)
 * @param {object}   [featureTree]      — pre-computed feature tree (computed if omitted)
 * @param {object}   [constraintConfig] — fluid config (DEFAULT_CONSTRAINT_CONFIG if omitted)
 * @returns {SigmaResult} frozen classification result
 */
export function classify(kinematicWindow, featureTree = null, constraintConfig = null) {
  const cfg = _mergeConfig(constraintConfig);

  // Insufficient data — hard minimum
  if (!kinematicWindow || kinematicWindow.length < cfg.minWindow) {
    return _result(
      REGIMES.INSUFFICIENT_DATA, null, 0,
      kinematicWindow, cfg
    );
  }

  const ft = featureTree || computeFeatureTree(kinematicWindow);

  // ── Classification precedence ───────────────────────────────────────────
  // 1. Collapsing: K >= accelThreshold (strongest signal — rate collapse)
  if (ft.K >= cfg.accelThreshold) {
    return _result(
      REGIMES.COLLAPSING, DOMINANT_CAUSES.K,
      _confidence(ft.K, cfg.accelThreshold),
      kinematicWindow, cfg
    );
  }

  // 2. Oscillatory: O >= oscillationCount
  if (ft.O >= cfg.oscillationCount) {
    // Confidence: ratio of observed flips to threshold (clamped)
    const conf = Math.min(1, ft.O / cfg.oscillationCount);
    return _result(REGIMES.OSCILLATORY, DOMINANT_CAUSES.O, r3(conf), kinematicWindow, cfg);
  }

  // 3. Degraded: S >= slopeThreshold
  if (ft.S >= cfg.slopeThreshold) {
    // C may co-elevate — if C also above threshold, it's secondary in report
    return _result(
      REGIMES.DEGRADED, DOMINANT_CAUSES.S,
      _confidence(ft.S, cfg.slopeThreshold),
      kinematicWindow, cfg
    );
  }

  // 4. Structural flag: C >= depthDeviation while S/K/O are below thresholds
  //    Regime remains stable, but dominant_cause = C and confidence reflects it
  if (ft.C >= cfg.depthDeviation) {
    return _result(
      REGIMES.STABLE, DOMINANT_CAUSES.C,
      _confidence(ft.C, cfg.depthDeviation),
      kinematicWindow, cfg
    );
  }

  // 5. Stable: nothing above threshold
  return _result(REGIMES.STABLE, DOMINANT_CAUSES.S, 0, kinematicWindow, cfg);
}

// ── createSigmaEngine ─────────────────────────────────────────────────────────

/**
 * Factory returning a sigma engine instance with a bound constraintConfig.
 * The config is hot-swappable: call updateConfig(partial) at any time.
 * All classify() calls use the current config — no stale captures.
 *
 * @hook c3d4e5f6-a7b8-4c9d-0e1f-2a3b4c5d6e7f  sigma:createSigmaEngine
 *
 * @param {object} [initialConfig] — initial constraintConfig overrides
 * @returns {{ classify, updateConfig, getConfig, computeFeatureTree }}
 */
export function createSigmaEngine(initialConfig = {}) {
  let _config = _mergeConfig(initialConfig);

  function _classify(kinematicWindow, featureTree = null) {
    return classify(kinematicWindow, featureTree, _config);
  }

  /**
   * Hot-swap config fields. Partial update — unspecified fields unchanged.
   * Version must be updated by caller to signal the change.
   */
  function updateConfig(partial) {
    if (!partial || typeof partial !== 'object') {
      throw new Error('[sigma] updateConfig: partial must be an object');
    }
    _config = Object.freeze({ ..._config, ...partial });
    return _config;
  }

  function getConfig() { return _config; }

  return {
    classify:          _classify,
    updateConfig,
    getConfig,
    computeFeatureTree,
  };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function _mergeConfig(partial) {
  if (!partial) return DEFAULT_CONSTRAINT_CONFIG;
  return Object.freeze({ ...DEFAULT_CONSTRAINT_CONFIG, ...partial });
}

/**
 * Confidence: how strongly the feature value exceeds its threshold.
 * At threshold: 1.0. Double threshold: capped at 1.0.
 * Below threshold: proportional fraction.
 */
function _confidence(value, threshold) {
  if (threshold <= 0) return value > 0 ? 1.0 : 0;
  return r3(Math.min(1.0, value / threshold));
}

/**
 * Build the timing window from the kinematic records.
 */
function _windowRange(records) {
  if (!records || records.length === 0) return [0, 0];
  const first = records[0];
  const last  = records[records.length - 1];
  return [
    first.seq  ?? 0,
    last.seq   ?? 0,
  ];
}

function _durationTicks(records) {
  if (!records || records.length < 2) return 0;
  const firstTs = records[0].eventTs  ?? 0;
  const lastTs  = records[records.length - 1].eventTs ?? 0;
  return Math.max(0, lastTs - firstTs);
}

function _result(regime, dominantCause, confidence, records, cfg) {
  return Object.freeze({
    regime,
    confidence,
    dominant_cause:  dominantCause,
    duration_ticks:  _durationTicks(records),
    policy_version:  cfg.version,
    window:          Object.freeze(_windowRange(records)),
  });
}

function r3(n) { return Math.round(n * 1000) / 1000; }
