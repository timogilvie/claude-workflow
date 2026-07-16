/**
 * OpenRouter Catalog Sync
 *
 * Fetches model metadata from OpenRouter's public model API and joins it
 * against the static launch-priority model list (HOK-2211). Produces a
 * normalized catalog with deterministic snapshot output and an explicit
 * blocker list for missing/deprecated models.
 *
 * Pure functions are used wherever possible to keep the library testable
 * without live HTTP. `fetchOpenRouterModels` accepts an injectable
 * `fetchFn` for unit tests.
 *
 * @module openrouter-catalog
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getFamilyCapabilities,
  type FamilyCapabilities,
} from './openrouter-capabilities.ts';

// ── Types ────────────────────────────────────────────────────────────────────

export const CATALOG_SCHEMA_VERSION = '1';
export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';

export type ModelFamily =
  | 'claude'
  | 'gpt'
  | 'deepseek'
  | 'glm'
  | 'qwen'
  | 'kimi'
  | 'gemini'
  | 'llama'
  | 'mistral'
  | 'grok';

export type ModelStatus = 'active' | 'watchlist' | 'deprecated';
export type RoleEligibility = 'planning' | 'coding' | 'review';

export interface LaunchPriorityModel {
  wavemillAlias: string;
  openrouterId: string;
  family: ModelFamily;
  status: ModelStatus;
  priorityTier: number;
  roleEligibility: RoleEligibility[];
}

export interface LaunchPriorityFixture {
  schemaVersion: string;
  description?: string;
  models: LaunchPriorityModel[];
}

/** Raw OpenRouter API model record (subset of fields we consume). */
export interface OpenRouterModel {
  id: string;
  name?: string;
  context_length?: number;
  pricing?: {
    prompt?: string | number;
    completion?: string | number;
  };
  top_provider?: {
    context_length?: number;
  };
}

export interface NormalizedPricing {
  inputPerMTok: number | null;
  outputPerMTok: number | null;
}

export interface NormalizedCatalogEntry {
  wavemillAlias: string;
  openrouterId: string;
  family: ModelFamily;
  contextTokens: number | null;
  pricing: NormalizedPricing;
  capabilities?: FamilyCapabilities;
  roleEligibility: RoleEligibility[];
  status: ModelStatus;
  priorityTier: number;
  resolvedAt: string;
}

export type BlockerReason =
  | 'not_found_in_openrouter'
  | 'deprecated'
  | 'invalid_pricing';

export interface CatalogBlocker {
  wavemillAlias: string;
  openrouterId: string;
  family: ModelFamily;
  status: ModelStatus;
  priorityTier: number;
  reason: BlockerReason;
  detail: string;
}

export interface NormalizedCatalog {
  schemaVersion: string;
  generatedAt: string;
  sourceHash: string;
  entries: NormalizedCatalogEntry[];
  blockers: CatalogBlocker[];
}

// ── Fixture loading ──────────────────────────────────────────────────────────

const moduleDir = dirname(fileURLToPath(import.meta.url));

/** Default fixture path resolved relative to this module's location. */
export function defaultLaunchPriorityFixturePath(): string {
  return join(moduleDir, '..', 'fixtures', 'model_30_launch_priority_models.v1.json');
}

/**
 * Read and parse the launch-priority model fixture.
 *
 * @param fixturePath Optional override; defaults to the bundled fixture.
 * @returns Parsed fixture contents.
 */
export function loadLaunchPriorityFixture(fixturePath?: string): LaunchPriorityFixture {
  const path = fixturePath ?? defaultLaunchPriorityFixturePath();
  const raw = readFileSync(path, 'utf-8');
  const parsed = JSON.parse(raw) as LaunchPriorityFixture;
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.models)) {
    throw new Error(`Invalid launch-priority fixture at ${path}: missing "models" array`);
  }
  return parsed;
}

/**
 * Convenience wrapper that returns just the model list.
 */
export function loadLaunchPriorityList(fixturePath?: string): LaunchPriorityModel[] {
  return loadLaunchPriorityFixture(fixturePath).models;
}

export function resolveWavemillAliasFromOpenRouterId(
  openrouterId: string | null | undefined,
  fixturePath?: string,
): string | null {
  if (typeof openrouterId !== 'string' || openrouterId.trim().length === 0) {
    return null;
  }

  const model = loadLaunchPriorityList(fixturePath)
    .find((entry) => entry.openrouterId === openrouterId);
  return model?.wavemillAlias ?? null;
}

export function resolveOpenRouterIdFromWavemillAlias(
  wavemillAlias: string | null | undefined,
  fixturePath?: string,
): string | null {
  if (typeof wavemillAlias !== 'string' || wavemillAlias.trim().length === 0) {
    return null;
  }

  const model = loadLaunchPriorityList(fixturePath)
    .find((entry) => entry.wavemillAlias === wavemillAlias);
  return model?.openrouterId ?? null;
}

/**
 * Look up a launch-priority model by either its wavemill alias
 * (e.g. "qwen-3-coder") or its OpenRouter slug (e.g. "qwen/qwen3-coder").
 * Returns null when the identifier is not present in the launch-priority list.
 */
export function resolveLaunchPriorityModel(
  modelIdOrAlias: string | null | undefined,
  fixturePath?: string,
): LaunchPriorityModel | null {
  if (typeof modelIdOrAlias !== 'string' || modelIdOrAlias.trim().length === 0) {
    return null;
  }

  const id = modelIdOrAlias.trim();
  return loadLaunchPriorityList(fixturePath)
    .find((entry) => entry.wavemillAlias === id || entry.openrouterId === id) ?? null;
}

/**
 * Hash the launch-priority fixture for snapshot auditability. Hashes the
 * raw file bytes so any whitespace or ordering change yields a new hash.
 */
export function hashLaunchPriorityFixture(fixturePath?: string): string {
  const path = fixturePath ?? defaultLaunchPriorityFixturePath();
  const raw = readFileSync(path);
  return createHash('sha256').update(raw).digest('hex');
}

// ── OpenRouter HTTP fetcher ──────────────────────────────────────────────────

export interface OpenRouterApiResponse {
  data: OpenRouterModel[];
}

export type FetchLike = typeof fetch;

/**
 * Fetch the live OpenRouter model catalog and return it as a Map keyed by
 * model id.
 *
 * Accepts an injectable `fetchFn` so unit tests can supply canned responses
 * without making network calls.
 */
export async function fetchOpenRouterModels(
  fetchFn: FetchLike = fetch,
  url: string = OPENROUTER_MODELS_URL,
): Promise<Map<string, OpenRouterModel>> {
  const response = await fetchFn(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(
      `OpenRouter model fetch failed: HTTP ${response.status} ${response.statusText}`,
    );
  }
  const body = (await response.json()) as OpenRouterApiResponse;
  if (!body || !Array.isArray(body.data)) {
    throw new Error('OpenRouter response missing "data" array');
  }
  const map = new Map<string, OpenRouterModel>();
  for (const model of body.data) {
    if (model && typeof model.id === 'string' && model.id.length > 0) {
      map.set(model.id, model);
    }
  }
  return map;
}

// ── Normalization ────────────────────────────────────────────────────────────

const TOKENS_PER_MILLION = 1_000_000;

function parsePricingValue(value: unknown): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  const asNumber = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(asNumber)) {
    return null;
  }
  return asNumber * TOKENS_PER_MILLION;
}

function resolveContextTokens(model: OpenRouterModel): number | null {
  if (typeof model.context_length === 'number' && Number.isFinite(model.context_length)) {
    return model.context_length;
  }
  const fromProvider = model.top_provider?.context_length;
  if (typeof fromProvider === 'number' && Number.isFinite(fromProvider)) {
    return fromProvider;
  }
  return null;
}

export interface NormalizeOptions {
  /** Override the resolution timestamp (used by snapshot tests for determinism). */
  resolvedAt?: string;
}

export interface NormalizeResult {
  entries: NormalizedCatalogEntry[];
  blockers: CatalogBlocker[];
}

/**
 * Pure join/normalize function. Given the launch-priority list and the
 * OpenRouter model map, produce normalized entries and a blocker list.
 *
 * - Active and watchlist models: look up by openrouterId. If found,
 *   normalize pricing (per-token → per-MTok) and produce an entry. If
 *   not found, produce a `not_found_in_openrouter` blocker.
 * - Deprecated models: skipped from entries but reported as `deprecated`
 *   blockers for audit completeness.
 */
export function normalizeCatalog(
  launchPriorityList: LaunchPriorityModel[],
  openRouterModels: Map<string, OpenRouterModel>,
  options: NormalizeOptions = {},
): NormalizeResult {
  const resolvedAt = options.resolvedAt ?? new Date().toISOString();
  const entries: NormalizedCatalogEntry[] = [];
  const blockers: CatalogBlocker[] = [];

  for (const lp of launchPriorityList) {
    if (lp.status === 'deprecated') {
      blockers.push({
        wavemillAlias: lp.wavemillAlias,
        openrouterId: lp.openrouterId,
        family: lp.family,
        status: lp.status,
        priorityTier: lp.priorityTier,
        reason: 'deprecated',
        detail: `Model ${lp.wavemillAlias} is marked deprecated and skipped from active catalog`,
      });
      continue;
    }

    const orModel = openRouterModels.get(lp.openrouterId);
    if (!orModel) {
      blockers.push({
        wavemillAlias: lp.wavemillAlias,
        openrouterId: lp.openrouterId,
        family: lp.family,
        status: lp.status,
        priorityTier: lp.priorityTier,
        reason: 'not_found_in_openrouter',
        detail: `OpenRouter id "${lp.openrouterId}" not present in fetched model list`,
      });
      continue;
    }

    const inputPerMTok = parsePricingValue(orModel.pricing?.prompt);
    const outputPerMTok = parsePricingValue(orModel.pricing?.completion);
    const contextTokens = resolveContextTokens(orModel);

    entries.push({
      wavemillAlias: lp.wavemillAlias,
      openrouterId: lp.openrouterId,
      family: lp.family,
      contextTokens,
      pricing: { inputPerMTok, outputPerMTok },
      capabilities: getFamilyCapabilities(lp.family),
      roleEligibility: [...lp.roleEligibility],
      status: lp.status,
      priorityTier: lp.priorityTier,
      resolvedAt,
    });
  }

  return { entries, blockers };
}

// ── Snapshot building ────────────────────────────────────────────────────────

export interface BuildSnapshotOptions {
  /** Override generatedAt (used by tests for determinism). */
  generatedAt?: string;
  schemaVersion?: string;
}

/**
 * Build a deterministic snapshot artifact suitable for writing to disk.
 *
 * Entries and blockers are sorted by (priorityTier, wavemillAlias) so the
 * output is stable across runs as long as the inputs match.
 */
export function buildCatalogSnapshot(
  entries: NormalizedCatalogEntry[],
  blockers: CatalogBlocker[],
  sourceHash: string,
  options: BuildSnapshotOptions = {},
): NormalizedCatalog {
  const sortedEntries = [...entries].sort(compareByTierAndAlias);
  const sortedBlockers = [...blockers].sort(compareByTierAndAlias);
  return {
    schemaVersion: options.schemaVersion ?? CATALOG_SCHEMA_VERSION,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    sourceHash,
    entries: sortedEntries,
    blockers: sortedBlockers,
  };
}

function compareByTierAndAlias(
  left: { priorityTier: number; wavemillAlias: string },
  right: { priorityTier: number; wavemillAlias: string },
): number {
  if (left.priorityTier !== right.priorityTier) {
    return left.priorityTier - right.priorityTier;
  }
  return left.wavemillAlias.localeCompare(right.wavemillAlias);
}

/**
 * Serialize a snapshot with deterministic key ordering. Top-level keys are
 * emitted in fixed order and nested objects use sorted keys.
 */
export function serializeSnapshot(snapshot: NormalizedCatalog): string {
  return JSON.stringify(snapshot, sortKeysReplacer, 2) + '\n';
}

function sortKeysReplacer(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[k] = (value as Record<string, unknown>)[k];
    }
    return sorted;
  }
  return value;
}

/**
 * Convenience: returns true if any tier-1 active model is blocked.
 * Used by the CLI to decide its exit code.
 */
export function hasTier1ActiveBlockers(blockers: CatalogBlocker[]): boolean {
  return blockers.some(
    (b) => b.priorityTier === 1 && b.status === 'active' && b.reason !== 'deprecated',
  );
}
