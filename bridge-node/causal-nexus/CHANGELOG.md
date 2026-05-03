# Causal Nexus — Changelog

## v5.0.1 (patch)

### Bug Fix — sigma oscillation detection (BF-1)

**Module:** `src/sigma/index.js` — `computeFeatureTree()`

**Symptom:** Sessions with true positive↔negative latency oscillations were
classified as `degraded` (S dominant) instead of `oscillatory` (O dominant).
The oscillation counter `O` remained 0 for any window with genuine sign flips.

**Root cause:** The oscillation sign-flip check used `Math.abs(latencyImpact)`
to derive the sign (`s > 0 ? 1 : 0`). This collapsed negative values to the
same bucket as zero, making negative↔positive flips invisible. Only
zero→nonzero transitions were counted, which do not represent true oscillation.

**Fix:** Changed sign derivation to use raw `latencyImpact` value:
`rawL > 0 ? 1 : rawL < 0 ? -1 : 0`. Zero values are now treated as neutral
(sign = 0) and do not participate in flip counting. Only true positive↔negative
transitions increment `O`.

**Tests corrected:** SG-10 and SG-18 used zero↔positive patterns that masked
the bug. Both updated to use true alternating signs. SG-44 (session shapes)
caught the defect.

**Invariant impact:** None. The fix is purely internal to `computeFeatureTree()`.
`classify()` contract unchanged. All 533 tests passing.

---

## v5.0.0

### Phase 7 — Persist + Query context integration (complete)
### Phase 8 — Loader hot-patching + context integration (complete)
  - `hotReloadContext()` added to loader module
  - Guard against ReplayContext (cites CI-1..CI-6)
  - 6 new tests (LC-1..LC-6)

### Phase R5 — Sigma Engine (complete)
  - `classify()` validated against 12 known session shapes (SG-41..SG-52)
  - Five regimes: stable, degraded, collapsing, oscillatory, insufficient_data
  - `constraintConfig` versioned and hot-swappable
  - 52 tests passing

### Version bump
  - All 20 modules → 5.0.0
  - package.json → 5.0.0
  - src/index.js header updated
