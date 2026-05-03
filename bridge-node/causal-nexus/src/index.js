// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
/**
 * causal-nexus v5.0.0
 *
 * Barrel export — re-exports every public symbol from all 14 modules.
 * Import the whole package: import * as Nexus from 'causal-nexus'
 * Or import specific modules: import { createKernel } from 'causal-nexus/kernel'
 *
 * Execution order (dependency DAG — lower layers have no imports):
 *   0  identity      fabbc95c  UUID v4, hash, dedup
 *   1  time          ce9aac88  kernel-local clocks
 *   2  causality     32a3f387  edges, graph, calltoMap
 *   3  projection    74eddeca  read-only views
 *   4  lazy          6786d999  demand-paged scroll, calendar index
 *   5  kernel        5d90c63d  ring buffer, gate system
 *   6  adapter       dc2cfbff  bridge translation
 *   7  delta         7a4219d0  kinematic delta engine, zoom
 *   8  compress      f50d7ace  snapshot/restore/blueprint/compile
 *   9  forge         0091ce2c  AI self-modification
 *  10  loader        8bfdf8c2  hot module loading
 *  11  persist       fde4fdbd  WAL + archive + recovery
 *  12  query         e3bca332  CQL query engine
 *  13  version-gate    a1b2c3d4  .nex artifact validation + migration
 *  14  adapter-sandbox b1c2d3e4  side-effect policy registry + null adapters
 *  15  context         c1d2e3f4  LiveContext + ReplayContext (CI-1..CI-6)
 *
 * Project UUID: eecaa718-c6a6-4433-b02a-11ecbefd4740
 */

export * from './identity/index.js';
export * from './time/index.js';
export * from './causality/index.js';
export * from './projection/index.js';
export * from './lazy/index.js';
export * from './kernel/index.js';
export * from './adapter/index.js';
export * from './delta/index.js';
export * from './compress/index.js';
export * from './forge/index.js';
export * from './loader/index.js';
export * from './persist/index.js';
export * from './query/index.js';
export * from './version-gate/index.js';
export * from './adapter-sandbox/index.js';
export * from './context/index.js';
export * from './context/index.js';
export * from './clip/index.js';
export * from './sigma/index.js';
export * from './observer/index.js';
export * from './enforcement/index.js';
