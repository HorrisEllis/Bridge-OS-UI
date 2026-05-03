// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
/**
 * @module       version-gate
 * @uuid         a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d
 * @version      5.0.0
 *
 * Single authoritative validation pass for all .nex artifacts.
 *
 * Version Gate Axiom: all .nex artifacts must be validated by this gate
 * prior to parsing, migration, or runtime hydration. No component may
 * bypass this gate.
 *
 * Configuration Migration Axiom: migration occurs immediately after
 * version validation and before any runtime hydration. Partial hydration
 * followed by migration is structurally prohibited.
 *
 * Two passes — validate then migrate — must be called in sequence:
 *   const validated = versionGate.validate(raw);   // throws on mismatch
 *   const migrated  = versionGate.migrate(validated); // no-op if current
 *   const replay    = kernel.createReplayContext(migrated);
 *
 * Supported artifact types: SNAP (snapshot), BP (blueprint), CLIP (clip).
 * Magic strings: URCK-SNAP | URCK-BP | URCK-CLIP
 *
 * Version compatibility:
 *   - fmt   (format schema): must match exactly — different schema = hard stop.
 *   - kernelVersion: major must match. 4.x.x reads all 4.x.x files.
 *     A major version mismatch is a hard stop, not a silent corrupt restore.
 *
 * NOTE: The spec defines magic strings as NEX-SNAP / NEX-BP / NEX-CLIP.
 * The current codebase produces URCK-SNAP / URCK-BP. The rename is a fmt
 * version bump — tracked as migration M-001. This gate validates both forms
 * so existing snapshots are not orphaned.
 *
 * @hook a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d  createVersionGate
 * @hook b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e  validate
 * @hook c3d4e5f6-a7b8-4c9d-0e1f-2a3b4c5d6e7f  migrate
 * @hook d4e5f6a7-b8c9-4d0e-1f2a-3b4c5d6e7f8a  GateValidationError
 * @hook e5f6a7b8-c9d0-4e1f-2a3b-4c5d6e7f8a9b  SUPPORTED_MAGICS
 * @hook f6a7b8c9-d0e1-4f2a-3b4c-5d6e7f8a9b0c  CURRENT_FORMAT_VERSION
 * @hook a7b8c9d0-e1f2-4a3b-4c5d-6e7f8a9b0c1d  CURRENT_KERNEL_VERSION
 */

'use strict';

// ── Constants ─────────────────────────────────────────────────────────────────

/** @hook f6a7b8c9-d0e1-4f2a-3b4c-5d6e7f8a9b0c  version-gate:CURRENT_FORMAT_VERSION */
export const CURRENT_FORMAT_VERSION = 1;

/** @hook a7b8c9d0-e1f2-4a3b-4c5d-6e7f8a9b0c1d  version-gate:CURRENT_KERNEL_VERSION */
export const CURRENT_KERNEL_VERSION = '4.5.2';

// Accepted magic strings — both legacy (URCK-*) and spec-canonical (NEX-*)
// Migration M-001 upgrades URCK-* → NEX-* within this gate.
const MAGIC_SNAP_LEGACY  = 'URCK-SNAP';
const MAGIC_BP_LEGACY    = 'URCK-BP';
const MAGIC_SNAP         = 'NEX-SNAP';
const MAGIC_BP           = 'NEX-BP';
const MAGIC_CLIP         = 'NEX-CLIP';

/** @hook e5f6a7b8-c9d0-4e1f-2a3b-4c5d6e7f8a9b  version-gate:SUPPORTED_MAGICS */
export const SUPPORTED_MAGICS = new Set([
  MAGIC_SNAP_LEGACY, MAGIC_BP_LEGACY,
  MAGIC_SNAP, MAGIC_BP, MAGIC_CLIP,
]);

const ARTIFACT_TYPE = {
  [MAGIC_SNAP_LEGACY]: 'snapshot',
  [MAGIC_SNAP]:        'snapshot',
  [MAGIC_BP_LEGACY]:   'blueprint',
  [MAGIC_BP]:          'blueprint',
  [MAGIC_CLIP]:        'clip',
};

// ── Error type ────────────────────────────────────────────────────────────────

/**
 * Thrown by validate() on any version or format mismatch.
 * Hard stop — never caught silently.
 * @hook d4e5f6a7-b8c9-4d0e-1f2a-3b4c5d6e7f8a  version-gate:GateValidationError
 */
export class GateValidationError extends Error {
  constructor(message, context = {}) {
    super(`[version-gate] ${message}`);
    this.name    = 'GateValidationError';
    this.context = context;
  }
}

// ── Version parsing ───────────────────────────────────────────────────────────

function parseSemver(v) {
  if (typeof v !== 'string') return null;
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  return { major: parseInt(m[1], 10), minor: parseInt(m[2], 10), patch: parseInt(m[3], 10) };
}

function majorOf(v) {
  const p = parseSemver(v);
  return p ? p.major : null;
}

// ── Migrations ────────────────────────────────────────────────────────────────

/**
 * M-001: URCK-SNAP → NEX-SNAP / URCK-BP → NEX-BP
 * Renames legacy magic strings to spec-canonical form.
 * All other fields are unchanged — forward-compatible.
 */
function migrateM001(artifact) {
  if (artifact.magic === MAGIC_SNAP_LEGACY) {
    return { ...artifact, magic: MAGIC_SNAP, kernelVersion: artifact.kernelVersion || CURRENT_KERNEL_VERSION };
  }
  if (artifact.magic === MAGIC_BP_LEGACY) {
    return { ...artifact, magic: MAGIC_BP, kernelVersion: artifact.kernelVersion || CURRENT_KERNEL_VERSION };
  }
  return artifact;
}

// Ordered migration chain — each entry: { id, predicate, apply }
const MIGRATIONS = [
  {
    id:        'M-001',
    desc:      'Rename URCK-* magic strings to NEX-* canonical form',
    predicate: (a) => a.magic === MAGIC_SNAP_LEGACY || a.magic === MAGIC_BP_LEGACY,
    apply:     migrateM001,
  },
];

// ── validate ──────────────────────────────────────────────────────────────────

/**
 * Validate a raw .nex artifact before any parsing or hydration.
 *
 * Checks:
 *   1. Artifact is a non-null object
 *   2. magic is a recognized string
 *   3. fmt is a number and matches CURRENT_FORMAT_VERSION
 *   4. kernelVersion (if present) has matching major version
 *
 * Returns the artifact unchanged on success.
 * Throws GateValidationError on any failure — hard stop.
 *
 * @hook b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e  version-gate:validate
 * @param {object} artifact — raw parsed .nex object
 * @returns {object} artifact — unchanged, validated
 * @throws {GateValidationError}
 */
export function validate(artifact) {
  // 1. Null / type guard
  if (artifact === null || artifact === undefined || typeof artifact !== 'object') {
    throw new GateValidationError('artifact must be a non-null object', { received: typeof artifact });
  }

  // 2. Magic
  const { magic } = artifact;
  if (!SUPPORTED_MAGICS.has(magic)) {
    throw new GateValidationError(
      `unrecognized magic '${magic}' — expected one of: ${[...SUPPORTED_MAGICS].join(', ')}`,
      { magic }
    );
  }

  // 3. Format version
  const { fmt } = artifact;
  if (typeof fmt !== 'number') {
    throw new GateValidationError(`fmt must be a number, got ${typeof fmt}`, { fmt });
  }
  if (fmt !== CURRENT_FORMAT_VERSION) {
    throw new GateValidationError(
      `format version mismatch: artifact fmt=${fmt}, gate expects fmt=${CURRENT_FORMAT_VERSION}`,
      { artifactFmt: fmt, expectedFmt: CURRENT_FORMAT_VERSION }
    );
  }

  // 4. Kernel version — major must match if present
  const { kernelVersion } = artifact;
  if (kernelVersion !== undefined && kernelVersion !== null) {
    const artifactMajor = majorOf(kernelVersion);
    const currentMajor  = majorOf(CURRENT_KERNEL_VERSION);

    if (artifactMajor === null) {
      throw new GateValidationError(
        `kernelVersion '${kernelVersion}' is not valid semver`,
        { kernelVersion }
      );
    }
    if (artifactMajor !== currentMajor) {
      throw new GateValidationError(
        `major version mismatch: artifact kernelVersion=${kernelVersion}, ` +
        `kernel is ${CURRENT_KERNEL_VERSION} — cross-major restore is prohibited`,
        { artifactKernelVersion: kernelVersion, currentKernelVersion: CURRENT_KERNEL_VERSION }
      );
    }
  }

  return artifact;
}

// ── migrate ───────────────────────────────────────────────────────────────────

/**
 * Apply all applicable forward migrations to a validated artifact.
 * Migrations are deterministic and idempotent.
 * Returns a new object — never mutates the input.
 *
 * Must be called after validate() and before any runtime hydration.
 *
 * @hook c3d4e5f6-a7b8-4c9d-0e1f-2a3b4c5d6e7f  version-gate:migrate
 * @param {object} artifact — validated artifact from validate()
 * @returns {object} migrated artifact — may be same reference if no migrations applied
 */
export function migrate(artifact) {
  let current = artifact;
  for (const migration of MIGRATIONS) {
    if (migration.predicate(current)) {
      current = migration.apply(current);
    }
  }
  return current;
}

// ── createVersionGate ─────────────────────────────────────────────────────────

/**
 * Factory returning a version gate instance bound to a specific kernel version.
 * The default instance uses CURRENT_KERNEL_VERSION.
 * Pass kernelVersion to create a gate for testing or cross-version tooling.
 *
 * Usage:
 *   const gate     = createVersionGate();
 *   const valid    = gate.validate(rawNexFile);   // throws on mismatch
 *   const migrated = gate.migrate(valid);         // deterministic forward migration
 *   // now safe to pass to createReplayContext(migrated)
 *
 * @hook a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d  version-gate:createVersionGate
 * @param {object} [opts]
 *   opts.kernelVersion {string}  override kernel version (default: CURRENT_KERNEL_VERSION)
 * @returns {{ validate, migrate, artifactType, migrations }}
 */
export function createVersionGate(opts = {}) {
  const kernelVersion = opts.kernelVersion || CURRENT_KERNEL_VERSION;
  const kernelMajor   = majorOf(kernelVersion);

  if (kernelMajor === null) {
    throw new Error(`createVersionGate: invalid kernelVersion '${kernelVersion}'`);
  }

  function _validate(artifact) {
    if (artifact === null || artifact === undefined || typeof artifact !== 'object') {
      throw new GateValidationError('artifact must be a non-null object', { received: typeof artifact });
    }

    const { magic } = artifact;
    if (!SUPPORTED_MAGICS.has(magic)) {
      throw new GateValidationError(
        `unrecognized magic '${magic}'`,
        { magic, supported: [...SUPPORTED_MAGICS] }
      );
    }

    const { fmt } = artifact;
    if (typeof fmt !== 'number') {
      throw new GateValidationError(`fmt must be a number, got ${typeof fmt}`, { fmt });
    }
    if (fmt !== CURRENT_FORMAT_VERSION) {
      throw new GateValidationError(
        `format version mismatch: artifact fmt=${fmt}, gate expects fmt=${CURRENT_FORMAT_VERSION}`,
        { artifactFmt: fmt, expectedFmt: CURRENT_FORMAT_VERSION }
      );
    }

    const { kernelVersion: av } = artifact;
    if (av !== undefined && av !== null) {
      const am = majorOf(av);
      if (am === null) {
        throw new GateValidationError(`kernelVersion '${av}' is not valid semver`, { kernelVersion: av });
      }
      if (am !== kernelMajor) {
        throw new GateValidationError(
          `major version mismatch: artifact=${av}, kernel=${kernelVersion}`,
          { artifactKernelVersion: av, gateKernelVersion: kernelVersion }
        );
      }
    }

    return artifact;
  }

  function _migrate(artifact) {
    let current = artifact;
    for (const migration of MIGRATIONS) {
      if (migration.predicate(current)) {
        current = migration.apply(current);
      }
    }
    return current;
  }

  /**
   * Returns the artifact type string for a validated artifact.
   * 'snapshot' | 'blueprint' | 'clip'
   */
  function artifactType(artifact) {
    return ARTIFACT_TYPE[artifact.magic] || 'unknown';
  }

  return {
    validate:      _validate,
    migrate:       _migrate,
    artifactType,
    kernelVersion,
    migrations:    MIGRATIONS.map(m => ({ id: m.id, desc: m.desc })),
    formatVersion: CURRENT_FORMAT_VERSION,
  };
}
