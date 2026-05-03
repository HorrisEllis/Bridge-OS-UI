// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
/**
 * BRIDGE OS — CONSOLIDATED BELIEF ENGINE
 * Logic: Bayesian Probability + Temporal Decay
 */
'use strict';

const fs = require('fs-extra');
const path = require('path');

const DATA_PATH = path.join(__dirname, '../../data/belief_state.json');

// ── INTERNAL STATE ──────────────────────────────────────────────────────────
let _nodes = {}; // { [uuid]: { p: 0.5, lastSeen: 1714... } }

const Belief = {
    init: async () => {
        if (fs.existsSync(DATA_PATH)) {
            _nodes = await fs.readJson(DATA_PATH);
        }
        process.stdout.write(`\x1b[35m[BELIEF]\x1b[0m Engine Online. Tracking ${_nodes.length || 0} nodes.\n`);
    },

    // ── THE JUDGMENT (Bayesian Update) ──────────────────────────────────────
    // p(H|E): probability of identity given the evidence
    update: (uuid, success) => {
        const current = _nodes[uuid] || { p: 0.5, lastSeen: Date.now() };
        const learningRate = 0.15; // How fast we trust/distrust

        // Bayesian swing: Move toward 1.0 on success, toward 0.0 on failure
        const delta = success ? (1 - current.p) * learningRate : -current.p * learningRate;
        
        _nodes[uuid] = {
            p: Math.max(0.01, Math.min(0.99, current.p + delta)),
            lastSeen: Date.now()
        };

        return _nodes[uuid].p;
    },

    // ── THE ENTROPY (Decay Heartbeat) ───────────────────────────────────────
    // If a node is silent, our "belief" pulls back toward neutral (0.5)
    decay: () => {
        const entropy = 0.01; // 1% decay per tick
        for (const uuid in _nodes) {
            const diff = 0.5 - _nodes[uuid].p;
            _nodes[uuid].p += diff * entropy;
        }
        Belief.save();
    },

    // ── THE PERSISTENCE ─────────────────────────────────────────────────────
    save: () => fs.outputJsonSync(DATA_PATH, _nodes),

    getScore: (uuid) => _nodes[uuid]?.p || 0.5
};

module.exports = Belief;