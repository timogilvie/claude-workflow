import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { WorkflowType, SessionStatus } from './session.ts';
import {
  canonicalJsonStringify,
  type ResourceRef,
  type ResourceType,
  toResourceRef,
} from './resource-registry.ts';
import { resolveFromMainRepo } from './git-utils.ts';
import { registerMemoryAssets } from './resource-adapters/memory-adapter.ts';
import { registerToolEnvSnapshot } from './resource-adapters/tool-env-adapter.ts';

export type ManifestPhase = 'planning' | 'coding' | 'review' | 'ready' | 'eval' | 'unknown';

export interface ManifestRef {
  sessionId: string;
  manifestDigest: string;
  path?: string;
}

export interface ResourceManifest {
  manifestSchemaVersion: string;
  sessionId: string;
  workflowType: WorkflowType | string;
  createdAt: string;
  updatedAt?: string;
  completedAt?: string;
  status?: SessionStatus | string;
  phases: Record<string, ResourceRef[]>;
  resources: ResourceRef[];
  harnessId?: string;
  digest: string;
}

interface ValidationError {
  instancePath?: string;
  message?: string;
}

type ValidatorFunction = ((data: unknown) => boolean) & {
  errors?: ValidationError[] | null;
};

const MANIFEST_SCHEMA_VERSION = '1.1.0';
const MANIFEST_DIR = '.wavemill/manifests';
/**
 * Environment and CLI tool versions are intentionally excluded from harnessId:
 * they churn with local runtime state and are not Wavemill behavior resources.
 */
export const HARNESS_EXCLUDED_RESOURCE_TYPES: ResourceType[] = ['environment', 'tool'];
const HARNESS_EXCLUDED_RESOURCE_TYPE_SET = new Set<string>(HARNESS_EXCLUDED_RESOURCE_TYPES);
export const EMPTY_HARNESS_ID = createHash('sha256').update('', 'utf-8').digest('hex');
const require = createRequire(import.meta.url);
let validator: ValidatorFunction | null | undefined;
const __dirname = dirname(fileURLToPath(import.meta.url));

function getValidator(): ValidatorFunction | null {
  if (validator !== undefined) {
    return validator;
  }

  try {
    const AjvCtor = (require('ajv/dist/2020').default || require('ajv/dist/2020')) as {
      new (options: { allErrors: boolean; strict: boolean }): { compile(schema: unknown): ValidatorFunction };
    };
    const schema = JSON.parse(
      readFileSync(
        resolve(__dirname, '../schemas/resource-manifest.schema.json'),
        'utf-8',
      ),
    );
    validator = new AjvCtor({ allErrors: true, strict: false, validateFormats: false }).compile(schema);
    return validator;
  } catch (error) {
    console.warn(`[manifest] Manifest schema validation disabled: ${(error as Error).message}`);
    validator = null;
    return null;
  }
}

export function validateResourceManifest(manifest: ResourceManifest): void {
  const validate = getValidator();
  if (!validate) {
    return;
  }
  if (validate(manifest)) {
    return;
  }
  const details = (validate.errors || [])
    .map((error) => `${error.instancePath || 'root'} ${error.message || 'invalid'}`)
    .join('; ');
  throw new Error(`Invalid resource manifest: ${details}`);
}

export function resolveManifestDir(repoDir?: string): string {
  return resolveFromMainRepo(MANIFEST_DIR, repoDir);
}

export function resolveManifestPath(sessionId: string, repoDir?: string): string {
  return resolve(resolveManifestDir(repoDir), `${sessionId}.json`);
}

function dedupeRefs(refs: ResourceRef[]): ResourceRef[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.id}@${ref.version}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function resourceTypeFromRef(ref: ResourceRef): string {
  return ref.id.split(':', 1)[0] || '';
}

function refTuple(ref: ResourceRef): string {
  return ref.id.endsWith(`@${ref.version}`) ? ref.id : `${ref.id}@${ref.version}`;
}

export function computeHarnessId(refs: ResourceRef[]): string {
  const tuples = [...new Set(
    refs
      .filter((ref) => !HARNESS_EXCLUDED_RESOURCE_TYPE_SET.has(resourceTypeFromRef(ref)))
      .map(refTuple),
  )].sort();
  return createHash('sha256').update(tuples.join('\n'), 'utf-8').digest('hex');
}

function writeManifest(path: string, manifest: ResourceManifest): void {
  manifest.harnessId = computeHarnessId(manifest.resources);
  validateResourceManifest(manifest);
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = resolve(dirname(path), `.manifest-tmp-${randomUUID()}.tmp`);
  writeFileSync(tmpPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
  renameSync(tmpPath, path);
}

export function getManifest(sessionId: string, repoDir?: string): ResourceManifest | null {
  const path = resolveManifestPath(sessionId, repoDir);
  if (!existsSync(path)) {
    return null;
  }
  return JSON.parse(readFileSync(path, 'utf-8')) as ResourceManifest;
}

export function computeManifestDigest(manifest: ResourceManifest): string {
  const digestInput = {
    ...manifest,
    harnessId: undefined,
    digest: '',
  };
  return createHash('sha256').update(canonicalJsonStringify(digestInput), 'utf-8').digest('hex');
}

export function openManifest(
  sessionId: string,
  options: { workflowType: WorkflowType | string; repoDir?: string } ,
): ResourceManifest {
  const seededRefs: ResourceRef[] = [];

  try {
    const envSnapshot = registerToolEnvSnapshot(options.repoDir);
    if (envSnapshot.environment) {
      seededRefs.push(envSnapshot.environment);
    }
    seededRefs.push(...envSnapshot.tools);
  } catch (error) {
    console.warn(`[manifest] Failed to seed tool/environment resources: ${(error as Error).message}`);
  }

  try {
    seededRefs.push(...registerMemoryAssets(options.repoDir));
  } catch (error) {
    console.warn(`[manifest] Failed to seed memory resources: ${(error as Error).message}`);
  }

  const manifest: ResourceManifest = {
    manifestSchemaVersion: MANIFEST_SCHEMA_VERSION,
    sessionId,
    workflowType: options.workflowType,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    phases: {},
    resources: dedupeRefs(seededRefs),
    digest: '',
  };
  const path = resolveManifestPath(sessionId, options.repoDir);
  writeManifest(path, manifest);
  return manifest;
}

export function recordUse(
  sessionId: string,
  phase: string,
  resource: ResourceRef | null | undefined,
  repoDir?: string,
): ResourceManifest | null {
  const ref = toResourceRef(resource);
  if (!ref) {
    return null;
  }

  const existing = getManifest(sessionId, repoDir);
  if (!existing) {
    return null;
  }

  const normalizedPhase = phase || 'unknown';
  const merged: ResourceManifest = {
    ...existing,
    updatedAt: new Date().toISOString(),
    phases: {
      ...existing.phases,
      [normalizedPhase]: dedupeRefs([...(existing.phases[normalizedPhase] || []), ref]),
    },
    resources: dedupeRefs([...existing.resources, ref]),
  };
  const path = resolveManifestPath(sessionId, repoDir);
  writeManifest(path, merged);
  return merged;
}

export function closeManifest(
  sessionId: string,
  options: { status?: SessionStatus | string; repoDir?: string } = {},
): ResourceManifest | null {
  const existing = getManifest(sessionId, options.repoDir);
  if (!existing) {
    return null;
  }

  const closed: ResourceManifest = {
    ...existing,
    updatedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    ...(options.status ? { status: options.status } : {}),
    digest: '',
  };
  closed.digest = computeManifestDigest(closed);
  const path = resolveManifestPath(sessionId, options.repoDir);
  writeManifest(path, closed);
  return closed;
}

export function getManifestRef(sessionId: string, repoDir?: string): ManifestRef | null {
  const manifest = getManifest(sessionId, repoDir);
  if (!manifest?.digest) {
    return null;
  }
  return {
    sessionId,
    manifestDigest: manifest.digest,
    path: resolveManifestPath(sessionId, repoDir),
  };
}

export function getHarnessId(sessionId: string, repoDir?: string): string | null {
  const manifest = getManifest(sessionId, repoDir);
  if (!manifest) {
    return null;
  }
  return manifest.harnessId ?? computeHarnessId(manifest.resources);
}

export interface ManifestListEntry {
  sessionId: string;
  path: string;
  manifest: ResourceManifest;
  harnessId: string;
}

export function listManifests(repoDir?: string): ManifestListEntry[] {
  const dir = resolveManifestDir(repoDir);
  if (!existsSync(dir)) {
    return [];
  }

  const entries: ManifestListEntry[] = [];
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.json')) {
      continue;
    }
    const path = resolve(dir, file);
    try {
      const manifest = JSON.parse(readFileSync(path, 'utf-8')) as ResourceManifest;
      const sessionId = manifest.sessionId || file.slice(0, -'.json'.length);
      entries.push({
        sessionId,
        path,
        manifest,
        harnessId: manifest.harnessId ?? computeHarnessId(manifest.resources || []),
      });
    } catch (error) {
      console.warn(`[manifest] Skipped malformed manifest ${path}: ${(error as Error).message}`);
    }
  }
  return entries;
}

export function findManifestsByHarnessId(harnessId: string, repoDir?: string): ManifestListEntry[] {
  const selector = harnessId.trim();
  if (!/^[a-f0-9]{8,64}$/.test(selector)) {
    return [];
  }
  const manifests = listManifests(repoDir);
  if (selector.length === 64) {
    return manifests.filter((entry) => entry.harnessId === selector);
  }
  return manifests.filter((entry) => entry.harnessId.startsWith(selector));
}
