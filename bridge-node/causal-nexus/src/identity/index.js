// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
/**
 * @module       identity
 * @uuid         fabbc95c-5da4-44f0-ba14-acd13fb1e3a7
 * @version      5.0.0
 *
 * UUID v4 generation, content hashing, dedup keys, and ID invariant checks.
 * Zero external dependencies. No mutable state.
 *
 * Three orthogonal axes (I-2):
 *   eventId      — random UUID v4, globally unique
 *   contentHash  — FNV-1a digest of type+payload+source (deterministic)
 *   dedupKey     — contentHash + replayOf (replay suppression only)
 *
 * @hook ef3cfe89-14ac-4ba3-8be5-063e61706281  newEventId
 * @hook edd9d9de-942b-473e-be4d-efc1cb84d136  isValidEventId
 * @hook af248063-94bf-4d41-9de7-a5fce817464e  shortId
 * @hook 954aad52-dd1d-4c2b-ae24-b27b5449dcba  canonicalize
 * @hook 0d5dbf41-cc98-4887-a739-17c1a0d25310  hash64
 * @hook 5e713385-e414-4ab8-80a0-8553df445bc4  contentHash
 * @hook 501e6181-c77c-496a-ae2a-c419659f43c1  dedupKey
 * @hook e526d3ad-f3b8-42c1-8a0b-d603f6501674  assertUniqueIds
 */

// ── UUID v4 ───────────────────────────────────────────────────────────────────

/**
 * Generate a new UUID v4.
 * Uses crypto.randomUUID() in browser/Node 14.17+.
 * Falls back to crypto.getRandomValues for older environments.
 *
 * Design law I-1: never deterministic, never reused, never sequential.
 *
 * @hook ef3cfe89-14ac-4ba3-8be5-063e61706281  identity:newEventId
 */
export function newEventId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback: manual v4 construction
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant bits
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0'));
  return [
    hex.slice(0, 4).join(''),
    hex.slice(4, 6).join(''),
    hex.slice(6, 8).join(''),
    hex.slice(8, 10).join(''),
    hex.slice(10, 16).join(''),
  ].join('-');
}

/**
 * Validate UUID v4 format.
 * @hook edd9d9de-942b-473e-be4d-efc1cb84d136  identity:isValidEventId
 */
export function isValidEventId(id) {
  return typeof id === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

/**
 * Display-safe short ID — last 12 hex chars (post-final-hyphen segment).
 * UUID format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
 *                                             ^^^^^^^^^^^^ — last 12, always unique
 * @hook af248063-94bf-4d41-9de7-a5fce817464e  identity:shortId
 */
export function shortId(id) {
  if (!id) return '?';
  const parts = id.split('-');
  return parts[parts.length - 1] || id.slice(-12);
}

// ── Content Hash ──────────────────────────────────────────────────────────────

/**
 * Stable, deterministic serialization of a value.
 * Object keys sorted recursively. Array order preserved.
 * Null-safe. Used ONLY for content fingerprinting and dedup — never for identity.
 *
 * @hook 954aad52-dd1d-4c2b-ae24-b27b5449dcba  identity:canonicalize
 */
export function canonicalize(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalize).join(',') + ']';
  if (typeof v === 'object') {
    const keys = Object.keys(v).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalize(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

/**
 * FNV-1a 64-bit hash (two 32-bit lanes).
 * Deterministic, fast. NOT used for EventID generation.
 * @hook 0d5dbf41-cc98-4887-a739-17c1a0d25310  identity:hash64
 */
export function hash64(s) {
  let h1 = 0x811c9dc5 | 0, h2 = 0xc4a6c57b | 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x01000193) ^ (h1 >>> 13);
  }
  return ((h1 >>> 0).toString(16).padStart(8, '0'))
       + ((h2 >>> 0).toString(16).padStart(8, '0'));
}

/**
 * Compute structural content hash for an event core.
 * Depends on: type + payload + source.
 * Does NOT depend on: id, ts, seq, causedBy (I-2).
 *
 * Two events with identical type+payload+source → identical contentHash.
 * Used for dedup detection and debugging equality, never for identity.
 *
 * @hook 5e713385-e414-4ab8-80a0-8553df445bc4  identity:contentHash
 */
export function contentHash(type, payload, source) {
  return hash64(canonicalize({ type, payload: payload ?? {}, source: source ?? 'unknown' }));
}

/**
 * Build a dedup key for replay suppression.
 * Includes the original event ID being replayed so replays of different
 * originals with identical payloads never collide.
 * ONLY used by seenMap. Never exposed to graph logic.
 *
 * @hook 501e6181-c77c-496a-ae2a-c419659f43c1  identity:dedupKey
 */
export function dedupKey(type, payload, source, replayOf) {
  return contentHash(type, payload, source) + '::' + (replayOf || '');
}

// ── Invariant checks ──────────────────────────────────────────────────────────

/**
 * Assert that no two events in an array share an ID.
 * O(n) — use only in tests and validation gates.
 * @hook e526d3ad-f3b8-42c1-8a0b-d603f6501674  identity:assertUniqueIds
 */
export function assertUniqueIds(events) {
  const seen = new Set();
  for (const ev of events) {
    if (seen.has(ev.id)) throw new Error(`Identity violation: duplicate event ID ${ev.id}`);
    seen.add(ev.id);
  }
  return true;
}
