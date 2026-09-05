import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import type { ModelCapabilities, ModelRegistry, RegistryTaskType } from './model-registry.ts';

export const MODEL_REGISTRY_CATALOG_SCHEMA_VERSION = '1';

export interface ModelCatalogEntry {
  id: string;
  capabilities: ModelCapabilities;
}

export interface ModelRegistryCatalog {
  schemaVersion: string;
  models: ModelCatalogEntry[];
  openrouterMappings?: unknown[];
  ladders: Partial<Record<RegistryTaskType, string[]>>;
}

const moduleDir = dirname(fileURLToPath(import.meta.url));
const defaultCatalogPath = join(moduleDir, '..', 'fixtures', 'model-registry.v1.json');
const defaultSchemaPath = join(moduleDir, '..', 'schemas', 'model-registry.schema.json');

export class ModelRegistryCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelRegistryCatalogError';
  }
}

function parseJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch (error) {
    throw new ModelRegistryCatalogError(
      `Invalid model registry catalog at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function validateSchema(parsed: unknown, schemaPath: string): void {
  const schema = parseJsonFile(schemaPath);
  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(schema);
  if (validate(parsed)) {
    return;
  }
  const details = (validate.errors ?? [])
    .map((error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`)
    .join('; ');
  throw new ModelRegistryCatalogError(`Invalid model registry catalog: ${details}`);
}

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ModelRegistryCatalogError(`Invalid model registry catalog: ${label} must be an object`);
  }
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function mapId(
  seen: Map<string, string>,
  value: unknown,
  modelId: string,
  label: string,
): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return;
  }
  const previous = seen.get(value);
  if (previous && previous !== modelId) {
    throw new ModelRegistryCatalogError(
      `Invalid model registry catalog: duplicate ${label} "${value}" used by ${previous} and ${modelId}`,
    );
  }
  seen.set(value, modelId);
}

function validateCatalogSemantics(catalog: ModelRegistryCatalog): void {
  if (catalog.schemaVersion !== MODEL_REGISTRY_CATALOG_SCHEMA_VERSION) {
    throw new ModelRegistryCatalogError(
      `Invalid model registry catalog: schemaVersion must be ${MODEL_REGISTRY_CATALOG_SCHEMA_VERSION}`,
    );
  }

  const modelIds = new Set<string>();
  const aliases = new Map<string, string>();
  const providerNativeIds = new Map<string, string>();

  for (const entry of catalog.models) {
    if (modelIds.has(entry.id)) {
      throw new ModelRegistryCatalogError(`Invalid model registry catalog: duplicate model id "${entry.id}"`);
    }
    modelIds.add(entry.id);

    const capabilities = entry.capabilities as unknown;
    assertObject(capabilities, `models.${entry.id}.capabilities`);
    const supportedModel = (capabilities as { supportedModel?: unknown }).supportedModel;
    const identity = (capabilities as { identity?: unknown }).identity;
    if (supportedModel !== undefined) {
      assertObject(supportedModel, `models.${entry.id}.capabilities.supportedModel`);
    }
    assertObject(identity ?? {}, `models.${entry.id}.capabilities.identity`);

    const alias = (supportedModel as { wavemillAlias?: unknown } | undefined)?.wavemillAlias ?? entry.id;
    mapId(aliases, alias, entry.id, 'wavemill alias');

    const providerNativeId = (supportedModel as { providerNativeId?: unknown } | undefined)?.providerNativeId;
    const lifecycle = (supportedModel as { lifecycle?: unknown } | undefined)?.lifecycle;
    // Deprecated aliases may retain a historical providerNativeId; every
    // other alias must map to a distinct provider-native model.
    if (identity !== undefined || lifecycle !== 'deprecated') {
      mapId(providerNativeIds, providerNativeId, entry.id, 'providerNativeId');
    }
  }

  for (const entry of catalog.models) {
    const lineage = entry.capabilities.identity?.lineage;
    const successor = lineage?.successor;
    if (!successor) {
      continue;
    }
    if (!modelIds.has(successor)) {
      throw new ModelRegistryCatalogError(
        `Invalid model registry catalog: model ${entry.id} successor "${successor}" does not exist`,
      );
    }
    const successorEntry = catalog.models.find((candidate) => candidate.id === successor);
    if (successorEntry?.capabilities.identity?.status === 'provisional') {
      throw new ModelRegistryCatalogError(
        `Invalid model registry catalog: model ${entry.id} successor "${successor}" must not be provisional`,
      );
    }

    const seen = new Set<string>([entry.id]);
    let cursor: string | undefined = successor;
    while (cursor) {
      if (seen.has(cursor)) {
        throw new ModelRegistryCatalogError(
          `Invalid model registry catalog: model ${entry.id} lineage contains a cycle through ${cursor}`,
        );
      }
      seen.add(cursor);
      cursor = catalog.models.find((candidate) => candidate.id === cursor)?.capabilities.identity?.lineage?.successor;
    }
  }
}

export function projectModelRegistryCatalog(catalog: ModelRegistryCatalog): ModelRegistry {
  validateCatalogSemantics(catalog);
  return {
    models: Object.fromEntries(
      catalog.models.map((entry) => [entry.id, cloneJson(entry.capabilities)]),
    ),
    ladders: cloneJson(catalog.ladders),
  };
}

export function loadModelRegistryCatalog(catalogPath = defaultCatalogPath): ModelRegistryCatalog {
  const parsed = parseJsonFile(catalogPath);
  validateSchema(parsed, defaultSchemaPath);
  const catalog = parsed as ModelRegistryCatalog;
  validateCatalogSemantics(catalog);
  return cloneJson(catalog);
}

export function loadDefaultModelRegistry(): ModelRegistry {
  return projectModelRegistryCatalog(loadModelRegistryCatalog());
}

function sortKeysReplacer(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = (value as Record<string, unknown>)[key];
    }
    return sorted;
  }
  return value;
}

export function serializeModelRegistryProjection(registry: ModelRegistry): string {
  return `${JSON.stringify(registry, sortKeysReplacer, 2)}\n`;
}

export function hashModelRegistryProjection(registry: ModelRegistry): string {
  return createHash('sha256').update(serializeModelRegistryProjection(registry)).digest('hex');
}
