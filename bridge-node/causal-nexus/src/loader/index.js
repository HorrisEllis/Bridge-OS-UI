// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
/**
 * @module       loader
 * @uuid         8bfdf8c2-1955-4dc7-a5be-4fd99a14fd7d
 * @version      5.0.0
 *
 * Hot module loading for the Causal Nexus runtime.
 *
 * Strategy cascade for loadModule():
 *   1. Blob URL + dynamic import() — ES module semantics, browser only
 *   2. Function() constructor — strips import/export, works everywhere
 *      Note: only handles single-line named imports. Multi-line imports
 *      require preprocessing before passing to loadModule().
 *
 * Known limitation (documented): _stripModuleSyntax regex only matches
 * single-line `import { ... } from '...'` patterns. Multi-line named
 * imports produce orphaned `} from '...';` tokens on strategy 2.
 * Pre-process multi-line imports with a bundler or manually collapse them.
 *
 * evalGate note: cannot update an existing gate (registerGate throws on
 * duplicate signature). To replace a gate, use the unregister handle from
 * the original registration before calling evalGate again.
 *
 * @hook 3034cc43-8a1c-40b2-8abc-1fa9eb96390b  loadModule
 * @hook 35c5227c-c38c-4e4d-a1d7-c5dc08c68975  hotReload
 * @hook 0588de69-bcdd-45c1-8e8b-65291cf242ac  evalGate
 * @hook f90347d5-32f7-40d1-a09e-fb26b9acc7c1  runInlineSuite
 * @hook d7e8f9a0-b1c2-4d3e-9f0a-1b2c3d4e5f6a  hotReloadContext
 * @hook 7a149e7c-9308-402f-a175-c05f57c1090e  LoadResult
 */

'use strict';

// ── LoadResult ────────────────────────────────────────────────────────────────

/**
 * @hook 7a149e7c-9308-402f-a175-c05f57c1090e  loader:LoadResult
 */
export const LoadResult = {
  create(fields) {
    return Object.freeze({
      ok: false, exports: null, error: null, strategy: 'function',
      durationMs: 0, hooksDelta: [], gatesRegistered: [], testResults: null,
      ...fields,
    });
  },
};

// ── Module source manipulation ────────────────────────────────────────────────

/**
 * Strip ES module syntax for Function() strategy.
 * Limitation: single-line imports only. Multi-line imports not handled.
 */
function _stripModuleSyntax(src) {
  return src
    .replace(/^import\s+\{[^}]+\}\s+from\s+'[^']+';?\s*\n/gm, '')
    .replace(/^import\s+\*\s+as\s+\w+\s+from\s+'[^']+';?\s*\n/gm, '')
    .replace(/^import\s+\w+\s+from\s+'[^']+';?\s*\n/gm, '')
    .replace(/^export\s+(function|const|class|let|var)\b/gm, '$1')
    .replace(/^export\s+\{[^}]+\};\s*\n/gm, '')
    .replace(/^export\s+default\s+/gm, 'const _defaultExport = ');
}

function _extractExportNames(src) {
  const names    = new Set();
  const patterns = [
    /^export\s+function\s+(\w+)/gm,
    /^export\s+const\s+(\w+)/gm,
    /^export\s+class\s+(\w+)/gm,
    /^export\s+\{\s*([^}]+)\}/gm,
  ];
  for (const pat of patterns) {
    let m;
    while ((m = pat.exec(src)) !== null) {
      m[1].split(',').forEach(n => names.add(n.trim().split(/\s+as\s+/)[0].trim()));
    }
  }
  return [...names].filter(Boolean);
}

function _extractHookUUIDs(src) {
  const uuids = [];
  const pat   = /@hook\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g;
  let m;
  while ((m = pat.exec(src)) !== null) uuids.push(m[1]);
  return uuids;
}

// ── loadModule ────────────────────────────────────────────────────────────────

/**
 * Load a module source string into the live runtime.
 *
 * @param {string}  src
 * @param {object}  [opts]
 *   opts.name      {string}   module name for logging
 *   opts.globals   {object}   extra globals to inject into Function() scope
 *   opts.kernel    {object}   kernel for gate registration + event ingestion
 *   opts.runTests  {boolean}  run exports.inlineSuite() if present (default true)
 *   opts.strategy  {'auto'|'function'|'blob'}
 *
 * @hook 3034cc43-8a1c-40b2-8abc-1fa9eb96390b  loader:loadModule
 */
export async function loadModule(src, {
  name     = 'anonymous',
  globals  = {},
  kernel   = null,
  runTests = true,
  strategy = 'auto',
} = {}) {
  const t0              = performance.now();
  const hooksDelta      = _extractHookUUIDs(src);
  const exportNames     = _extractExportNames(src);
  const gatesRegistered = [];

  const useBlob = (strategy === 'blob') ||
    (strategy === 'auto' && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function');

  let exports = null;
  let error   = null;
  let strat   = 'function';

  // Strategy 1: Blob URL + dynamic import()
  if (useBlob) {
    try {
      const blob = new Blob([src], { type: 'text/javascript' });
      const url  = URL.createObjectURL(blob);
      exports    = await import(url);
      URL.revokeObjectURL(url);
      strat = 'blob';
    } catch (e) { error = e; }
  }

  // Strategy 2: Function() constructor
  if (!exports) {
    try {
      const stripped   = _stripModuleSyntax(src);
      const allGlobals = {
        ...globals,
        performance: typeof performance !== 'undefined' ? performance : { now: Date.now.bind(Date) },
      };
      const paramNames = Object.keys(allGlobals);
      const paramVals  = Object.values(allGlobals);
      const returnStmt = exportNames.length > 0
        ? `\nreturn { ${exportNames.join(', ')} };`
        : '\nreturn {};';
      const fn = new Function(...paramNames, `'use strict';\n${stripped}${returnStmt}`);
      exports  = fn(...paramVals);
      strat    = 'function';
      error    = null;
    } catch (e) { error = e; }
  }

  if (!exports || error) {
    return LoadResult.create({ ok: false, error: error || new Error('load failed'), strategy: strat, durationMs: performance.now() - t0, hooksDelta });
  }

  // Register gates declared by module (convention: exports.gates or exports.GATES)
  if (kernel && (exports.gates || exports.GATES)) {
    const gateMap = exports.gates || exports.GATES;
    for (const [sig, def] of Object.entries(gateMap)) {
      try {
        kernel.registerGate(sig, def.fn || def, { priority: def.priority || 50 });
        gatesRegistered.push(sig);
      } catch (_) { /* already registered — skip */ }
    }
  }

  // Run inline test suite if present
  let testResults = null;
  if (runTests && typeof exports.inlineSuite === 'function') {
    testResults = await runInlineSuite(exports.inlineSuite);
  }

  // Ingest self-modification event
  if (kernel) {
    kernel.ingest('nexus:module:loaded', {
      module: name, strategy: strat, exportCount: Object.keys(exports).length,
      hooksDelta, gatesRegistered, testsPassed: testResults?.passed ?? null,
      testsFailed: testResults?.failed ?? null,
    }, { source: 'loader:loadModule' });
  }

  return LoadResult.create({
    ok: true, exports, error: null, strategy: strat,
    durationMs: Math.round(performance.now() - t0),
    hooksDelta, gatesRegistered, testResults,
  });
}

// ── hotReload ─────────────────────────────────────────────────────────────────

/**
 * Hot-reload a named module — live replacement of an existing module.
 * Calls exports.activate(kernel) if exported, records a delta-lib patch entry.
 *
 * @hook 35c5227c-c38c-4e4d-a1d7-c5dc08c68975  loader:hotReload
 */
export async function hotReload(moduleName, newSrc, kernel, {
  globals   = {},
  deltaLib  = null,
  patchMeta = {},
} = {}) {
  const result = await loadModule(newSrc, { name: moduleName, globals, kernel, runTests: true, strategy: 'auto' });

  if (!result.ok) {
    kernel?.ingest('nexus:module:reload:failed', {
      module: moduleName, error: result.error?.message || 'unknown', strategy: result.strategy,
    }, { source: 'loader:hotReload' });
    return result;
  }

  if (typeof result.exports?.activate === 'function') {
    try { result.exports.activate(kernel); }
    catch (e) { kernel?.ingest('nexus:module:activate:failed', { module: moduleName, error: e.message }, { source: 'loader:hotReload' }); }
  }

  if (deltaLib && Array.isArray(deltaLib.patches)) {
    deltaLib.patches.push({
      uuid:        _quickUuid(moduleName + newSrc.length + Date.now()),
      phase:       patchMeta.phase   || 'runtime',
      version:     patchMeta.version || 'live',
      module:      moduleName,
      type:        'hot-reload',
      summary:     patchMeta.summary || `Hot reload of ${moduleName}`,
      ts:          Date.now(),
      hooksDelta:  result.hooksDelta,
      testsPassed: result.testResults?.passed ?? null,
      testsFailed: result.testResults?.failed ?? null,
    });
  }

  kernel?.ingest('nexus:module:patched', {
    module: moduleName, hooksDelta: result.hooksDelta,
    gatesRegistered: result.gatesRegistered, durationMs: result.durationMs,
    testsPassed: result.testResults?.passed ?? null, testsFailed: result.testResults?.failed ?? null,
  }, { source: 'loader:hotReload' });

  return result;
}

// ── evalGate ──────────────────────────────────────────────────────────────────

/**
 * Evaluate a gate function body string and register it into the kernel.
 *
 * Note: cannot replace an existing gate with the same signature — registerGate
 * throws on duplicate. Use the unregister handle from the original registration
 * before calling evalGate again with the same signature.
 *
 * @hook 0588de69-bcdd-45c1-8e8b-65291cf242ac  loader:evalGate
 */
export function evalGate(signature, fnSource, kernel, { priority = 50, globals = {} } = {}) {
  if (!signature || !fnSource || !kernel) {
    return { ok: false, signature, error: new Error('evalGate: signature, fnSource, kernel required'), unregister: null };
  }

  let fn;
  try {
    const paramNames = Object.keys(globals);
    const paramVals  = Object.values(globals);
    const wrapper    = new Function(...paramNames, `'use strict'; return (${fnSource});`);
    fn               = wrapper(...paramVals);
    if (typeof fn !== 'function') throw new Error('evalGate: source did not evaluate to a function');
  } catch (e) {
    return { ok: false, signature, error: e, unregister: null };
  }

  try {
    const unregister = kernel.registerGate(signature, fn, { priority });
    kernel.ingest('nexus:gate:registered', { signature, priority, source: 'eval' }, { source: 'loader:evalGate' });
    return { ok: true, signature, error: null, unregister };
  } catch (e) {
    return { ok: false, signature, error: e, unregister: null };
  }
}

// ── runInlineSuite ────────────────────────────────────────────────────────────

/**
 * Run an inline test suite exported by a loaded module.
 * Convention: module exports `inlineSuite(harness)` where harness = { test, assert, assertEqual }.
 *
 * @hook f90347d5-32f7-40d1-a09e-fb26b9acc7c1  loader:runInlineSuite
 */
export async function runInlineSuite(suiteFn) {
  const results = [];
  let passed = 0, failed = 0;

  const harness = {
    test(name, fn) {
      try {
        const r = fn();
        if (r instanceof Promise) throw new Error('async tests not supported in inline suite');
        results.push({ name, ok: true });
        passed++;
      } catch (e) {
        results.push({ name, ok: false, error: e.message });
        failed++;
      }
    },
    assert(condition, msg = 'assertion failed') {
      if (!condition) throw new Error(msg);
    },
    assertEqual(a, b, msg) {
      const ja = JSON.stringify(a), jb = JSON.stringify(b);
      if (ja !== jb) throw new Error(msg || `expected ${jb}, got ${ja}`);
    },
  };

  try { suiteFn(harness); }
  catch (e) { results.push({ name: 'suite:setup', ok: false, error: e.message }); failed++; }

  return { passed, failed, total: passed + failed, results };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function _quickUuid(seed) {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
  const hex = h.toString(16).padStart(8, '0');
  return `${hex}-0000-4000-8000-${Date.now().toString(16).padStart(12,'0')}`;
}

// ── hotReloadContext ──────────────────────────────────────────────────────────

/**
 * Context-aware hot-reload entry point.
 *
 * Refuses to operate on a ReplayContext — replay isolation is structural
 * and a hot-reload into a replay kernel would corrupt the causal record
 * (§1.2, §3.2, CI-1..CI-6).
 *
 * Routes the patch to liveContext.kernel and delegates to hotReload().
 * Patched gates do not affect any existing replay instances because
 * replay kernels are independent objects (CI-1 — structural isolation).
 *
 * @hook d7e8f9a0-b1c2-4d3e-9f0a-1b2c3d4e5f6a  loader:hotReloadContext
 *
 * @param {string}      moduleName
 * @param {string}      newSrc
 * @param {LiveContext}  liveContext   — must have type === 'live'
 * @param {object}      [opts]         — forwarded to hotReload()
 * @returns {Promise<LoadResult>}
 */
export async function hotReloadContext(moduleName, newSrc, liveContext, opts = {}) {
  // Guard: refuse replay contexts — loud, specific, traceable (§1.2)
  if (!liveContext || typeof liveContext !== 'object') {
    return LoadResult.create({
      ok:    false,
      error: new Error('[loader:hotReloadContext] liveContext is required'),
    });
  }

  if (liveContext.type !== 'live') {
    return LoadResult.create({
      ok:    false,
      error: new Error(
        `[loader:hotReloadContext] refused: context type is '${liveContext.type}'. ` +
        'Hot-reload into a ReplayContext would violate replay isolation (CI-1..CI-6). ' +
        'Pass a LiveContext instead.'
      ),
    });
  }

  const kernel = liveContext.kernel;
  if (!kernel || typeof kernel.ingest !== 'function') {
    return LoadResult.create({
      ok:    false,
      error: new Error('[loader:hotReloadContext] liveContext.kernel is not a valid kernel instance'),
    });
  }

  return hotReload(moduleName, newSrc, kernel, opts);
}
