// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
/**
 * @module       clip
 * @uuid         d2e3f4a5-b6c7-4d8e-9f0a-1b2c3d4e5f6a
 * @version      5.0.0
 *
 * Bounded causal subgraph extraction, replay, and stability validation.
 *
 * Three entry points:
 *   snapshotRange(kernel, opts)         → NEX-CLIP artifact
 *   restoreClip(clip, params?, opts?)   → ReplayContext
 *   validateClipStability(clip, deltas, thresholds?) → StabilityValidationResult
 *
 * NEX-CLIP format:
 *   magic, fmt, kernelVersion, clipId, seqRange, entryEvents, exitEvents,
 *   parameters, stabilityProfile, snapshot (embedded NEX-SNAP), eventCount
 *
 * Stability profile is the validation contract:
 *   meanGap / sigmaGap / deltaSlope measured at extraction time.
 *   validateClipStability() compares live gaps against the profile.
 *
 * @hook d2e3f4a5-b6c7-4d8e-9f0a-1b2c3d4e5f6a  snapshotRange
 * @hook e3f4a5b6-c7d8-4e9f-0a1b-2c3d4e5f6a7b  restoreClip
 * @hook f4a5b6c7-d8e9-4f0a-1b2c-3d4e5f6a7b8c  validateClipStability
 * @hook a5b6c7d8-e9f0-4a1b-2c3d-4e5f6a7b8c9d  computeStabilityProfile
 * @hook b6c7d8e9-f0a1-4b2c-3d4e-5f6a7b8c9d0e  CLIP_MAGIC
 * @hook c7d8e9f0-a1b2-4c3d-4e5f-6a7b8c9d0e1f  DEFAULT_STABILITY_THRESHOLDS
 */

'use strict';

import { newEventId }                 from '../identity/index.js';
import { createKernel }               from '../kernel/index.js';
import { snapshot as kernelSnapshot } from '../compress/index.js';
import { createReplayContext }        from '../context/index.js';
import { computeDeltaStream }          from '../delta/index.js';
import { CURRENT_FORMAT_VERSION,
         CURRENT_KERNEL_VERSION }     from '../version-gate/index.js';
import { EDGE_CAUSAL_EXPLICIT,
         EDGE_CAUSAL_RULE,
         EDGE_CAUSAL_ADAPTER }        from '../causality/index.js';
import { classify as sigmaClassify } from '../sigma/index.js';

// ── Constants ─────────────────────────────────────────────────────────────────

/** @hook b6c7d8e9-f0a1-4b2c-3d4e-5f6a7b8c9d0e  clip:CLIP_MAGIC */
export const CLIP_MAGIC = 'NEX-CLIP';

/** @hook c7d8e9f0-a1b2-4c3d-4e5f-6a7b8c9d0e1f  clip:DEFAULT_STABILITY_THRESHOLDS */
export const DEFAULT_STABILITY_THRESHOLDS = Object.freeze({
  gapDrift:   0.30,
  sigmaDrift: 0.50,
  slopeDrift: 0.01,
});

// ── computeStabilityProfile ───────────────────────────────────────────────────

/**
 * Compute stability profile from ordered inter-event gaps.
 * meanGap / sigmaGap / deltaSlope / sampleCount / sigmaRegime
 *
 * @hook a5b6c7d8-e9f0-4a1b-2c3d-4e5f6a7b8c9d  clip:computeStabilityProfile
 */
export function computeStabilityProfile(gaps) {
  const n = gaps.length;
  if (n < 2) {
    return Object.freeze({
      meanGap: 0, sigmaGap: 0, deltaSlope: 0,
      sampleCount: n, sigmaRegime: 'insufficient_data',
    });
  }

  const mean     = gaps.reduce((a, b) => a + b, 0) / n;
  const variance = gaps.reduce((s, g) => s + (g - mean) ** 2, 0) / n;
  const sigma    = Math.sqrt(variance);

  // Linear regression slope of gap vs index (drift detection)
  let sumI = 0, sumG = 0, sumIG = 0, sumI2 = 0;
  for (let i = 0; i < n; i++) {
    sumI += i; sumG += gaps[i]; sumIG += i * gaps[i]; sumI2 += i * i;
  }
  const denom = n * sumI2 - sumI * sumI;
  const slope = denom !== 0 ? (n * sumIG - sumI * sumG) / denom : 0;

  return Object.freeze({
    meanGap:     r3(mean),
    sigmaGap:    r3(sigma),
    deltaSlope:  r3(slope),
    sampleCount: n,
    sigmaRegime: null, // Phase R5 — sigma.js
  });
}

// ── snapshotRange ─────────────────────────────────────────────────────────────

/**
 * Extract a bounded causal subgraph from a kernel as a NEX-CLIP artifact.
 *
 * @hook d2e3f4a5-b6c7-4d8e-9f0a-1b2c3d4e5f6a  clip:snapshotRange
 *
 * @param {object} kernel
 * @param {object} opts
 *   opts.seqStart               {number}   inclusive seq lower bound
 *   opts.seqEnd                 {number}   inclusive seq upper bound
 *   opts.attachStabilityProfile {boolean}  default true
 *   opts.sigmaEngine            {object}   ignored until Phase R5
 * @returns {object} frozen NEX-CLIP
 */
export function snapshotRange(kernel, opts = {}) {
  const { seqStart, seqEnd, attachStabilityProfile = true } = opts;

  if (typeof seqStart !== 'number' || typeof seqEnd !== 'number') {
    throw new Error('[clip] snapshotRange: seqStart and seqEnd must be numbers');
  }
  if (seqStart > seqEnd) {
    throw new Error(`[clip] snapshotRange: seqStart (${seqStart}) must be <= seqEnd (${seqEnd})`);
  }

  // 1. Filter events by seq range
  const all     = kernel.getAll();
  const inRange = all.filter(ev => ev.seq >= seqStart && ev.seq <= seqEnd);

  if (inRange.length === 0) {
    throw new Error(`[clip] snapshotRange: no events in seq range [${seqStart}, ${seqEnd}]`);
  }

  const inRangeIds = new Set(inRange.map(ev => ev.id));

  // 2. Boundary classification
  //    entryEvents: causedBy is outside the range
  const entryEvents = inRange
    .filter(ev => ev.causedBy && !inRangeIds.has(ev.causedBy))
    .map(ev => ev.id);

  //    exitEvents: no causal children inside the range
  const exitEvents = inRange
    .filter(ev => {
      const children = kernel.getChildren(ev.id);
      if (!children || children.size === 0) return true;
      for (const childId of children) {
        if (inRangeIds.has(childId)) return false;
      }
      return true;
    })
    .map(ev => ev.id);

  // 3. Infer parameters from entry event payloads
  const parameters = _inferParameters(
    inRange.filter(ev => entryEvents.includes(ev.id))
  );

  // 4. Build embedded snapshot from mini-kernel
  //    Preserves causal structure within range; boundary causedBy refs kept as-is.
  const mini     = createKernel({ ringCap: Math.max(inRange.length * 2, 100) });
  const oldToNew = new Map();

  for (const ev of inRange) {
    const causedBy = ev.causedBy
      ? (oldToNew.get(ev.causedBy) || ev.causedBy)
      : undefined;
    const ing = mini.ingest(ev.type, ev.payload, {
      source:      ev.source,
      causedBy,
      edgeType:    ev.edgeType   || undefined,
      sessionId:   ev.sessionId  || undefined,
      srcBusName:  ev.srcBusName || undefined,
      origEventTs: ev.eventTs,
    });
    oldToNew.set(ev.id, ing.id);
  }

  const embeddedSnap = kernelSnapshot(mini);

  // 5. Stability profile — gaps sourced from delta stream so they match
  //    what validateClipStability() receives as liveDeltaStream.
  //    Both sides measure delta.gap (causedBy-relative) — same unit, same comparison.
  let stabilityProfile = null;
  if (attachStabilityProfile) {
    const deltas = computeDeltaStream(
      inRange,
      id => kernel.findById(id),
      id => kernel.edgeMeta(id),
      id => kernel.getChildren(id),
    );
    const gaps = deltas.map(d => d.gap).filter(g => typeof g === 'number' && g >= 0);
    stabilityProfile = computeStabilityProfile(gaps);
    // Wire sigma regime — classify the delta window if sigma engine provided
    const sigmaEngine = opts.sigmaEngine || null;
    if (stabilityProfile && deltas.length >= 3) {
      const regime = sigmaEngine
        ? sigmaEngine.classify(deltas).regime
        : sigmaClassify(deltas).regime;
      stabilityProfile = Object.freeze({ ...stabilityProfile, sigmaRegime: regime });
    }
  }

  // 6. Assemble
  return Object.freeze({
    magic:            CLIP_MAGIC,
    fmt:              CURRENT_FORMAT_VERSION,
    kernelVersion:    CURRENT_KERNEL_VERSION,
    clipId:           newEventId(),
    seqRange:         Object.freeze([seqStart, seqEnd]),
    entryEvents:      Object.freeze(entryEvents),
    exitEvents:       Object.freeze(exitEvents),
    parameters:       Object.freeze(parameters),
    stabilityProfile: stabilityProfile,
    snapshot:         embeddedSnap,
    eventCount:       inRange.length,
  });
}

// ── restoreClip ───────────────────────────────────────────────────────────────

/**
 * Instantiate a clip as a ReplayContext.
 * The version gate must have run before calling this.
 *
 * @hook e3f4a5b6-c7d8-4e9f-0a1b-2c3d4e5f6a7b  clip:restoreClip
 *
 * @param {object} clip        — NEX-CLIP artifact
 * @param {object} [params]    — runtime parameter overrides (reserved for future use)
 * @param {object} [opts]
 *   opts.sandbox  {AdapterSandbox}
 *   opts.ringCap  {number}
 * @returns {ReplayContext}
 */
export function restoreClip(clip, params = {}, opts = {}) {
  if (!clip || clip.magic !== CLIP_MAGIC) {
    throw new Error(`[clip] restoreClip: artifact must be NEX-CLIP, got '${clip?.magic}'`);
  }
  if (!clip.snapshot) {
    throw new Error('[clip] restoreClip: clip has no embedded snapshot');
  }
  return createReplayContext(clip.snapshot, {
    sandbox: opts.sandbox || null,
    ringCap: opts.ringCap || undefined,
  });
}

// ── validateClipStability ─────────────────────────────────────────────────────

/**
 * Compare a live delta stream against the clip's stability profile.
 *
 * @hook f4a5b6c7-d8e9-4f0a-1b2c-3d4e5f6a7b8c  clip:validateClipStability
 *
 * @param {object}   clip            — NEX-CLIP with stabilityProfile
 * @param {object[]} liveDeltaStream — computeDeltaStream() output
 * @param {object}   [thresholds]    — override DEFAULT_STABILITY_THRESHOLDS
 * @returns {object} frozen StabilityValidationResult
 */
export function validateClipStability(clip, liveDeltaStream, thresholds = {}) {
  const t = { ...DEFAULT_STABILITY_THRESHOLDS, ...thresholds };

  if (!clip?.stabilityProfile) {
    return Object.freeze({ ok: false, gapDrift: null, sigmaDrift: null, slopeDrift: null, breach: 'no_stability_profile' });
  }

  if (!liveDeltaStream || liveDeltaStream.length < 2) {
    return Object.freeze({ ok: false, gapDrift: null, sigmaDrift: null, slopeDrift: null, breach: 'insufficient_live_data' });
  }

  const liveGaps = liveDeltaStream
    .map(d => d.gap)
    .filter(g => typeof g === 'number' && g >= 0);

  if (liveGaps.length < 2) {
    return Object.freeze({ ok: false, gapDrift: null, sigmaDrift: null, slopeDrift: null, breach: 'insufficient_live_gaps' });
  }

  const live        = computeStabilityProfile(liveGaps);
  const profile     = clip.stabilityProfile;

  const profileMean = profile.meanGap  || 0;
  const gapDrift    = profileMean > 0
    ? Math.abs(live.meanGap - profileMean) / profileMean
    : Math.abs(live.meanGap);

  const profileSigma = profile.sigmaGap || 0;
  const sigmaDrift   = Math.abs(live.sigmaGap - profileSigma) / Math.max(profileSigma, 1);

  const slopeDrift   = Math.abs(live.deltaSlope - (profile.deltaSlope || 0));

  let breach = null;
  if      (gapDrift   > t.gapDrift)   breach = 'gapDrift';
  else if (sigmaDrift > t.sigmaDrift)  breach = 'sigmaDrift';
  else if (slopeDrift > t.slopeDrift)  breach = 'slopeDrift';

  return Object.freeze({
    ok: breach === null,
    gapDrift:   r3(gapDrift),
    sigmaDrift: r3(sigmaDrift),
    slopeDrift: r3(slopeDrift),
    breach,
  });
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function r3(n) { return Math.round(n * 1000) / 1000; }

function _inferParameters(entryEvs) {
  const params = {};
  for (const ev of entryEvs) {
    if (!ev.payload) continue;
    for (const [k, v] of Object.entries(ev.payload)) {
      if (k in params) continue;
      const t = typeof v;
      params[k] = (t === 'string' || t === 'number' || t === 'boolean') ? t : 'object';
    }
  }
  return params;
}
