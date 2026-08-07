import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { CURRENT_CONFIG_VERSION } from './config.ts';
import { listEffectiveModelsForStage } from './effective-models.ts';
import { getGlobalModelRegistry } from './effective-models.ts';
import { CERTIFICATION_BASE_PATH } from './native-agent/certification/schema.ts';

export interface RemovedModelSettingInventoryItem {
  file: string;
  path: string;
  summary: string;
  modelIds: string[];
}

export interface DuplicateJsonKeyWarning {
  file: string;
  path: string;
  key: string;
}

export interface ModelSettingsMigrationReport {
  repoDir: string;
  dryRun: boolean;
  changed: boolean;
  backups: string[];
  inventory: RemovedModelSettingInventoryItem[];
  duplicateKeys: DuplicateJsonKeyWarning[];
  localCertificationDir?: string;
  effectivePools: Record<'planner' | 'coder' | 'reviewer', number>;
  migratedFiles: string[];
}

export interface ModelSettingsMigrationOptions {
  repoDir?: string;
  dryRun?: boolean;
  ackMissingCerts?: string[];
}

export const REMOVED_MODEL_SETTING_PATHS = [
  'modelRegistry',
  'router.defaultModel',
  'router.models',
  'router.availableModels',
  'router.agentMap',
  'challenge.models',
  'challenge.comparisonModel',
  'providers.openrouter.models',
  'providers.openrouter.stages',
  'providers.deepseek.models',
  'providers.deepseek.stages',
  'nativeAgent.providers.openai.models',
  'nativeAgent.providers.openrouter.models',
] as const;

const REMOVED_PATHS = REMOVED_MODEL_SETTING_PATHS;

const STAGES = ['planner', 'coder', 'reviewer'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getPath(root: unknown, path: string): unknown {
  let cursor = root;
  for (const segment of path.split('.')) {
    if (!isRecord(cursor) || !(segment in cursor)) {
      return undefined;
    }
    cursor = cursor[segment];
  }
  return cursor;
}

function deletePath(root: unknown, path: string): boolean {
  const segments = path.split('.');
  const stack: Array<{ object: Record<string, unknown>; key: string }> = [];
  let cursor = root;
  for (const segment of segments.slice(0, -1)) {
    if (!isRecord(cursor)) {
      return false;
    }
    stack.push({ object: cursor, key: segment });
    cursor = cursor[segment];
  }
  if (!isRecord(cursor)) {
    return false;
  }
  const leaf = segments[segments.length - 1];
  if (!leaf || !(leaf in cursor)) {
    return false;
  }
  delete cursor[leaf];

  for (let index = stack.length - 1; index >= 0; index -= 1) {
    const { object, key } = stack[index];
    const value = object[key];
    if (isRecord(value) && Object.keys(value).length === 0) {
      delete object[key];
    } else {
      break;
    }
  }
  return true;
}

function collectModelIds(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }
  if (Array.isArray(value)) {
    return [...new Set(value.flatMap(collectModelIds))];
  }
  if (isRecord(value)) {
    return [...new Set([
      ...Object.keys(value),
      ...Object.values(value).flatMap(collectModelIds),
    ].filter((entry) => /^[a-z0-9][a-z0-9./-]*$/i.test(entry)))];
  }
  return [];
}

function summarizePath(path: string, value: unknown): string {
  const modelIds = collectModelIds(value);
  const count = modelIds.length;
  if (path === 'modelRegistry') {
    const models = isRecord(value) && isRecord(value.models) ? Object.keys(value.models).length : 0;
    const ladders = isRecord(value) && isRecord(value.ladders) ? Object.keys(value.ladders).length : 0;
    return `Removed repo-local model registry overrides (${models} model override(s), ${ladders} ladder override(s)); the global effective-model projection is authoritative.`;
  }
  if (path.endsWith('.agentMap')) {
    return `Removed ${path} model-to-agent mapping (${count} model key(s)); agents now resolve from the global registry.`;
  }
  if (path.endsWith('.stages')) {
    return `Removed ${path} stage allowlist; provider readiness now comes from runtime state and global catalog metadata.`;
  }
  return `Removed ${path} (${count} model value(s)); model membership now comes from the global effective-model projection.`;
}

function inventoryRemovedSettings(file: string, config: unknown): RemovedModelSettingInventoryItem[] {
  return REMOVED_PATHS.flatMap((path) => {
    const value = getPath(config, path);
    if (value === undefined) {
      return [];
    }
    return [{
      file,
      path,
      summary: summarizePath(path, value),
      modelIds: collectModelIds(value),
    }];
  });
}

export function scanForbiddenModelSettings(repoDir: string): RemovedModelSettingInventoryItem[] {
  const files = ['.wavemill-config.json', '.wavemill-config.local.json']
    .map((name) => resolve(repoDir, name))
    .filter((path) => existsSync(path));

  return files.flatMap((path) => {
    const raw = readFileSync(path, 'utf-8');
    return inventoryRemovedSettings(basename(path), JSON.parse(raw));
  });
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function detectDuplicateKeys(raw: string, file: string): DuplicateJsonKeyWarning[] {
  const warnings: DuplicateJsonKeyWarning[] = [];
  const stack: Array<{ path: string; keys: Set<string>; expectKey: boolean }> = [];
  let inString = false;
  let escape = false;
  let token = '';

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (char === '\\') {
        escape = true;
      } else if (char === '"') {
        inString = false;
        const frame = stack[stack.length - 1];
        const rest = raw.slice(index + 1).match(/^\s*:/);
        if (frame?.expectKey && rest) {
          if (frame.keys.has(token)) {
            warnings.push({ file, path: frame.path || 'root', key: token });
          }
          frame.keys.add(token);
          frame.expectKey = false;
        }
      } else {
        token += char;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      token = '';
    } else if (char === '{') {
      const parent = stack[stack.length - 1];
      stack.push({ path: parent?.path ?? '', keys: new Set(), expectKey: true });
    } else if (char === '}') {
      stack.pop();
      const parent = stack[stack.length - 1];
      if (parent) {
        parent.expectKey = false;
      }
    } else if (char === ',') {
      const frame = stack[stack.length - 1];
      if (frame) {
        frame.expectKey = true;
      }
    }
  }
  return warnings;
}

function validateAgainstSchema(repoDir: string, config: unknown): void {
  const repoSchemaPath = resolve(repoDir, 'wavemill-config.schema.json');
  const schemaPath = existsSync(repoSchemaPath)
    ? repoSchemaPath
    : resolve(import.meta.dirname, '..', '..', 'wavemill-config.schema.json');
  const schema = JSON.parse(readFileSync(schemaPath, 'utf-8'));
  const require = createRequire(import.meta.url);
  const AjvCtor = require('ajv');
  const ajv = new AjvCtor({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  if (!validate(config)) {
    const details = (validate.errors ?? [])
      .map((err: { instancePath?: string; message?: string }) => `  ${err.instancePath || 'root'}: ${err.message || 'invalid'}`)
      .join('\n');
    throw new Error(`Migrated config failed schema validation:\n${details}`);
  }
}

function validateGlobalProjectionUsable(repoDir: string): Record<'planner' | 'coder' | 'reviewer', number> {
  void repoDir;
  const pools = {
    planner: listEffectiveModelsForStage('planning').models.length,
    coder: listEffectiveModelsForStage('coding').models.length,
    reviewer: listEffectiveModelsForStage('review').models.length,
  };
  const empty = STAGES.filter((stage) => pools[stage] === 0);
  if (empty.length > 0) {
    throw new Error(`Global effective-model projection is unusable: empty pool(s) for ${empty.join(', ')}.`);
  }
  return pools;
}

function assertLocalCertsPublished(configs: unknown[], ackMissingCerts: Set<string>): void {
  const registry = getGlobalModelRegistry();
  const missing: string[] = [];
  for (const config of configs) {
    const models = getPath(config, 'modelRegistry.models');
    if (!isRecord(models)) {
      continue;
    }
    for (const [modelId, modelConfig] of Object.entries(models)) {
      if (getPath(modelConfig, 'nativeCapability.certification') === undefined) {
        continue;
      }
      if (!registry.models[modelId]?.nativeCapability?.certification && !ackMissingCerts.has(modelId)) {
        missing.push(modelId);
      }
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `Local certification metadata is absent from the global catalog for ${[...new Set(missing)].join(', ')}. ` +
      `Publish the global v2 certification entry first, or rerun with --ack-missing-cert=${[...new Set(missing)].join(',')}.`,
    );
  }
}

function writeAtomically(path: string, contents: string): void {
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tempPath, contents, 'utf-8');
  renameSync(tempPath, path);
}

export function migrateModelSettings(options: ModelSettingsMigrationOptions = {}): ModelSettingsMigrationReport {
  const repoDir = resolve(options.repoDir || process.cwd());
  const dryRun = options.dryRun === true;
  const files = ['.wavemill-config.json', '.wavemill-config.local.json']
    .map((name) => resolve(repoDir, name))
    .filter((path) => existsSync(path));
  const localCertificationDir = resolve(repoDir, CERTIFICATION_BASE_PATH);

  const parsed = files.map((path) => {
    const raw = readFileSync(path, 'utf-8');
    return {
      path,
      raw,
      config: JSON.parse(raw),
      duplicates: detectDuplicateKeys(raw, basename(path)),
    };
  });

  assertLocalCertsPublished(parsed.map((entry) => entry.config), new Set(options.ackMissingCerts ?? []));

  const inventory = parsed.flatMap((entry) => inventoryRemovedSettings(basename(entry.path), entry.config));
  const cleaned = parsed.map((entry) => {
    const config = cloneJson(entry.config);
    for (const path of REMOVED_PATHS) {
      deletePath(config, path);
    }
    if (isRecord(config)) {
      config.configVersion = CURRENT_CONFIG_VERSION;
    }
    return { ...entry, config };
  });

  for (const entry of cleaned) {
    validateAgainstSchema(repoDir, entry.config);
  }
  const effectivePools = validateGlobalProjectionUsable(repoDir);

  const changed = inventory.length > 0 || cleaned.some((entry) => JSON.stringify(entry.config, null, 2) + '\n' !== entry.raw);
  const backups: string[] = [];
  const migratedFiles: string[] = [];

  if (!dryRun && changed) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '').replace('T', '-').replace('Z', 'Z');
    for (const entry of cleaned) {
      const backupPath = join(dirname(entry.path), `${basename(entry.path)}.migration-backup-${timestamp}`);
      copyFileSync(entry.path, backupPath);
      backups.push(backupPath);
      writeAtomically(entry.path, JSON.stringify(entry.config, null, 2) + '\n');
      migratedFiles.push(entry.path);
    }
  }

  return {
    repoDir,
    dryRun,
    changed,
    backups,
    inventory,
    duplicateKeys: parsed.flatMap((entry) => entry.duplicates),
    localCertificationDir: existsSync(localCertificationDir) ? localCertificationDir : undefined,
    effectivePools,
    migratedFiles,
  };
}
