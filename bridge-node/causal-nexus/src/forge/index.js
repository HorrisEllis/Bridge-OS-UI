// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
/**
 * @module       forge
 * @uuid         0091ce2c-287d-4a7b-827a-60c7fb7793d7
 * @version      5.0.0
 *
 * AI-powered self-modification engine. Calls the Anthropic API to rewrite,
 * patch, generate gates, or add hooks to live modules.
 *
 * Four entry points:
 *   forgeModule(src, instruction, opts)  — full module rewrite
 *   forgePatch(src, patchSpec, opts)     — minimal targeted patch
 *   forgeGate(description, opts)         — generate gate function body
 *   forgeHook(src, hookSpec, opts)       — add new exported function with UUID
 *
 * Design laws enforced in SYSTEM_NUCLEUS prompt (never violate):
 *   I-1  event.id is UUID v4 — never deterministic, never reused
 *   C-1  every edge has explicitly declared edgeType
 *   C-2  macro:detected is never a kernel event
 *   C-4  gates execute before listeners
 *   A-2  gates return GateOutput[] — never call ingest() directly
 *   H-1  edge graph bounded — pruned on ring eviction
 *   H-2  typeIndex O(1) — Set<id> per type
 *   H-3  query.typeIds() returns defensive copy
 *   H-6  seenMap LRU-bounded at 10,000
 *
 * Fix (audit finding): _deterministicUuid for forgeHook now accepts a stable
 * seed without Date.now(), producing a stable UUID per (module, hook name) pair.
 * _patchUuid still includes Date.now() for uniqueness of patch records.
 *
 * @hook 1bcd9b96-0d13-48b5-84d0-044b7c768be9  forgeModule
 * @hook 60de8b56-ccd2-40ba-95d0-e03d191c8484  forgePatch
 * @hook 3b160d46-8e4e-4c69-bc3c-0c7e577b2209  forgeGate
 * @hook 674d5576-5fb4-40d9-add7-ee9c26ce7f9a  forgeHook
 * @hook df40d4ff-6d77-4656-86f8-1c50ee3b1afa  ForgePatchRecord
 */

'use strict';

const FORGE_MODEL  = 'claude-sonnet-4-20250514';
const FORGE_TOKENS = 4096;
const FORGE_API    = 'https://api.anthropic.com/v1/messages';

// ── ForgePatchRecord ──────────────────────────────────────────────────────────

/**
 * Standard shape returned by all forge operations.
 * @hook df40d4ff-6d77-4656-86f8-1c50ee3b1afa  forge:ForgePatchRecord
 */
export const ForgePatchRecord = {
  create(fields) {
    return Object.freeze({
      uuid: null, module: null, instruction: null, strategy: null,
      src: null, gateFn: null, hooksDelta: [], inputTokens: 0,
      outputTokens: 0, durationMs: 0, ts: Date.now(), ...fields,
    });
  },
};

// ── System prompt nucleus ─────────────────────────────────────────────────────

const SYSTEM_NUCLEUS = `\
You are the Causal Nexus forge — an AI that modifies live JavaScript modules
in a running causal event engine.

DESIGN LAWS (never violate):
  I-1  event.id is UUID v4 — never deterministic, never reused
  C-1  every edge has explicitly declared edgeType at ingestion time
  C-2  macro:detected is never a kernel event — projection only
  C-4  gates execute before listeners
  A-2  gates return GateOutput[] — never call ingest() directly
  H-1  edge graph is bounded — edges pruned on ring eviction
  H-2  typeIndex is O(1) — Set<id> per type
  H-3  query.typeIds() returns a defensive copy
  H-6  seenMap is LRU-bounded at 10,000 entries

AXIOMS:
  - Zero external dependencies. Never import from npm.
  - All mutations flow through the kernel API.
  - Projections are read-only — they never call kernel.ingest().
  - Every new exported symbol must have a @hook UUID comment above it.
    Format: // @hook <uuid>  <module>:<symbol>  kind:<function|factory|constant>
  - Source is ES module syntax (import/export). Keep it.
  - Never remove existing @hook UUIDs or change existing function signatures.
  - Loud failure modes: errors must be observable, never silently swallowed.`;

// ── API call ──────────────────────────────────────────────────────────────────

async function _callAPI(systemPrompt, userMessage) {
  const t0  = performance.now();
  const res = await fetch(FORGE_API, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      model:      FORGE_MODEL,
      max_tokens: FORGE_TOKENS,
      system:     systemPrompt,
      messages:   [{ role: 'user', content: userMessage }],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Forge API error ${res.status}: ${body.slice(0, 200)}`);
  }
  const data       = await res.json();
  const text       = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const durationMs = Math.round(performance.now() - t0);
  return { text, inputTokens: data.usage?.input_tokens || 0, outputTokens: data.usage?.output_tokens || 0, durationMs };
}

function _extractCode(text) {
  const jsBlock    = text.match(/```(?:javascript|js)\s*\n([\s\S]*?)```/);
  if (jsBlock) return jsBlock[1].trim();
  const plainBlock = text.match(/```\s*\n([\s\S]*?)```/);
  if (plainBlock) return plainBlock[1].trim();
  return text.trim();
}

function _extractHookUUIDs(src) {
  const uuids = [];
  const pat   = /@hook\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g;
  let m;
  while ((m = pat.exec(src)) !== null) uuids.push(m[1]);
  return uuids;
}

function _newHooks(oldSrc, newSrc) {
  const oldSet = new Set(_extractHookUUIDs(oldSrc));
  return _extractHookUUIDs(newSrc).filter(u => !oldSet.has(u));
}

// ── UUID helpers ──────────────────────────────────────────────────────────────

/**
 * FNV-based UUID — stable per seed (no Date.now).
 * Used for hook identity where stability across calls matters.
 */
function _stableUuid(seed) {
  let h1 = 0x811c9dc5, h2 = 0x1000193;
  for (let i = 0; i < seed.length; i++) {
    const c = seed.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x811c9dc5) >>> 0;
  }
  const h3 = (h1 ^ h2) >>> 0;
  const h4 = (h2 ^ (h1 << 5)) >>> 0;
  const hex = (
    h1.toString(16).padStart(8,'0') + h2.toString(16).padStart(8,'0') +
    h3.toString(16).padStart(8,'0') + h4.toString(16).padStart(8,'0')
  ).slice(0, 32);
  const b = hex.match(/.{1,2}/g).map(x => parseInt(x, 16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.map(x => x.toString(16).padStart(2,'0')).join('');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`;
}

/** UUID for patch records — includes Date.now() for uniqueness. */
function _patchUuid(seed1, seed2) {
  return _stableUuid(`patch:${seed1}:${seed2.slice(0, 40)}:${Date.now()}`);
}

// ── forgeModule ───────────────────────────────────────────────────────────────

/**
 * Rewrite an entire module with an AI instruction.
 * @hook 1bcd9b96-0d13-48b5-84d0-044b7c768be9  forge:forgeModule
 */
export async function forgeModule(moduleSrc, instruction, {
  moduleName = 'unknown', manifest = null, kernel = null, deltaLib = null,
} = {}) {
  const system = `${SYSTEM_NUCLEUS}\n\nYou are patching the '${moduleName}' module.${
    manifest ? `\n\nModule context:\n${JSON.stringify(manifest, null, 2)}` : ''
  }\n\nReturn ONLY the complete patched JavaScript source in a \`\`\`javascript block.`;
  const user = `Current source:\n\`\`\`javascript\n${moduleSrc}\n\`\`\`\n\nInstruction: ${instruction}`;

  let apiResult;
  try { apiResult = await _callAPI(system, user); }
  catch (e) {
    kernel?.ingest('nexus:forge:failed', { module: moduleName, error: e.message, strategy: 'module' }, { source: 'forge:forgeModule' });
    return ForgePatchRecord.create({ module: moduleName, instruction, strategy: 'module', error: e });
  }

  const newSrc     = _extractCode(apiResult.text);
  const hooksDelta = _newHooks(moduleSrc, newSrc);
  const rec        = ForgePatchRecord.create({
    uuid: _patchUuid(moduleName, instruction), module: moduleName, instruction,
    strategy: 'module', src: newSrc, hooksDelta,
    inputTokens: apiResult.inputTokens, outputTokens: apiResult.outputTokens,
    durationMs: apiResult.durationMs, ts: Date.now(),
  });

  if (deltaLib?.patches) deltaLib.patches.push(rec);
  kernel?.ingest('nexus:forge:complete', { module: moduleName, strategy: 'module', hooksDelta, durationMs: rec.durationMs }, { source: 'forge:forgeModule' });
  return rec;
}

// ── forgePatch ────────────────────────────────────────────────────────────────

/**
 * Apply a minimal targeted patch from a structured spec.
 * @hook 60de8b56-ccd2-40ba-95d0-e03d191c8484  forge:forgePatch
 */
export async function forgePatch(moduleSrc, patchSpec, {
  moduleName = 'unknown', kernel = null, deltaLib = null,
} = {}) {
  const instruction = `Apply this patch:\n${JSON.stringify(patchSpec, null, 2)}`;
  const system = `${SYSTEM_NUCLEUS}\n\nApply a minimal targeted patch to '${moduleName}'.\nReturn ONLY the complete patched JavaScript source in a \`\`\`javascript block.`;
  const user   = `Current source:\n\`\`\`javascript\n${moduleSrc}\n\`\`\`\n\nPatch spec:\n${JSON.stringify(patchSpec, null, 2)}`;

  let apiResult;
  try { apiResult = await _callAPI(system, user); }
  catch (e) {
    kernel?.ingest('nexus:forge:failed', { module: moduleName, error: e.message, strategy: 'patch' }, { source: 'forge:forgePatch' });
    return ForgePatchRecord.create({ module: moduleName, instruction, strategy: 'patch', error: e });
  }

  const newSrc     = _extractCode(apiResult.text);
  const hooksDelta = _newHooks(moduleSrc, newSrc);
  const rec        = ForgePatchRecord.create({
    uuid: _patchUuid(moduleName, JSON.stringify(patchSpec)), module: moduleName, instruction,
    strategy: 'patch', src: newSrc, hooksDelta,
    inputTokens: apiResult.inputTokens, outputTokens: apiResult.outputTokens,
    durationMs: apiResult.durationMs, ts: Date.now(),
  });

  if (deltaLib?.patches) deltaLib.patches.push(rec);
  kernel?.ingest('nexus:forge:complete', { module: moduleName, strategy: 'patch', hooksDelta, durationMs: rec.durationMs }, { source: 'forge:forgePatch' });
  return rec;
}

// ── forgeGate ─────────────────────────────────────────────────────────────────

/**
 * Generate a gate function body from a natural language description.
 * Returns an arrow function string ready for evalGate().
 * @hook 3b160d46-8e4e-4c69-bc3c-0c7e577b2209  forge:forgeGate
 */
export async function forgeGate(description, {
  triggerType = null, outputType = null, kernel = null, globals = {},
} = {}) {
  const availableGlobals = ['gateOutput', ...Object.keys(globals)].join(', ');
  const system = `${SYSTEM_NUCLEUS}\n\nGenerate a gate function for Causal Nexus.\n\nGate contract (A-2):\n  - Gates receive (ev, query)\n  - Gates must return GateOutput[] via gateOutput()\n  - Gates NEVER call kernel.ingest() directly\n\nAvailable: ${availableGlobals}\n\nReturn ONLY the arrow function expression in a \`\`\`javascript block.`;
  const hints  = [description, triggerType && `Trigger: '${triggerType}'`, outputType && `Output: '${outputType}'`].filter(Boolean).join('\n');

  let apiResult;
  try { apiResult = await _callAPI(system, `Gate description:\n${hints}`); }
  catch (e) {
    kernel?.ingest('nexus:forge:gate:failed', { error: e.message }, { source: 'forge:forgeGate' });
    return { ok: false, gateFn: null, error: e, durationMs: 0 };
  }

  const gateFn = _extractCode(apiResult.text);
  kernel?.ingest('nexus:forge:gate:generated', { description, triggerType, outputType, durationMs: apiResult.durationMs }, { source: 'forge:forgeGate' });
  return { ok: true, gateFn, error: null, durationMs: apiResult.durationMs };
}

// ── forgeHook ─────────────────────────────────────────────────────────────────

/**
 * Add a new exported function to a module with a stable hook UUID.
 *
 * Fix: hookUuid is now derived from _stableUuid(moduleName:hookName) — stable
 * across repeated calls with the same inputs, as hook identity requires.
 *
 * @hook 674d5576-5fb4-40d9-add7-ee9c26ce7f9a  forge:forgeHook
 */
export async function forgeHook(moduleSrc, hookSpec, {
  moduleName = 'unknown', kernel = null, deltaLib = null,
} = {}) {
  // Stable UUID: same module+name always produces the same UUID
  const hookUuid = _stableUuid(`${moduleName}:${hookSpec.name}`);

  const system = `${SYSTEM_NUCLEUS}\n\nAdd a new exported function to '${moduleName}'.\nInject this @hook comment immediately above the export:\n// @hook ${hookUuid}  ${moduleName}:${hookSpec.name}  kind:function\n\nReturn ONLY the complete patched source in a \`\`\`javascript block.`;
  const user   = `Current source:\n\`\`\`javascript\n${moduleSrc}\n\`\`\`\n\nNew function spec:\n${JSON.stringify(hookSpec, null, 2)}`;

  let apiResult;
  try { apiResult = await _callAPI(system, user); }
  catch (e) {
    kernel?.ingest('nexus:forge:failed', { module: moduleName, error: e.message, strategy: 'hook' }, { source: 'forge:forgeHook' });
    return ForgePatchRecord.create({ module: moduleName, instruction: hookSpec.name, strategy: 'hook', error: e });
  }

  const newSrc = _extractCode(apiResult.text);
  const rec    = ForgePatchRecord.create({
    uuid: hookUuid, module: moduleName, instruction: `Add hook: ${hookSpec.name}`,
    strategy: 'hook', src: newSrc, hooksDelta: [hookUuid],
    inputTokens: apiResult.inputTokens, outputTokens: apiResult.outputTokens,
    durationMs: apiResult.durationMs, ts: Date.now(),
  });

  if (deltaLib?.patches) deltaLib.patches.push(rec);
  kernel?.ingest('nexus:forge:hook:added', { module: moduleName, hookName: hookSpec.name, hookUuid, durationMs: rec.durationMs }, { source: 'forge:forgeHook' });
  return rec;
}
