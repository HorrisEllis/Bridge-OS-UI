#!/usr/bin/env node
// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — manifest generator (run before packaging)
// Usage: node scripts/gen-manifest.js
// Writes manifest.lock to project root.

'use strict';
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');

// Files to include in integrity manifest
const PROTECTED = [
  'bridge-ui.html',
  'main.js',
  'preload.js',
];

function sha256(filePath) {
  return crypto.createHash('sha256')
    .update(fs.readFileSync(filePath))
    .digest('hex');
}

const manifest = {
  version: JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version,
  built:   new Date().toISOString(),
  files:   {},
};

for (const rel of PROTECTED) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) {
    console.warn(`[manifest] WARNING: ${rel} not found — skipping`);
    continue;
  }
  manifest.files[rel] = sha256(abs);
  console.log(`[manifest] hashed: ${rel} → ${manifest.files[rel].slice(0, 16)}…`);
}

const outPath = path.join(ROOT, 'manifest.lock');
fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2));
console.log(`[manifest] written: ${outPath}`);
console.log(`[manifest] protected ${Object.keys(manifest.files).length} files`);
