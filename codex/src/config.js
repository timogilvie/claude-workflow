import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const DEFAULT_CONFIG = resolve('codex', 'config.json');

export const loadConfig = (configPath = process.env.CODEX_CONFIG_PATH || DEFAULT_CONFIG) => {
  const path = resolve(configPath);
  if (!existsSync(path)) {
    throw new Error(`Config not found at ${path}. Create codex/config.json or set CODEX_CONFIG_PATH.`);
  }
  const raw = readFileSync(path, 'utf-8');
  return JSON.parse(raw);
};
