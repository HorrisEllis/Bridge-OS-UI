// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
/**
 * @module       adapter-sandbox
 * @uuid         b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e
 * @version      5.0.0
 *
 * Side-effect policy enforcement for adapters across execution contexts.
 *
 * Side-Effect Containment Axiom:
 *   Adapters declare READ_ONLY, LOCAL_ONLY, or FULL side-effect policy
 *   at registration. Policy is immutable after registration. In ReplayContext:
 *   FULL and LOCAL_ONLY adapters are replaced with null adapters. Undeclared
 *   policy defaults to FULL and is nulled in replay. No exceptions.
 *
 * Policy semantics:
 *   READ_ONLY   — may read external state, never writes. Safe in replay.
 *   LOCAL_ONLY  — reads/writes kernel-local state only. Nulled in replay.
 *   FULL        — may read/write external state (network, fs, UI). Nulled in replay.
 *
 * Control Surface Axiom:
 *   Policy is declared at adapter registration and is immutable thereafter.
 *   It cannot be overridden per-context.
 *
 * @hook b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e  createAdapterSandbox
 * @hook c2d3e4f5-a6b7-4c8d-9e0f-1a2b3c4d5e6f  registerAdapter
 * @hook d3e4f5a6-b7c8-4d9e-0f1a-2b3c4d5e6f7a  instantiateAdapter
 * @hook e4f5a6b7-c8d9-4e0f-1a2b-3c4d5e6f7a8b  createNullAdapter
 * @hook f5a6b7c8-d9e0-4f1a-2b3c-4d5e6f7a8b9c  POLICY_READ_ONLY
 * @hook a6b7c8d9-e0f1-4a2b-3c4d-5e6f7a8b9c0d  POLICY_LOCAL_ONLY
 * @hook b7c8d9e0-f1a2-4b3c-4d5e-6f7a8b9c0d1e  POLICY_FULL
 * @hook c8d9e0f1-a2b3-4c4d-5e6f-7a8b9c0d1e2f  AdapterRegistrationError
 * @hook d9e0f1a2-b3c4-4d5e-6f7a-8b9c0d1e2f3a  VALID_POLICIES
 */

'use strict';

// ── Policy constants ──────────────────────────────────────────────────────────

export const POLICY_READ_ONLY  = 'READ_ONLY';
export const POLICY_LOCAL_ONLY = 'LOCAL_ONLY';
export const POLICY_FULL       = 'FULL';

export const VALID_POLICIES = new Set([POLICY_READ_ONLY, POLICY_LOCAL_ONLY, POLICY_FULL]);

// ── Error type ────────────────────────────────────────────────────────────────

export class AdapterRegistrationError extends Error {
  constructor(message, context = {}) {
    super(`[adapter-sandbox] ${message}`);
    this.name    = 'AdapterRegistrationError';
    this.context = context;
  }
}

// ── Null adapter ──────────────────────────────────────────────────────────────

/**
 * Produce a null adapter that mirrors the shape of a real adapter.
 * All function properties become silent no-ops returning undefined.
 * Non-function properties become null — observable, not hidden.
 * Frozen — cannot be mutated after creation.
 *
 * @hook e4f5a6b7-c8d9-4e0f-1a2b-3c4d5e6f7a8b  adapter-sandbox:createNullAdapter
 */
export function createNullAdapter(shape, name, policy) {
  const nullMethods = {};
  for (const key of Object.keys(shape)) {
    if (typeof shape[key] === 'function') {
      nullMethods[key] = function nullMethod() { return undefined; };
    } else {
      nullMethods[key] = null;
    }
  }
  return Object.freeze({
    ...nullMethods,
    _isNullAdapter:   true,
    _adapterName:     name,
    _originalPolicy:  policy,
  });
}

// ── createAdapterSandbox ──────────────────────────────────────────────────────

/**
 * Create an adapter sandbox — registry of adapter factories with immutable
 * side-effect policies.
 *
 * @hook b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e  adapter-sandbox:createAdapterSandbox
 */
export function createAdapterSandbox() {
  const _registry = new Map(); // name → { name, factory, policy, registeredAt }

  // ── register ─────────────────────────────────────────────────────────────

  /**
   * Register an adapter factory with an immutable side-effect policy.
   * Undeclared policy defaults to FULL. Duplicate names throw.
   *
   * @hook c2d3e4f5-a6b7-4c8d-9e0f-1a2b3c4d5e6f  adapter-sandbox:registerAdapter
   */
  function register(name, factory, opts = {}) {
    if (typeof name !== 'string' || !name.trim()) {
      throw new AdapterRegistrationError('name must be a non-empty string', { name });
    }
    if (typeof factory !== 'function') {
      throw new AdapterRegistrationError(
        `factory must be a function, got ${typeof factory}`,
        { name, factoryType: typeof factory }
      );
    }
    if (_registry.has(name)) {
      throw new AdapterRegistrationError(
        `adapter '${name}' is already registered — policy is immutable after registration`,
        { name, existingPolicy: _registry.get(name).policy }
      );
    }

    // Undeclared → FULL: strictest default, nulled in replay
    const policy = opts.policy !== undefined ? opts.policy : POLICY_FULL;

    if (!VALID_POLICIES.has(policy)) {
      throw new AdapterRegistrationError(
        `invalid policy '${policy}' — must be one of: ${[...VALID_POLICIES].join(', ')}`,
        { name, policy }
      );
    }

    const registration = Object.freeze({ name, factory, policy, registeredAt: Date.now() });
    _registry.set(name, registration);
    return { name, policy, registeredAt: registration.registeredAt };
  }

  // ── instantiate ──────────────────────────────────────────────────────────

  /**
   * Instantiate a registered adapter for a kernel and context type.
   *
   * In replay (opts.replay = true):
   *   FULL       → NullAdapter   (no external writes)
   *   LOCAL_ONLY → NullAdapter   (replay isolation)
   *   READ_ONLY  → real adapter  (safe — never writes)
   *
   * In live (opts.replay = false, default):
   *   All policies → real adapter
   *
   * @hook d3e4f5a6-b7c8-4d9e-0f1a-2b3c4d5e6f7a  adapter-sandbox:instantiateAdapter
   */
  function instantiate(name, kernel, opts = {}) {
    if (!_registry.has(name)) {
      throw new AdapterRegistrationError(
        `adapter '${name}' is not registered`,
        { name, registered: [..._registry.keys()] }
      );
    }

    const reg      = _registry.get(name);
    const isReplay = !!opts.replay;

    if (isReplay && (reg.policy === POLICY_FULL || reg.policy === POLICY_LOCAL_ONLY)) {
      // Build real adapter shape once to mirror API surface, then discard.
      // If factory throws (e.g. needs external state unavailable in replay),
      // fall back to empty shape — null adapter must always succeed.
      let realShape;
      try   { realShape = reg.factory(kernel, opts.factoryOpts || {}); }
      catch (_) { realShape = {}; }
      return createNullAdapter(realShape, name, reg.policy);
    }

    return reg.factory(kernel, opts.factoryOpts || {});
  }

  // ── introspection ─────────────────────────────────────────────────────────

  function getRegistration(name) {
    const reg = _registry.get(name);
    if (!reg) return null;
    return { name: reg.name, policy: reg.policy, registeredAt: reg.registeredAt };
  }

  function listRegistrations() {
    return [..._registry.values()]
      .sort((a, b) => a.registeredAt - b.registeredAt)
      .map(r => ({ name: r.name, policy: r.policy, registeredAt: r.registeredAt }));
  }

  return {
    register,
    instantiate,
    getRegistration,
    listRegistrations,
    get size() { return _registry.size; },
  };
}
