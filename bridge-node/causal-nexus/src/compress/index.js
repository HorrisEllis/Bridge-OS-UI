// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
/**
 * @module       compress
 * @uuid         f50d7ace-fe96-4aae-995e-4534a9ad7163
 * @version      5.0.0
 *
 * Snapshot, restore, blueprint, and compile for Causal Nexus kernels.
 *
 * Four entry points:
 *   snapshot(kernel)          — compact serializable snapshot (3–5× vs raw JSON)
 *   restore(snap, opts)       — exact round-trip; gate events re-emitted on restore
 *   blueprint(kernel)         — structural digest: vocab, causal grammar, invariants
 *   compile(blueprint, opts)  — generate executable ESM/CJS module from blueprint
 *
 * Encoding:
 *   Type dict + source dict (index not string), payload delta per type,
 *   timestamp deltas, causedBy as primary-sequence index, edge type 1-char codes.
 *   Primary events only (gate + system events re-emitted on restore, I-1 compliant).
 *
 * @hook e225d4f3-d576-415a-bfac-0c26ae773d7e  snapshot
 * @hook d1ddb145-4b84-4db6-8cd4-8fa666be116f  restore
 * @hook cb527b7a-af1d-4bba-9df3-60cf360bb81a  blueprint
 * @hook de525186-dfe2-47dd-a904-1b58304c7ff1  compile
 * @hook 35e6caf0-88bb-49d0-8d50-722fb2b4ce7a  compressionReport
 */

import { createKernel } from '../kernel/index.js';
import { createAdapter } from '../adapter/index.js';

const FORMAT_VERSION = 1;
const SNAP_MAGIC     = 'URCK-SNAP';
const BP_MAGIC       = 'URCK-BP';

// Edge type → 1-char code
const ET_ENC = { 'causal/explicit':'x','causal/rule':'r','causal/adapter':'a','observational':'o' };
const ET_DEC = Object.fromEntries(Object.entries(ET_ENC).map(([k,v])=>[v,k]));

function isPrimary(ev) {
  return ev.source !== 'kernel:system'
    && !(ev.source && ev.source.startsWith('gate:'));
}

// ── Payload delta ─────────────────────────────────────────────────────────────

function deltaPl(prev, curr) {
  if (!prev) return { _full: curr };
  if (JSON.stringify(prev) === JSON.stringify(curr)) return null;
  const diff = {}; let any = false;
  const keys = new Set([...Object.keys(prev), ...Object.keys(curr)]);
  for (const k of keys) {
    const pj = JSON.stringify(prev[k]);
    const cj = JSON.stringify(curr[k]);
    if (pj !== cj) { diff[k] = k in curr ? curr[k] : undefined; any = true; }
  }
  return any ? diff : null;
}

function applyPl(base, delta) {
  if (!delta) return base;
  if (delta._full) return delta._full;
  const r = Object.assign({}, base);
  for (const [k, v] of Object.entries(delta)) {
    if (v === undefined) delete r[k]; else r[k] = v;
  }
  return r;
}

// ── SNAPSHOT ──────────────────────────────────────────────────────────────────

/**
 * Serialize a kernel to a compact snapshot object.
 * @hook e225d4f3-d576-415a-bfac-0c26ae773d7e  compress:snapshot
 */
export function snapshot(kernel) {
  const all     = kernel.getAll();
  const primary = all.filter(isPrimary);

  const types = []; const typeIdx = new Map();
  const sources = []; const srcIdx = new Map();

  for (const ev of primary) {
    if (!typeIdx.has(ev.type))   { typeIdx.set(ev.type, types.length);   types.push(ev.type); }
    const s = ev.source || '';
    if (!srcIdx.has(s))          { srcIdx.set(s, sources.length); sources.push(s); }
  }

  const idToPos = new Map();
  primary.forEach((ev, i) => idToPos.set(ev.id, i));

  let prevTs = 0, prevEts = 0;
  const prevPlByType = new Map();

  const encoded = primary.map((ev) => {
    const dts = ev.ts - prevTs;
    const det = ev.eventTs - prevEts;
    prevTs  = ev.ts;
    prevEts = ev.eventTs;

    const prevPl = prevPlByType.get(ev.type) || null;
    const pd     = deltaPl(prevPl, ev.payload);
    prevPlByType.set(ev.type, ev.payload);

    const cb = (ev.causedBy && idToPos.has(ev.causedBy)) ? idToPos.get(ev.causedBy) : null;
    const et = ev.edgeType ? (ET_ENC[ev.edgeType] || ev.edgeType) : null;

    return [typeIdx.get(ev.type), srcIdx.get(ev.source || ''), dts, det, cb, et, pd, ev.sessionId || null, ev.srcBusName || null];
  });

  const macros = kernel.macros.map(m => ({ p: m.pattern, c: m.count, s: m.firstSeenSeq, t: m.eventTs }));
  const gates  = kernel.getGates().filter(g => !g.builtin).map(g => ({ sig: g.signature, pri: g.priority }));

  return {
    magic: SNAP_MAGIC, fmt: FORMAT_VERSION, ts: Date.now(),
    cseq: kernel.clock.seq, ctick: kernel.clock.tick, ver: kernel.version,
    types, sources, ev: encoded, macros, gates,
    n: primary.length, total: all.length, edges: kernel.edgeCount, drops: kernel.droppedCount,
  };
}

// ── RESTORE ───────────────────────────────────────────────────────────────────

/**
 * Restore a kernel from a snapshot. New UUIDs assigned (I-1). Gate events re-emitted.
 * @hook d1ddb145-4b84-4db6-8cd4-8fa666be116f  compress:restore
 */
export function restore(snap, opts = {}) {
  if (!snap || snap.magic !== SNAP_MAGIC) throw new Error('restore: not a valid URCK snapshot');
  if (snap.fmt !== FORMAT_VERSION)        throw new Error(`restore: format v${snap.fmt} unsupported`);

  const kernel = createKernel({ ringCap: opts.ringCap || Math.max(snap.total * 2, 5_000), ...opts });
  const { types, sources, ev: encoded } = snap;
  const seqToNewId = new Array(encoded.length);

  let prevTs = 0, prevEts = 0;
  const prevPlByType = new Map();

  for (let i = 0; i < encoded.length; i++) {
    const [ti, si, dts, det, cb, et, pd, sessionId, srcBusName] = encoded[i];
    const type    = types[ti];
    const source  = sources[si] || 'unknown';
    const ts_val  = prevTs  + dts;
    const eventTs = prevEts + det;
    prevTs  = ts_val;
    prevEts = eventTs;

    const prevPl  = prevPlByType.get(type) || {};
    const payload = applyPl(prevPl, pd);
    prevPlByType.set(type, payload);

    const causedBy = (cb !== null && cb !== undefined) ? seqToNewId[cb] : undefined;
    const edgeType = et ? (ET_DEC[et] || et) : undefined;

    const ingested = kernel.ingest(type, payload, {
      causedBy, edgeType, source,
      sessionId:   sessionId  || undefined,
      srcBusName:  srcBusName || undefined,
      origEventTs: eventTs,
    });
    seqToNewId[i] = ingested.id;
  }

  return kernel;
}

// ── BLUEPRINT ─────────────────────────────────────────────────────────────────

/**
 * Extract structural digest: vocabulary, causal grammar, macro patterns, invariants.
 * @hook cb527b7a-af1d-4bba-9df3-60cf360bb81a  compress:blueprint
 */
export function blueprint(kernel) {
  const events  = kernel.getAll();
  const primary = events.filter(isPrimary);
  const n       = events.length;

  const freq    = new Map();
  const succMap = new Map();
  const parMap  = new Map();

  for (const ev of events) {
    freq.set(ev.type, (freq.get(ev.type) || 0) + 1);
    if (ev.causedBy) {
      const par = kernel.findById(ev.causedBy);
      if (par) {
        if (!succMap.has(par.type)) succMap.set(par.type, new Map());
        if (!parMap.has(ev.type))   parMap.set(ev.type, new Map());
        const sc = succMap.get(par.type);
        const pc = parMap.get(ev.type);
        sc.set(ev.type,  (sc.get(ev.type)  || 0) + 1);
        pc.set(par.type, (pc.get(par.type) || 0) + 1);
      }
    }
  }

  const vocab = [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => ({
      type, count,
      pct: Math.round(count / n * 1000) / 10,
      successors: succMap.has(type) ? [...succMap.get(type).entries()].sort((a,b)=>b[1]-a[1]).slice(0,5).map(([t,c])=>({type:t,count:c})) : [],
      parents:    parMap.has(type)  ? [...parMap.get(type).entries()].sort((a,b)=>b[1]-a[1]).slice(0,3).map(([t,c])=>({type:t,count:c})) : [],
      isRoot:         !parMap.has(type) || parMap.get(type).size === 0,
      isGateProduced: type === 'session:boundary' || type === 'dom:unstable' || type === 'alert:critical' || (type && type.startsWith('system:')),
    }));

  let maxDepth = 0;
  const roots  = events.filter(ev => !ev.causedBy && !ev.type.startsWith('system:')).slice(0, 50);
  for (const r of roots) {
    const { depth } = kernel.traceToRoot(r.id);
    if (depth > maxDepth) maxDepth = depth;
  }

  const gates    = kernel.getGates().map(g => ({ signature: g.signature, priority: g.priority, builtin: g.builtin }));
  const patterns = kernel.macros.map(m => ({ pattern: m.pattern, count: m.count, chainLen: m.pattern.split(' → ').length, types: m.pattern.split(' → ') }));

  const invariants = [];
  if (events.every(ev => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(ev.id)))
    invariants.push({ id: 'I-1', text: 'All event IDs are UUID v4' });
  if (events.filter(ev=>ev.causedBy).every(ev=>kernel.edgeMeta(ev.id)))
    invariants.push({ id: 'C-1', text: 'All causedBy references have declared edges' });
  if (!events.some(ev=>ev.type==='macro:detected'))
    invariants.push({ id: 'C-2', text: 'No macro:detected events in kernel store' });
  if (events.length>1 && events.every((ev,i)=>i===0||ev.seq>events[i-1].seq))
    invariants.push({ id: 'T-1', text: 'seq is strictly monotonically increasing' });

  return {
    magic: BP_MAGIC, fmt: FORMAT_VERSION, ts: Date.now(),
    session: { eventCount: n, primaryCount: primary.length, edgeCount: kernel.edgeCount, macroCount: kernel.macros.length, uniqueTypes: vocab.length, maxCausalDepth: maxDepth },
    vocab, gates, patterns, invariants,
  };
}

// ── COMPILE ───────────────────────────────────────────────────────────────────

/**
 * Generate an executable ESM or CJS module from a blueprint.
 * Output: T type constants + GRAMMAR map + MACROS + gate stubs + createFromBlueprint() factory.
 * @hook de525186-dfe2-47dd-a904-1b58304c7ff1  compress:compile
 */
export function compile(bp, { ringCap = 1_000_000, includeSeed = true, format = 'esm' } = {}) {
  if (!bp || bp.magic !== BP_MAGIC) throw new Error('compile: invalid blueprint');

  const L = [];
  const w  = (...s) => L.push(...s);
  const nl = ()     => L.push('');

  w(`/**`, ` * Generated by URCK Blueprint Compiler — v${FORMAT_VERSION}`,
    ` * ${bp.session.eventCount} events · ${bp.session.uniqueTypes} types · ${bp.session.edgeCount} edges`,
    ` * Generated: ${new Date(bp.ts).toISOString()}`, ` */`); nl();

  if (format === 'esm') {
    w(`import { createKernel, gateOutput } from './src/kernel/index.js';`,
      `import { createAdapter }            from './src/adapter/index.js';`);
  } else {
    w(`const { createKernel, gateOutput } = require('./src/kernel/index.js');`,
      `const { createAdapter }            = require('./src/adapter/index.js');`);
  }
  nl();

  w(`const T = Object.freeze({`);
  for (const { type, count, pct } of bp.vocab) {
    const key = type.toUpperCase().replace(/[^A-Z0-9]/g, '_');
    w(`  ${key}: ${JSON.stringify(type)},${' '.repeat(Math.max(1, 32-type.length))}// ${count} (${pct}%)`);
  }
  w(`});`); nl();

  w(`const GRAMMAR = new Map([`);
  for (const { type, successors } of bp.vocab.filter(v => v.successors.length > 0)) {
    const inner = successors.map(s => `[${JSON.stringify(s.type)}, ${s.count}]`).join(', ');
    w(`  [${JSON.stringify(type)}, new Map([${inner}])],`);
  }
  w(`]);`); nl();

  if (bp.patterns.length > 0) {
    w(`const MACROS = [`);
    for (const { pattern, count, chainLen, types: seqTypes } of bp.patterns) {
      w(`  { types: ${JSON.stringify(seqTypes)}, count: ${count}, chainLen: ${chainLen} }, // ${pattern}`);
    }
    w(`];`); nl();
  }

  const customGates = bp.gates.filter(g => !g.builtin);
  if (customGates.length > 0) {
    w(`const CUSTOM_GATES = [`);
    for (const g of customGates) {
      w(`  { signature: ${JSON.stringify(g.signature)}, priority: ${g.priority}, fn(ev, query) { return []; } },`);
    }
    w(`];`); nl();
  }

  const exportKw = format === 'esm' ? 'export ' : '';
  w(`${exportKw}function createFromBlueprint({ ringCap = ${ringCap}, seed = ${includeSeed} } = {}) {`);
  w(`  const kernel  = createKernel({ ringCap });`, `  const adapter = createAdapter(kernel);`); nl();
  if (customGates.length > 0) {
    w(`  for (const g of CUSTOM_GATES) kernel.registerGate(g.signature, g.fn, { priority: g.priority });`); nl();
  }
  w(`  return { kernel, adapter };`, `}`); nl();

  if (format === 'esm') {
    w(`export { T, GRAMMAR${bp.patterns.length > 0 ? ', MACROS' : ''} };`, `export default createFromBlueprint;`);
  } else {
    w(`module.exports = { createFromBlueprint, T, GRAMMAR${bp.patterns.length > 0 ? ', MACROS' : ''} };`);
  }

  return L.join('\n');
}

// ── Compression report ────────────────────────────────────────────────────────

/**
 * @hook 35e6caf0-88bb-49d0-8d50-722fb2b4ce7a  compress:compressionReport
 */
export function compressionReport(kernel, snap) {
  const rawB  = JSON.stringify(kernel.getAll()).length;
  const snapB = JSON.stringify(snap).length;
  const ratio = rawB > 0 && snapB > 0 ? Math.max(1, Math.round(rawB / snapB * 10) / 10) : 1;
  return {
    rawBytes: rawB, snapBytes: snapB, ratio,
    primaryCount: snap.n, totalCount: snap.total, eventCount: kernel.length,
    bytesPerEvent: Math.round(snapB / Math.max(snap.n, 1)),
    summary: `${(rawB/1024).toFixed(1)} KB raw → ${(snapB/1024).toFixed(1)} KB snap (${ratio}×)`,
  };
}
