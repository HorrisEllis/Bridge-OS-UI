// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
'use strict';
/**
 * bridge-mesh/mesh/trust-mesh.js
 * Bayesian peer trust integrated into bridge-mesh.
 *
 * Distilled from BrainOS mesh-trust v1.0.0.
 * Adapted for Bridge-v2: feeds trust signals into bridge-IME via busEmit.
 *
 * INVARIANTS:
 *   1. trust-mesh NEVER calls IME.ingest() directly. It emits on bus — IME listens.
 *   2. Identity entropy (Sybil resistance) is applied before Bayesian update.
 *      New high-frequency nodes cannot inflate trust.
 *   3. Contradiction detection does NOT quarantine — it emits a signal.
 *      bridge-sngate makes the quarantine decision, not trust-mesh.
 *   4. trust-mesh is a read source for bridge-sngate (via getTrustScore),
 *      not a decision maker.
 *
 * Exposes:
 *   .pulse(uuid, success, weight, reason) → snapshot
 *   .propagate(uuid, success, weight, maxHops) → { propagated, results }
 *   .getTrustScore(uuid) → 0–10 (IME-compatible scale)
 *   .snapshot(uuid) → full trust state or null
 *   .diagnostics() → aggregate stats
 *
 * Bus events emitted:
 *   mesh:trust:update      { uuid, p, c, o, trustScore, isSybilSuspect, reason }
 *   mesh:trust:flagged     { uuid, reason, contradictionScore }
 *
 * Bus events consumed (wired in bridge-mesh/index.js):
 *   mesh:peer:connected    → pulse(uuid, true, 1.0)
 *   mesh:data:incoming     → pulse(uuid, true, 0.3)
 *   node:degraded          → pulse(uuid, false, 0.5)
 *   node:dead              → pulse(uuid, false, 0.9)
 *   sngate:decision[deny]  → pulse(uuid, false, 0.6) where uuid = identity.uuid
 */

const GOSSIP_DECAY       = 0.6;
const MAX_HOPS           = 3;
const HISTORY_WINDOW     = 8;
const SYBIL_AGE_UNIT     = 10_000;   // ms — log scaling base
const CONTRADICTION_THRESH = 0.65;
const REGISTRY_LIMIT     = 5000;
const IME_SCALE          = 10;       // trust p (0–1) → IME score (0–10)

const clamp       = (v, min = 0, max = 1) => Math.max(min, Math.min(max, v));
const gossipW     = (hop) => Math.pow(GOSSIP_DECAY, hop);

// ── TrustNode ─────────────────────────────────────────────────────────────────
class TrustNode {
    constructor(uuid) {
        this.uuid      = uuid;
        this.alpha     = 1.1;
        this.beta      = 1.1;
        this.p         = 0.5;
        this.v         = 0.01;
        this.c         = 0.5;
        this.o         = 0;
        this.history   = [];
        this.updatedAt = Date.now();
    }

    update(success, weight = 1) {
        const w = clamp(weight, 0, 2);
        if (success) this.alpha += w;
        else         this.beta  += w;

        const n    = this.alpha + this.beta;
        const prev = this.p;
        this.p = this.alpha / n;
        this.v = (this.alpha * this.beta) / ((n * n) * (n + 1));
        this.c = 1 - (this.v / (this.v + 0.02));

        const delta = this.p - prev;
        this.history.push(delta);
        if (this.history.length > HISTORY_WINDOW) this.history.shift();
        this.o = this._oscillation();

        if (this.o > 0.4) this.c *= 0.75; // adversarial damping

        this.updatedAt = Date.now();
        return this.snapshot();
    }

    _oscillation() {
        if (this.history.length < 4) return 0;
        let flips = 0;
        for (let i = 1; i < this.history.length; i++) {
            if (Math.sign(this.history[i]) !== Math.sign(this.history[i - 1])) flips++;
        }
        return flips / (this.history.length - 1);
    }

    // Map 0–1 trust probability to 0–10 IME-compatible trust score
    imeScore() {
        return clamp(this.p * IME_SCALE, 0, IME_SCALE);
    }

    snapshot() {
        return {
            uuid:      this.uuid,
            p:         clamp(this.p),
            v:         clamp(this.v, 0, 0.25),
            c:         clamp(this.c),
            o:         this.o,
            imeScore:  this.imeScore(),
            updatedAt: this.updatedAt,
        };
    }
}

// ── Identity entropy (Sybil resistance) ──────────────────────────────────────
class IdentityEntropy {
    constructor() {
        this._firstSeen = new Map();
        this._count     = new Map();
    }
    observe(uuid) {
        if (!this._firstSeen.has(uuid)) this._firstSeen.set(uuid, Date.now());
        this._count.set(uuid, (this._count.get(uuid) || 0) + 1);
    }
    score(uuid) {
        const count     = this._count.get(uuid) || 1;
        const firstSeen = this._firstSeen.get(uuid) || Date.now();
        const age       = Date.now() - firstSeen;
        const ageFactor = Math.log(1 + age / SYBIL_AGE_UNIT);
        const burst     = count / Math.max(ageFactor, 0.01);
        return clamp(1 / (1 + burst * 0.1));
    }
}

// ── Registry ──────────────────────────────────────────────────────────────────
class TrustRegistry {
    constructor() {
        this._nodes = new Map();
    }
    get(uuid) { return this._nodes.get(uuid); }
    getOrCreate(uuid) {
        if (!this._nodes.has(uuid)) {
            if (this._nodes.size >= REGISTRY_LIMIT) this._evict();
            this._nodes.set(uuid, new TrustNode(uuid));
        }
        return this._nodes.get(uuid);
    }
    _evict() {
        let worst = null, minC = Infinity;
        for (const [k, v] of this._nodes) {
            if (v.c < minC) { minC = v.c; worst = k; }
        }
        if (worst) this._nodes.delete(worst);
    }
    values()  { return this._nodes.values(); }
    entries() { return this._nodes.entries(); }
    size()    { return this._nodes.size; }
}

// ── TrustMesh ─────────────────────────────────────────────────────────────────
function createTrustMesh({ busEmit = null } = {}) {
    const registry = new TrustRegistry();
    const entropy  = new IdentityEntropy();
    const topology = new Map();  // uuid → Set<uuid> — built from peer events

    function _topologyAdd(a, b) {
        if (!a || !b || a === b) return;
        if (!topology.has(a)) topology.set(a, new Set());
        if (!topology.has(b)) topology.set(b, new Set());
        topology.get(a).add(b);
        topology.get(b).add(a);
    }

    function _contradictionScore(uuid) {
        const node      = registry.get(uuid);
        const neighbors = topology.get(uuid) || new Set();
        if (!node || neighbors.size === 0) return 0;
        let div = 0, count = 0;
        for (const nId of neighbors) {
            const n = registry.get(nId);
            if (n) { div += Math.abs(n.p - node.p); count++; }
        }
        return count ? clamp(div / count) : 0;
    }

    function _update(uuid, success, weight, reason) {
        entropy.observe(uuid);
        const idScore = entropy.score(uuid);
        const node    = registry.getOrCreate(uuid);
        node.update(success, weight * idScore);

        const contradiction = _contradictionScore(uuid);
        const snap          = node.snapshot();

        // Emit to bus — IME picks this up via bus subscription, never direct
        busEmit?.('mesh:trust:update', {
            _uuid:              uuid,
            uuid,
            reason,
            ...snap,
            identityScore:      idScore,
            isSybilSuspect:     idScore < 0.3,
            contradictionScore: contradiction,
        }, 'DEBUG');

        if (contradiction > CONTRADICTION_THRESH) {
            busEmit?.('mesh:trust:flagged', {
                _uuid:              uuid,
                uuid,
                reason:             'HIGH_CONTRADICTION',
                contradictionScore: contradiction,
            }, 'WARN');
        }

        return snap;
    }

    // ── Public API ────────────────────────────────────────────────────────────

    function pulse(uuid, success, weight = 1, reason = 'manual') {
        if (!uuid) return null;
        return _update(uuid, success, weight, reason);
    }

    function observePeer(uuid, neighborUuid) {
        entropy.observe(uuid);
        _topologyAdd(uuid, neighborUuid);
    }

    function propagate(startUuid, success, weight = 1, maxHops = MAX_HOPS) {
        const visited = new Set();
        const queue   = [{ id: startUuid, hop: 0 }];
        const results = [];
        while (queue.length) {
            const { id, hop } = queue.shift();
            if (visited.has(id) || hop > maxHops) continue;
            visited.add(id);
            const w = weight * gossipW(hop);
            results.push(_update(id, success, w, `propagate:hop${hop}`));
            const neighbors = topology.get(id) || new Set();
            for (const n of neighbors) queue.push({ id: n, hop: hop + 1 });
        }
        return { propagated: results.length, results };
    }

    // 0–10 IME-compatible scale
    function getTrustScore(uuid) {
        const node = registry.get(uuid);
        return node ? node.imeScore() : 5; // neutral default for unknown peers
    }

    function snapshot(uuid) {
        const node = registry.get(uuid);
        if (!node) return null;
        return { ...node.snapshot(), identityScore: entropy.score(uuid) };
    }

    function diagnostics() {
        const all = [...registry.values()];
        return {
            peers:    all.length,
            trusted:  all.filter(n => n.p > 0.7).length,
            suspect:  all.filter(n => n.p < 0.3).length,
            oscillating: all.filter(n => n.o > 0.4).length,
            topologyEdges: [...topology.values()].reduce((s, v) => s + v.size, 0) / 2 | 0,
        };
    }

    return { pulse, observePeer, propagate, getTrustScore, snapshot, diagnostics };
}

module.exports = { createTrustMesh };
