#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

// Determine feature directory
let featureDir = process.env.FEATURE_DIR;
if (!featureDir && fs.existsSync('.specify/feature.json')) {
  try {
    const raw = JSON.parse(fs.readFileSync('.specify/feature.json', 'utf8'));
    if (raw.feature_directory) featureDir = raw.feature_directory;
  } catch {}
}
if (!featureDir) {
  const home = process.env.HOME || '/Users/hashanw';
  featureDir = path.join(
    home,
    'Documents/Obsidian/Seepient/Implementation-Specs/022-multi-tenant-isolation/022-1-readiness-remediation'
  );
}

const researchPath = path.join(featureDir, 'research.md');
const specPath = path.join(featureDir, 'spec.md');

if (!fs.existsSync(researchPath) || !fs.existsSync(specPath)) {
  console.error(`Missing research.md or spec.md at ${featureDir}`);
  process.exit(1);
}

const researchContent = fs.readFileSync(researchPath, 'utf8');
const specContent = fs.readFileSync(specPath, 'utf8');

// Parse R-rows in research.md
const rRows = new Map();
const tableRowRegex = /^\|\s*(R\d+)\s*\|\s*([^|]+)\|\s*([^|]+)\|/gm;
let match;
while ((match = tableRowRegex.exec(researchContent)) !== null) {
  const rId = match[1].trim();
  const finding = match[2].trim();
  const disposition = match[3].trim();
  rRows.set(rId, { finding, disposition });
}

let orphanCount = 0;
let doubleOwnedCount = 0;
const errors = [];

// 1. Every research.md R-row has a disposition
for (const [rId, { disposition }] of rRows.entries()) {
  if (!disposition || disposition.length === 0) {
    errors.push(`Row ${rId} has no disposition`);
    orphanCount++;
  }
}

// Track FR -> R# mappings
const frToRMap = new Map();
for (const [rId, { disposition }] of rRows.entries()) {
  const frMatches = disposition.match(/FR-\d+/g) || [];
  for (const fr of frMatches) {
    if (!frToRMap.has(fr)) frToRMap.set(fr, new Set());
    frToRMap.get(fr).add(rId);
  }
}

// 2. Parse spec FRs (>= FR-006)
const specFrRegex = /-\s+\*\*FR-(\d+)[^*]*\*\*:/g;
const specFrs = new Set();
while ((match = specFrRegex.exec(specContent)) !== null) {
  const num = parseInt(match[1], 10);
  if (num >= 6) {
    specFrs.add(`FR-${String(num).padStart(3, '0')}`);
  }
}

for (const fr of specFrs) {
  const mappedRs = frToRMap.get(fr);
  if (!mappedRs || mappedRs.size === 0) {
    // Check if the spec names itself systemic or has an explanation
    const frSectionRegex = new RegExp(`\\*\\*${fr}[^*]*\\*\\*:[\\s\\S]*?(?=\\n-\\s+\\*\\*FR-|\\n##|$)`);
    const sectionMatch = frSectionRegex.exec(specContent);
    const isSystemic = sectionMatch && /systemic/i.test(sectionMatch[0]);
    if (!isSystemic) {
      errors.push(`Spec ${fr} does not map to any R# in research.md and is not marked systemic`);
      orphanCount++;
    }
  }
}

// 3. Check for double-ownership with 024/024-1/024-2/025
for (const [rId, { disposition }] of rRows.entries()) {
  const has022_1 = /→\s*FR-\d+/.test(disposition);
  const staysWithOther = /stays with (024-1|024-2|024|025)/.test(disposition);
  const isAbsorbed = /absorbed from 024-2/i.test(disposition);
  const isExplicitSplit =
    disposition.includes('flag stop + copy only; rest stays with 024-1') ||
    disposition.includes('stays with 025, except staleness → FR-037');

  if (has022_1 && staysWithOther && !isAbsorbed && !isExplicitSplit) {
    errors.push(`Row ${rId} appears double-owned between 022-1 and another spec without explicit split or absorption: "${disposition}"`);
    doubleOwnedCount++;
  }

  // Also check if multiple "stays with" specs claim it
  const otherSpecs = (disposition.match(/024-1|024-2|024|025/g) || []);
  const uniqueOtherSpecs = [...new Set(otherSpecs)];
  if (uniqueOtherSpecs.length > 1 && !isAbsorbed && !isExplicitSplit) {
    errors.push(`Row ${rId} claimed by multiple external specs: ${uniqueOtherSpecs.join(', ')}`);
    doubleOwnedCount++;
  }
}

if (errors.length > 0) {
  console.error(`Disposition check failed with ${errors.length} issue(s):`);
  for (const err of errors) {
    console.error(`  - ${err}`);
  }
}

console.log(`${orphanCount} orphans, ${doubleOwnedCount} double-owned`);

if (orphanCount > 0 || doubleOwnedCount > 0) {
  process.exit(1);
}
