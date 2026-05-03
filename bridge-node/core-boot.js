// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
const boot = require('./bridge-node/boot.js');

// Filter the phases to only include core infrastructure
// Skipping Phase 7 (Guardian) and Phase 7b (CDP)
const corePhases = [1, 2, 3, 4, 5, 6, 8, '9a', '9b', '9c']; 

console.log("\x1b[35m[SYSTEM]\x1b[0m Starting Sovereign Core Bypass...");
boot.start(corePhases);