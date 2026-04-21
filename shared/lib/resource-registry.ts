import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { appendJsonlRecord } from './jsonl-utils.ts';
import { getRegistryConfig } from './config.ts';
import { resolveFromMainRepo } from './git-utils.ts';

export type ResourceType =
  | 'prompt'
  | 'optimizer-artifact'
  | 'tool'
  | 'memory'
  | 'agent-config'
  | 'environment';

export interface ResourceRef {
  id: string;
  version: string;
}

export interface LineageInfo {
  source?: string;
  optimizer?: string;
  generatedFrom?: ResourceRef[];
}

export interface ResourceVersion extends ResourceRef {
  schemaVersion?: string;
  type: ResourceType;
  name: string;
  contentHash: string;
  createdAt: string;
  uri?: string;
  lineage?: LineageInfo;
  dependencies?: ResourceRef[];
  metadata?: Record<string, unknown>;
}

export interface RegisterResourceInput {
  type: ResourceType;
  name: string;
  content: string;
  version?: string;
  uri?: string;
  lineage?: LineageInfo;
  dependencies?: ResourceRef[];
  metadata?: Record<string, unknown>;
  createdAt?: string;
}

export interface ListResourcesFilter {
  type?: ResourceType;
  name?: string;
}

interface ValidationError {
  instancePath?: string;
  message?: string;
}

type ValidatorFunction = ((data: unknown) => boolean) & {
  errors?: ValidationError[] | null;
};

const RESOURCE_SCHEMA_VERSION = '1.0.0';
const DEFAULT_REGISTRY_DIR = '.wavemill/registry';
const REGISTRY_FILENAME = 'resources.jsonl';
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
        resolve(__dirname, '../schemas/resource-version.schema.json'),
        'utf-8',
      ),
    );
    validator = new AjvCtor({ allErrors: true, strict: false, validateFormats: false }).compile(schema);
    return validator;
  } catch (error) {
    console.warn(`[registry] Resource schema validation disabled: ${(error as Error).message}`);
    validator = null;
    return null;
  }
}

export function canonicalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalizeValue(entry));
  }
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((accumulator, key) => {
        accumulator[key] = canonicalizeValue((value as Record<string, unknown>)[key]);
        return accumulator;
      }, {});
  }
  return value;
}

export function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(canonicalizeValue(value));
}

export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

export function shortHash(hash: string): string {
  return hash.slice(0, 12);
}

export function validateResourceVersion(resource: ResourceVersion): void {
  const validate = getValidator();
  if (!validate) {
    return;
  }
  if (validate(resource)) {
    return;
  }
  const details = (validate.errors || [])
    .map((error) => `${error.instancePath || 'root'} ${error.message || 'invalid'}`)
    .join('; ');
  throw new Error(`Invalid resource version: ${details}`);
}

export function buildResourceVersion(input: RegisterResourceInput): ResourceVersion {
  const contentHash = hashContent(input.content);
  const version = input.version || `sha256:${shortHash(contentHash)}`;
  const resource: ResourceVersion = {
    schemaVersion: RESOURCE_SCHEMA_VERSION,
    id: `${input.type}:${input.name}@${version}`,
    type: input.type,
    name: input.name,
    version,
    contentHash,
    createdAt: input.createdAt || new Date().toISOString(),
    ...(input.uri ? { uri: input.uri } : {}),
    ...(input.lineage ? { lineage: input.lineage } : {}),
    ...(input.dependencies?.length ? { dependencies: input.dependencies } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
  validateResourceVersion(resource);
  return resource;
}

export function resolveRegistryDir(repoDir?: string, explicitDir?: string): string {
  if (explicitDir) {
    return resolve(explicitDir);
  }
  const config = getRegistryConfig(repoDir);
  return resolveFromMainRepo(config.dir || DEFAULT_REGISTRY_DIR, repoDir);
}

export function resolveRegistryFile(repoDir?: string, explicitDir?: string): string {
  return resolve(resolveRegistryDir(repoDir, explicitDir), REGISTRY_FILENAME);
}

function readRegistryRecords(path: string): { records: ResourceVersion[]; malformedCount: number } {
  if (!existsSync(path)) {
    return { records: [], malformedCount: 0 };
  }

  const content = readFileSync(path, 'utf-8');
  const records: ResourceVersion[] = [];
  let malformedCount = 0;

  for (const line of content.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as ResourceVersion;
      records.push(parsed);
    } catch {
      malformedCount += 1;
    }
  }

  return { records, malformedCount };
}

export function listResources(filter: ListResourcesFilter = {}, repoDir?: string): ResourceVersion[] {
  const path = resolveRegistryFile(repoDir);
  const { records, malformedCount } = readRegistryRecords(path);
  if (malformedCount > 0) {
    console.warn(`[registry] Skipped ${malformedCount} malformed resource entries`);
  }
  return records.filter((record) => {
    if (filter.type && record.type !== filter.type) {
      return false;
    }
    if (filter.name && record.name !== filter.name) {
      return false;
    }
    return true;
  });
}

export function getResource(id: string, version?: string, repoDir?: string): ResourceVersion | null {
  const resources = listResources({}, repoDir);
  return resources.find((record) => record.id === id && (!version || record.version === version)) || null;
}

export function getResourceByHash(type: ResourceType, hash: string, repoDir?: string): ResourceVersion | null {
  return listResources({ type }, repoDir).find((record) => record.contentHash === hash) || null;
}

export function registerResource(
  input: RegisterResourceInput,
  options: { repoDir?: string; dir?: string } = {},
): ResourceVersion | null {
  const config = getRegistryConfig(options.repoDir);
  if (config.enabled === false) {
    return null;
  }

  const resource = buildResourceVersion(input);
  const registryFile = resolveRegistryFile(options.repoDir, options.dir);
  const existing = listResources({ type: resource.type, name: resource.name }, options.repoDir)
    .find((record) => record.contentHash === resource.contentHash);
  if (existing) {
    return existing;
  }

  mkdirSync(resolveRegistryDir(options.repoDir, options.dir), { recursive: true });
  appendJsonlRecord(registryFile, resource);
  return resource;
}

export function toResourceRef(resource: ResourceVersion | ResourceRef | null | undefined): ResourceRef | null {
  if (!resource) {
    return null;
  }
  return { id: resource.id, version: resource.version };
}
