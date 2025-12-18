import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';

const STATE_ROOT = resolve('.codex', 'state');

const ensureStateDir = () => {
  if (!existsSync(STATE_ROOT)) {
    mkdirSync(STATE_ROOT, { recursive: true });
  }
};

export const readState = (featureName) => {
  ensureStateDir();
  const path = join(STATE_ROOT, `${featureName}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf-8'));
};

export const writeState = (featureName, state) => {
  ensureStateDir();
  const path = join(STATE_ROOT, `${featureName}.json`);
  writeFileSync(path, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2));
};
