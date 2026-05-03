# causal-nexus v4.5.2

A real-time causal event engine. Ring buffer. Gate system. Delta analytics. CQL query. Persistence. AI self-modification.

```
npm install causal-nexus   # or just drop the src/ folder anywhere
```

Node ≥ 18. Zero runtime dependencies. ES modules throughout.

---

## Quick start

```js
import { createKernel, createAdapter } from 'causal-nexus';

const kernel  = createKernel();
const adapter = createAdapter(kernel);

kernel.subscribe(ev => console.log(ev.type, ev.id));

adapter.handle('page:navigated', { from: '/', to: '/app' });
// → page:navigated <uuid>
// → session:boundary <uuid>   (built-in gate fired)

adapter.handle('element:callto:running',  { id: 'cmd-1', action: 'click' });
adapter.handle('element:callto:resolved', { id: 'cmd-1', status: 'ok' });
// command:running and command:success linked via calltoMap
// command:success.causedBy === command:running.id
// command:success.edgeType === 'causal/adapter'
```

---

## Modules

| # | Module | UUID | Description |
|---|--------|------|-------------|
| 0 | `identity` | `fabbc95c` | UUID v4, FNV-1a hash, dedup keys |
| 1 | `time` | `ce9aac88` | Kernel-local clocks, wall vs logical time |
| 2 | `causality` | `32a3f387` | Edge types, causal graph, CalltoMap |
| 3 | `projection` | `74eddeca` | Read-only views over event arrays |
| 4 | `lazy` | `6786d999` | Demand-paged virtual scroll, calendar index |
| 5 | `kernel` | `5d90c63d` | Ring buffer, gate system, macro projection |
| 6 | `adapter` | `dc2cfbff` | Bridge bus → kernel event translation |
| 7 | `delta` | `7a4219d0` | Kinematic delta engine, zoom levels, fractal detection |
| 8 | `compress` | `f50d7ace` | Snapshot, restore, blueprint, compile |
| 9 | `forge` | `0091ce2c` | AI-powered self-modification (Anthropic API) |
| 10 | `loader` | `8bfdf8c2` | Hot module loading, gate evaluation |
| 11 | `persist` | `fde4fdbd` | WAL + archive + recovery (memory/IndexedDB/filesystem) |
| 12 | `query` | `e3bca332` | CQL query engine |

---

## Kernel

```js
const kernel = createKernel({
  ringCap:        5_000_000,  // ring buffer capacity
  calltoTtlTicks: 0,          // 0 = TTL disabled
});

// Ingest an event
const ev = kernel.ingest('command:success', { action: 'click' }, {
  source:    'bridge:element-api',
  causedBy:  runningEventId,
  edgeType:  'causal/adapter',
  sessionId: 'sess-uuid',
});

// Query
kernel.findById(ev.id);
kernel.getAll();
kernel.rangeView(0, 99);
kernel.traceToRoot(ev.id, /* maxDepth */ 50);
kernel.descendants(ev.id, /* maxDepth */ 30);
kernel.edgeMeta(ev.id);     // → { fromId, toId, edgeType, confidence, dtTicks }
kernel.getChildren(ev.id);  // → Set<eventId>

// Subscribe
const unsub = kernel.subscribe(ev => { /* fires after gates */ });
unsub(); // remove listener

// Gates
kernel.registerGate('my:gate', (ev, query) => {
  if (ev.type !== 'trigger:event') return [];
  return [gateOutput('consequence:event', { ref: ev.id }, {
    source: 'gate:my:gate',
    causedBy: ev.id,
    edgeType: 'causal/rule',
  })];
}, { priority: 50 });

kernel.reset();
```

### Ingest pipeline order

1. Dedup (replay path only, LRU-bounded seenMap)
2. Build + freeze event (UUID v4 id, logical eventTs, wall ts)
3. Store in ring + indexes (O(1) typeIndex Set, edge pruning on eviction)
4. Build causal edge
5. Update macro projection
6. **Run gates** (atomic output — all or nothing)
6b. Expire stale calltos (if TTL enabled)
7. **Notify listeners** (C-4: gates always fire before listeners)

---

## Adapter

Translates bridge bus events into typed kernel events with proper causal linkage.

```js
const adapter = createAdapter(kernel);

// Bridge bus
adapter.handle('element:callto:running',  payload);
adapter.handle('element:callto:resolved', payload);
adapter.handle('element:callto:error',    payload);
adapter.handle('page:navigated',          payload);
adapter.handle('dom:changed',             payload);

// Dispatcher API
adapter.handleDispatcher('commandRunning', payload);
adapter.handleDispatcher('commandSuccess', payload);
adapter.handleDispatcher('commandFailed',  payload);

// Observer API
adapter.handleObserver('dom:changed',    payload);
adapter.handleObserver('page:navigated', payload);

// Replay from stored event
adapter.replayEvent(storedEvent);
```

---

## Query (CQL)

```js
import { query, parseQuery, execQuery } from 'causal-nexus/query';

// One-shot
const result = query("FIND events WHERE type = 'command:failed' LIMIT 20", kernel);

// With conditions
query("FIND events WHERE type = 'command:failed' AND payload.retryCount >= 3", kernel);
query("FIND events WHERE source ~= 'element' AND type IN ('command:running','command:failed')", kernel);
query("FIND events WHERE type = 'dom:changed' WITHIN 500 ticks OF 'page:navigated'", kernel);
query("FIND chains WHERE type = 'alert:critical' ORDER BY seq DESC LIMIT 5", kernel);
query("FIND events WHERE CAUSED_BY type = 'command:running'", kernel);
query("FIND events WHERE NOT type = 'system:ring:evicted'", kernel);

// QueryResult shape
// { ok, events[], total, durationMs, scope, plan: { strategy, seedSize, filterCount } }
```

Operators: `=` `!=` `>` `<` `>=` `<=` `~=` (fuzzy substring) `IN`  
Conditions: `AND` `OR` `NOT` `CAUSED_BY` `HAS_CHILD` `WITHIN N ticks OF`  
Scopes: `events` `chains`  
Execution: typeIndex O(1) fast path when `type = 'X'` is root condition, full-scan otherwise.

---

## Compress

```js
import { snapshot, restore, blueprint, compile, compressionReport } from 'causal-nexus/compress';

// Snapshot (3–5× compression vs raw JSON)
const snap = snapshot(kernel);
const restored = restore(snap);

// Blueprint — structural grammar of a session
const bp  = blueprint(kernel);
console.log(bp.vocab, bp.patterns, bp.invariants);

// Compile blueprint → executable ES module
const src = compile(bp, { format: 'esm', ringCap: 1_000_000 });

// Compression metrics
const report = compressionReport(kernel, snap);
// → { rawBytes, snapBytes, ratio, summary: '1200 KB raw → 240 KB snap (5×)' }
```

---

## Persist

```js
import { createStore, flushStore, recoverStore, archiveEvicted, queryArchive } from 'causal-nexus/persist';

// Three backends: 'memory' | 'indexeddb' | 'filesystem' | 'auto'
const store = createStore(kernel, { backend: 'auto', walFlushEvery: 100 });

await flushStore(kernel, store);

// On startup
const result = await recoverStore(store, freshKernel);
// result: { ok, snapshotEvents, walReplayed, totalRecovered, errors[] }

// Cold archive queries
await queryArchive(store, { type: 'command:failed', tsStart: Date.now() - 86400000 });

store.destroy(); // unsubscribe from kernel
```

---

## Delta

```js
import { computeDeltaStream, computeThroughputTimeline, detectFractals } from 'causal-nexus/delta';

// Full kinematic delta stream (O(n))
const deltas = computeDeltaStream(
  kernel.getAll(),
  id => kernel.findById(id),
  id => kernel.edgeMeta(id),
  id => kernel.getChildren(id),
);
// Each delta: { eventId, eventType, gap, latencyImpact, ownDepth,
//              throughputChange, childCount, structuralDeviation }

// Throughput timeline (replay-deterministic, eventTs not ts)
const timeline = computeThroughputTimeline(kernel.getAll());

// Fractal pattern detection
const fractals = detectFractals(kernel.getAll(), id=>kernel.getChildren(id), id=>kernel.edgeMeta(id), {
  findById: id => kernel.findById(id),
  minChainLen: 3, minOccurrences: 3,
});
```

---

## Forge (AI self-modification)

Requires the Anthropic API to be accessible (no key needed in the module — pass it via your environment or proxy).

```js
import { forgeModule, forgePatch, forgeGate, forgeHook } from 'causal-nexus/forge';

// Rewrite a full module
const rec = await forgeModule(moduleSrc, 'Add a rate-limit gate that fires when event rate exceeds 100/s', {
  moduleName: 'kernel', kernel, deltaLib,
});

// Minimal patch
const rec = await forgePatch(moduleSrc, {
  target: 'computeEventDelta', changeType: 'body',
  description: 'Add acceleration field K = latencyImpact delta over last 3 events',
}, { moduleName: 'delta' });

// Generate a gate
const { ok, gateFn } = await forgeGate(
  'Emit alert when 3 consecutive command:failed arrive within 1000 ticks',
  { triggerType: 'command:failed', outputType: 'alert:cascade' }
);

// Add a hook
const rec = await forgeHook(moduleSrc, {
  name: 'computeAcceleration',
  description: 'Compute rate-of-change of latencyImpact over a rolling window',
  signature: '(deltas, windowSize = 10)',
  returns: 'number[]',
  laws: ['A-2', 'H-3'],
}, { moduleName: 'delta' });
```

---

## Loader

```js
import { loadModule, hotReload, evalGate, runInlineSuite } from 'causal-nexus/loader';

// Load any module source string
const result = await loadModule(src, { name: 'my-module', kernel, runTests: true });
// result: { ok, exports, strategy, durationMs, hooksDelta, gatesRegistered, testResults }

// Hot-reload named module
await hotReload('delta', newSrc, kernel, { deltaLib });

// Live gate evaluation
const { ok, unregister } = evalGate('my:live:gate', `
  (ev, query) => {
    if (ev.type !== 'trigger') return [];
    return [gateOutput('response', { ref: ev.id }, { source: 'gate:my', causedBy: ev.id, edgeType: 'causal/rule' })];
  }
`, kernel, { priority: 50, globals: { gateOutput } });
```

---

## Design laws

These invariants are enforced throughout and tested in the cross-domain suite:

| Law | Rule |
|-----|------|
| **I-1** | `event.id` is UUID v4 — never deterministic, never reused |
| **I-2** | `contentHash` is orthogonal to `id` — identical payloads → same hash, different id |
| **C-1** | Every edge has explicitly declared `edgeType` at ingestion time |
| **C-2** | `macro:detected` is never a kernel event — projection only |
| **C-3** | `traceToRoot` traverses only `causal/*` edges, not `observational` |
| **C-4** | Gates execute before listeners |
| **T-1** | Clock is kernel-instance-local — no global state |
| **T-2** | `ev.ts` (wall clock) is for display only; `ev.eventTs` (logical tick) drives ordering |
| **A-2** | Gates return `GateOutput[]` — they never call `kernel.ingest()` directly |
| **H-1** | Edge graph pruned on ring eviction — memory bounded |
| **H-2** | `typeIndex` uses `Set<id>` per type — O(1) add/delete/has |
| **H-3** | `query.typeIds()` returns a defensive copy — gates cannot corrupt the index |
| **H-6** | `seenMap` LRU-bounded at 10,000 entries under replay flood |

---

## Tests

```
node test/run-all.js          # 195 tests
node test/run-all.js --unit   # unit only
node test/run-all.js --cross  # cross-domain invariants only
```

---

## Architecture notes

**No circular dependencies.** The lower five modules (`identity`, `time`, `causality`, `projection`, `lazy`) have zero imports and can be used standalone. Everything else builds upward.

**`persist` uses dynamic import for `compress`** at flush/recover time to avoid the circular dependency that would result from `compress` importing `kernel` and `persist` importing `compress` at load time.

**`query` accesses `kernel._typeIndex` directly** for the O(1) fast path. This is a deliberate coupling — the `_` prefix signals read-only internal access. If you change `_typeIndex` in kernel, audit `query.js`.

**`forge.forgeHook` produces stable UUIDs.** Calling `forgeHook` twice with the same module name + hook name produces the same UUID. `forgePatch` and `forgeModule` include `Date.now()` for uniqueness of patch records.

**`WITHIN N ticks OF 'type'`** anchors to the first matching event of that type, not the nearest. For multi-event sessions, use explicit `eventTs` range conditions if nearest-anchor semantics are needed.

**`archiveEvicted` wiring** requires a side-channel reference to the evicted event object. The kernel emits `system:ring:evicted` with `{ cap, evictedSeq }` but not the object itself. Intercept at the application layer and pass the object to `archiveEvicted()` directly.

---

## Version history

- **4.5.2** — This release. Synthesized from main + v1.0.0 + v4.5.1 + D.zip. All audit findings addressed.
- **4.5.0** — Persist (WAL/IndexedDB/filesystem) + CQL query engine
- **4.4.0** — Forge + Loader (AI self-modification, hot reload)
- **4.3.0** — Hostile hardening H-1..H-6 + compress module
- **4.2.0** — Gate architecture K-1..K-5, A-2 proper fix
- **4.0.0** — Full causal engine rewrite (identity, time, causality separation)

Project UUID: `eecaa718-c6a6-4433-b02a-11ecbefd4740`
