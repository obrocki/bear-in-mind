// Loads the committed research artefacts the canvas renders.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXTENSION_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = path.resolve(EXTENSION_DIR, '..', '..', '..');
export const MODEL_PATH = path.join(REPO_ROOT, 'docs', 'research', 'attribution-model.json');
export const RESEARCH_PATH = path.join(REPO_ROOT, 'docs', 'research', 'ai-telemetry-attribution.md');

export const MODEL_SECTIONS = [
  'surfaces',
  'concepts',
  'entities',
  'relationships',
  'tiers',
  'invariants',
  'outcomes',
  'gaps',
  'priorArt',
  'verification',
  'sources',
];

// Read on every request so edits to the committed files show without a reload.
export async function loadModel(file = MODEL_PATH) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

export async function loadResearch(file = RESEARCH_PATH) {
  return fs.readFile(file, 'utf8');
}
