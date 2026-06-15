import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_MODEL_REGISTRY, isKnownModelId } from './model-registry.ts';

export type LaunchPriorityStatus = 'active' | 'watchlist';
export type RoleEligibility = 'planner' | 'coder' | 'reviewer';
export type CatalogBlockerReason = 'not_found' | 'deprecated' | 'unavailable';

export interface LaunchPriorityModel {
  openrouterId: string;
  wavemillAlias: string;
  family: string;
  priorityTier: number;
  status: LaunchPriorityStatus;
  roleEligibility: RoleEligibility[];
}

export interface OpenRouterApiModel {
  id: string;
  canonical_slug?: string | null;
  name: string;
  context_length?: number | null;
  pricing: {
    prompt: string;
    completion: string;
    [key: string]: string | undefined;
  };
  top_provider?: {
    context_length?: number | null;
    max_completion_tokens?: number | null;
    is_moderated?: boolean | null;
  } | null;
  architecture?: {
    modality?: string | null;
    input_modalities?: string[] | null;
    output_modalities?: string[] | null;
    tokenizer?: string | null;
    instruct_type?: string | null;
  } | null;
  description?: string | null;
  created?: number | null;
  expiration_date?: string | null;
}

export interface NormalizedCatalogEntry {
  openrouterId: string;
  providerId: string;
  wavemillAlias: string;
  family: string;
  openrouterName: string;
  contextLength: number;
  maxCompletionTokens: number | null;
  pricing: {
    inputPerMTok: number;
    outputPerMTok: number;
  };
  roleEligibility: RoleEligibility[];
  status: LaunchPriorityStatus;
  priorityTier: number;
  registryValidated: boolean;
  isModerated: boolean | null;
}

export interface CatalogBlocker {
  openrouterId: string;
  wavemillAlias: string;
  family: string;
  status: LaunchPriorityStatus;
  priorityTier: number;
  reason: CatalogBlockerReason;
  detail: string;
}

export interface CatalogSyncResult {
  entries: NormalizedCatalogEntry[];
  blockers: CatalogBlocker[];
  snapshotAt: string;
  sourceUrl: string;
}

export interface NormalizeCatalogOptions {
  snapshotAt?: string;
  sourceUrl?: string;
}

const DEFAULT_SOURCE_URL = 'https://openrouter.ai/api/v1/models';
const DEFAULT_FIXTURE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../tests/fixtures/models/model_30_launch_priority_models.v1.json',
);

const PROVIDER_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  '01-ai': '01-ai',
  anthropic: 'anthropic',
  baichuan: 'baichuan',
  'baichuan-inc': 'baichuan',
  cohere: 'cohere',
  deepseek: 'deepseek',
  google: 'google',
  meta: 'meta',
  'meta-llama': 'meta',
  microsoft: 'microsoft',
  mistralai: 'mistral',
  moonshot: 'moonshot',
  moonshotai: 'moonshot',
  nousresearch: 'nous',
  openai: 'openai',
  qwen: 'qwen',
  'x-ai': 'xai',
});

function compareByOpenRouterId<
  T extends Pick<NormalizedCatalogEntry, 'openrouterId' | 'wavemillAlias'>
    | Pick<CatalogBlocker, 'openrouterId' | 'wavemillAlias'>
>(left: T, right: T): number {
  const idDelta = left.openrouterId.localeCompare(right.openrouterId);
  if (idDelta !== 0) {
    return idDelta;
  }

  return left.wavemillAlias.localeCompare(right.wavemillAlias);
}

function parsePositiveInteger(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  return Math.trunc(value);
}

function normalizeProviderId(openrouterId: string): string {
  const providerSegment = openrouterId.split('/', 1)[0]?.trim() ?? '';
  return PROVIDER_ALIASES[providerSegment] ?? providerSegment;
}

function getResolvedContextLength(model: OpenRouterApiModel): number | null {
  return parsePositiveInteger(model.context_length) ?? parsePositiveInteger(model.top_provider?.context_length);
}

function getPastExpirationDate(model: OpenRouterApiModel, snapshotAt: string): string | null {
  if (typeof model.expiration_date !== 'string' || model.expiration_date.trim().length === 0) {
    return null;
  }

  const expirationTime = Date.parse(model.expiration_date);
  const snapshotTime = Date.parse(snapshotAt);
  if (!Number.isFinite(expirationTime) || !Number.isFinite(snapshotTime)) {
    return null;
  }

  return expirationTime <= snapshotTime ? model.expiration_date : null;
}

export function loadLaunchPriorityList(fixturePath = DEFAULT_FIXTURE_PATH): LaunchPriorityModel[] {
  const raw = readFileSync(fixturePath, 'utf-8');
  const parsed = JSON.parse(raw) as unknown;

  if (!Array.isArray(parsed)) {
    throw new Error(`Launch priority fixture must be a JSON array: ${fixturePath}`);
  }

  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`Launch priority fixture entry ${index} is not an object`);
    }

    const candidate = entry as Partial<LaunchPriorityModel>;
    if (typeof candidate.openrouterId !== 'string' || candidate.openrouterId.length === 0) {
      throw new Error(`Launch priority fixture entry ${index} is missing openrouterId`);
    }
    if (typeof candidate.wavemillAlias !== 'string' || candidate.wavemillAlias.length === 0) {
      throw new Error(`Launch priority fixture entry ${index} is missing wavemillAlias`);
    }
    if (typeof candidate.family !== 'string' || candidate.family.length === 0) {
      throw new Error(`Launch priority fixture entry ${index} is missing family`);
    }
    if (typeof candidate.priorityTier !== 'number' || !Number.isInteger(candidate.priorityTier)) {
      throw new Error(`Launch priority fixture entry ${index} has invalid priorityTier`);
    }
    if (candidate.status !== 'active' && candidate.status !== 'watchlist') {
      throw new Error(`Launch priority fixture entry ${index} has invalid status`);
    }
    if (
      !Array.isArray(candidate.roleEligibility)
      || candidate.roleEligibility.some((role) => role !== 'planner' && role !== 'coder' && role !== 'reviewer')
    ) {
      throw new Error(`Launch priority fixture entry ${index} has invalid roleEligibility`);
    }

    return {
      openrouterId: candidate.openrouterId,
      wavemillAlias: candidate.wavemillAlias,
      family: candidate.family,
      priorityTier: candidate.priorityTier,
      status: candidate.status,
      roleEligibility: [...candidate.roleEligibility],
    };
  });
}

export function buildOpenRouterIndex(models: OpenRouterApiModel[]): Map<string, OpenRouterApiModel> {
  return new Map(models.map((model) => [model.id, model]));
}

export function normalizePricing(raw: {
  prompt: string;
  completion: string;
}): {
  inputPerMTok: number;
  outputPerMTok: number;
} {
  const prompt = Number(raw.prompt);
  const completion = Number(raw.completion);

  if (!Number.isFinite(prompt) || !Number.isFinite(completion) || prompt < 0 || completion < 0) {
    throw new Error(`Invalid OpenRouter pricing payload: prompt=${raw.prompt} completion=${raw.completion}`);
  }

  return {
    inputPerMTok: prompt * 1_000_000,
    outputPerMTok: completion * 1_000_000,
  };
}

export function normalizeCatalog(
  priorityList: LaunchPriorityModel[],
  openRouterModels: OpenRouterApiModel[],
  options: NormalizeCatalogOptions = {},
): CatalogSyncResult {
  const snapshotAt = options.snapshotAt ?? new Date().toISOString();
  const sourceUrl = options.sourceUrl ?? DEFAULT_SOURCE_URL;
  const index = buildOpenRouterIndex(openRouterModels);
  const entries: NormalizedCatalogEntry[] = [];
  const blockers: CatalogBlocker[] = [];

  for (const priorityModel of priorityList) {
    const match = index.get(priorityModel.openrouterId);

    if (!match) {
      blockers.push({
        openrouterId: priorityModel.openrouterId,
        wavemillAlias: priorityModel.wavemillAlias,
        family: priorityModel.family,
        status: priorityModel.status,
        priorityTier: priorityModel.priorityTier,
        reason: 'not_found',
        detail: `OpenRouter model "${priorityModel.openrouterId}" was not present in the fetched catalog.`,
      });
      continue;
    }

    const expiredAt = getPastExpirationDate(match, snapshotAt);
    if (expiredAt) {
      blockers.push({
        openrouterId: priorityModel.openrouterId,
        wavemillAlias: priorityModel.wavemillAlias,
        family: priorityModel.family,
        status: priorityModel.status,
        priorityTier: priorityModel.priorityTier,
        reason: 'deprecated',
        detail: `OpenRouter model "${priorityModel.openrouterId}" expired at ${expiredAt}.`,
      });
      continue;
    }

    const contextLength = getResolvedContextLength(match);
    if (contextLength === null) {
      blockers.push({
        openrouterId: priorityModel.openrouterId,
        wavemillAlias: priorityModel.wavemillAlias,
        family: priorityModel.family,
        status: priorityModel.status,
        priorityTier: priorityModel.priorityTier,
        reason: 'unavailable',
        detail: `OpenRouter model "${priorityModel.openrouterId}" is missing a usable context length.`,
      });
      continue;
    }

    let pricing: NormalizedCatalogEntry['pricing'];
    try {
      pricing = normalizePricing(match.pricing);
    } catch (error) {
      blockers.push({
        openrouterId: priorityModel.openrouterId,
        wavemillAlias: priorityModel.wavemillAlias,
        family: priorityModel.family,
        status: priorityModel.status,
        priorityTier: priorityModel.priorityTier,
        reason: 'unavailable',
        detail: error instanceof Error ? error.message : `Invalid pricing for "${priorityModel.openrouterId}".`,
      });
      continue;
    }

    entries.push({
      openrouterId: priorityModel.openrouterId,
      providerId: normalizeProviderId(priorityModel.openrouterId),
      wavemillAlias: priorityModel.wavemillAlias,
      family: priorityModel.family,
      openrouterName: match.name,
      contextLength,
      maxCompletionTokens: parsePositiveInteger(match.top_provider?.max_completion_tokens),
      pricing,
      roleEligibility: [...priorityModel.roleEligibility],
      status: priorityModel.status,
      priorityTier: priorityModel.priorityTier,
      registryValidated: isKnownModelId(DEFAULT_MODEL_REGISTRY, priorityModel.wavemillAlias),
      isModerated: match.top_provider?.is_moderated ?? null,
    });
  }

  entries.sort(compareByOpenRouterId);
  blockers.sort(compareByOpenRouterId);

  return {
    entries,
    blockers,
    snapshotAt,
    sourceUrl,
  };
}
