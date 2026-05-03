// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
'use strict';
/**
 * bridge-causal/index.js
 * Causal-Nexus v5.0.1 memory tier for the unified sovereign node.
 *
 * Bridges Bridge-v2's SISO bus (busEmit(sig, data, level)) into
 * the causal-nexus ESM kernel via dynamic import().
 *
 * INVARIANTS:
 *   1. ESM loaded once at init — no re-import.
 *   2. Every ingest carries explicit edgeType (Law C-1).
 *   3. Feedback guard: causal:kernel:* events never re-enter kernel.
 *   4. Non-fatal: if import fails, system continues without causal memory.
 *   5. busEmit wrapper is transparent — all existing listeners fire unchanged.
 *   6. IME ingest and causal ingest are independent — causal never writes to IME.
 *
 * Exposes on returned object:
 *   .query(cql)      → CQL query against live kernel
 *   .classify()      → sigma regime for current session
 *   .diagnostics()   → stats for /health and /runtime/state endpoints
 *   .kernel          → raw kernel handle
 *   .eventCount      → total bus events ingested since boot
 *
 * Bus events emitted (via original busEmit — NOT re-ingested):
 *   causal:kernel:ready    { ringCap, storePath }
 *   causal:kernel:stats    { eventCount, ringLen, version, edges } — every 30s
 *
 * Bus events consumed (via wrap on busEmit):
 *   every event EXCEPT causal:kernel:* — ingested into kernel
 *
 * HTTP routes (add to bridge-node route table):
 *   POST /causal/query      { cql } → { ok, events[], total, durationMs }
 *   GET  /causal/classify   → { regime, reason }
 *   GET  /causal/stats      → diagnostics()
 *
 * BrainOS-specific gates (registered on kernel):
 *   gate:sngate:deny    — emits alert:sngate:burst when 3+ deny decisions within 500 ticks
 *   gate:mesh:dead      — emits alert:mesh:degraded on 2+ node:dead within 1000 ticks
 */

const path = require('path');
const { pathToFileURL } = require('url');

const NEXUS_SRC = path.resolve(__dirname, '../causal-nexus/src');
// On Windows, dynamic import() requires file:// URLs — bare paths with drive letters fail
const mod = (name) => pathToFileURL(path.join(NEXUS_SRC, name, 'index.js')).href;

// ── BrainOS/Bridge gates ──────────────────────────────────────────────────────

function makeSngateDenyGate(gateOutput, EDGE_CAUSAL_RULE) {
    const WINDOW = 500;
    const THRESH = 3;
    return function sngateDesnyGate(ev, query) {
        if (ev.type !== 'sngate:decision' || ev.payload?.decision !== 'deny') return [];
        const ids    = query.typeIds('sngate:decision');
        const cutoff = ev.eventTs - WINDOW;
        let   count  = 0;
        for (let i = ids.length - 1; i >= 0; i--) {
            const e = query.findById(ids[i]);
            if (!e || e.eventTs < cutoff) break;
            if (e.payload?.decision === 'deny') count++;
        }
        if (count < THRESH) return [];
        return [gateOutput(
            'alert:sngate:burst',
            { denyCount: count, windowTicks: WINDOW, surface: ev.payload?.surface },
            { source: 'gate:causal:sngate', causedBy: ev.id, edgeType: EDGE_CAUSAL_RULE }
        )];
    };
}

function makeMeshDeadGate(gateOutput, EDGE_CAUSAL_RULE) {
    const WINDOW = 1000;
    const THRESH = 2;
    return function meshDeadGate(ev, query) {
        if (ev.type !== 'node:dead') return [];
        const ids    = query.typeIds('node:dead');
        const cutoff = ev.eventTs - WINDOW;
        let   count  = 0;
        for (let i = ids.length - 1; i >= 0; i--) {
            const e = query.findById(ids[i]);
            if (!e || e.eventTs < cutoff) break;
            count++;
        }
        if (count < THRESH) return [];
        return [gateOutput(
            'alert:mesh:degraded',
            { deadCount: count, windowTicks: WINDOW, lastUuid: ev.payload?.uuid },
            { source: 'gate:causal:mesh', causedBy: ev.id, edgeType: EDGE_CAUSAL_RULE }
        )];
    };
}

// ── Module factory ────────────────────────────────────────────────────────────

async function createCausalAuthority({ busEmit: _origEmit, dataDir, identity }) {
    let kernel         = null;
    let store          = null;
    let eventCount     = 0;
    let queryFn        = null;
    let classifyFn     = null;
    let computeDelta   = null;
    let initialized    = false;
    let statsInterval  = null;

    // Wrapped busEmit — returned to caller, replaces busEmit in boot context
    let wrappedEmit = _origEmit;

    try {
        const [
            { createKernel, gateOutput },
            { createStore },
            { execQuery },
            { EDGE_CAUSAL_ADAPTER, EDGE_CAUSAL_RULE },
            { classify, computeFeatureTree },
            { computeDeltaStream },
        ] = await Promise.all([
            import(mod('kernel')),
            import(mod('persist')),
            import(mod('query')),
            import(mod('causality')),
            import(mod('sigma')),
            import(mod('delta')),
        ]);

        queryFn     = (cql) => execQuery(cql, kernel);
        classifyFn  = (deltas) => classify(deltas, computeFeatureTree(deltas));
        computeDelta = computeDeltaStream;

        // ── Kernel ────────────────────────────────────────────────────────────
        kernel = createKernel({ ringCap: 1_000_000 });

        // ── Persist ───────────────────────────────────────────────────────────
        const storePath = path.join(dataDir, 'causal-nexus');
        store = createStore(kernel, { backend: 'filesystem', walFlushEvery: 100, storePath });

        // ── Sovereign-node gates ──────────────────────────────────────────────
        kernel.registerGate(
            'gate:causal:sngate',
            makeSngateDenyGate(gateOutput, EDGE_CAUSAL_RULE),
            { priority: 40 }
        );
        kernel.registerGate(
            'gate:causal:mesh',
            makeMeshDeadGate(gateOutput, EDGE_CAUSAL_RULE),
            { priority: 45 }
        );

        // ── Bus tap — wrap busEmit ────────────────────────────────────────────
        wrappedEmit = (sig, data = {}, level = 'INFO') => {
            if (!sig.startsWith('causal:kernel:')) {
                eventCount++;
                try {
                    kernel.ingest(sig, data, {
                        source:   data.source || 'bus',
                        edgeType: EDGE_CAUSAL_ADAPTER,
                    });
                } catch {}
            }
            return _origEmit(sig, data, level);
        };

        // ── 30s stats heartbeat ───────────────────────────────────────────────
        statsInterval = setInterval(() => {
            if (!kernel) return;
            _origEmit('causal:kernel:stats', {
                eventCount,
                ringLen:  kernel.length,
                version:  kernel.version,
                edges:    kernel.edgeCount,
                uuid:     identity?.uuid,
            }, 'DEBUG');
        }, 30_000);

        initialized = true;

        _origEmit('causal:kernel:ready', {
            ringCap: 1_000_000,
            storePath,
            uuid:    identity?.uuid,
        }, 'INFO');

        console.log(JSON.stringify({
            ts: new Date().toISOString(), level: 'INFO',
            msg: 'bridge-causal online',
            storePath, ringCap: 1_000_000,
        }));

    } catch (err) {
        console.error(JSON.stringify({
            ts: new Date().toISOString(), level: 'ERROR',
            msg: 'bridge-causal failed to initialize — system continues without causal memory',
            error: err.message,
        }));
    }

    // ── Public API ────────────────────────────────────────────────────────────

    function query(cql) {
        if (!queryFn || !kernel) return { ok: false, error: 'Kernel not initialized', events: [], total: 0 };
        try { return queryFn(cql); }
        catch (err) { return { ok: false, error: err.message, events: [], total: 0 }; }
    }

    function classify() {
        if (!classifyFn || !computeDelta || !kernel) {
            return { regime: 'insufficient_data', reason: 'kernel not initialized' };
        }
        try {
            const events = kernel.getAll();
            if (events.length < 3) return { regime: 'insufficient_data', reason: 'not enough events' };
            const deltas = computeDelta(
                events,
                (id) => kernel.findById(id),
                (id) => kernel.edgeMeta(id),
                (id) => kernel.getChildren(id),
            );
            return classifyFn(deltas);
        } catch (err) {
            return { regime: 'insufficient_data', reason: err.message };
        }
    }

    function diagnostics() {
        if (!initialized || !kernel) return { online: false };
        return {
            online:     true,
            eventCount,
            ringLen:    kernel.length,
            ringCap:    1_000_000,
            version:    kernel.version,
            edges:      kernel.edgeCount,
            dropped:    kernel.droppedCount,
            gates:      kernel.getGates().map(g => g.signature),
            regime:     classify().regime,
        };
    }

    // ── HTTP route handler ────────────────────────────────────────────────────
    function route(method, urlParts, body) {
        if (urlParts[0] !== 'causal') return null;

        if (method === 'POST' && urlParts[1] === 'query') {
            const cql = body?.cql;
            if (!cql) return { ok: false, error: 'cql required' };
            return query(cql);
        }
        if (method === 'GET' && urlParts[1] === 'classify') {
            return { ok: true, ...classify() };
        }
        if (method === 'GET' && urlParts[1] === 'stats') {
            return { ok: true, ...diagnostics() };
        }
        return null;
    }

    return { query, classify, diagnostics, route, kernel, eventCount: () => eventCount, wrappedEmit };
}

module.exports = { createCausalAuthority };
