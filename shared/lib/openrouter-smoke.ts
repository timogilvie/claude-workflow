import type {
  ModelFamily,
  NormalizedCatalogEntry,
} from './openrouter-catalog.ts';
import {
  dispatchOpenRouterRequest,
  type BlockerCategory,
  type OpenRouterTransport,
} from './openrouter-runtime.ts';

export interface SmokeReport {
  modelId: string;
  family: ModelFamily;
  status: 'ok' | 'blocker';
  category?: BlockerCategory;
  detail?: string;
  costUsd?: number | null;
}

export async function runOpenRouterSmoke(opts: {
  entries: NormalizedCatalogEntry[];
  transport?: OpenRouterTransport;
  apiKey?: string;
  prompt?: string;
  baseUrl?: string;
}): Promise<SmokeReport[]> {
  if (opts.entries.length === 0) {
    return [];
  }

  if (!opts.transport && (!opts.apiKey || opts.apiKey.trim().length === 0)) {
    return opts.entries.map((entry) => ({
      modelId: entry.wavemillAlias,
      family: entry.family,
      status: 'blocker',
      category: 'provider_unavailable',
      detail: 'OpenRouter API key is required for live smoke runs.',
    }));
  }

  const prompt = opts.prompt ?? 'ping';
  const apiKey = opts.apiKey?.trim() || 'mock-openrouter-key';
  const reports: SmokeReport[] = [];

  for (const entry of opts.entries) {
    try {
      const result = await dispatchOpenRouterRequest(
        {
          modelId: entry.wavemillAlias,
          messages: [{ role: 'user', content: prompt }],
        },
        entry,
        {
          apiKey,
          baseUrl: opts.baseUrl,
          transport: opts.transport,
        },
      );

      if (result.status === 'ok') {
        reports.push({
          modelId: result.modelId,
          family: entry.family,
          status: 'ok',
          costUsd: result.costUsd,
        });
        continue;
      }

      reports.push({
        modelId: result.modelId,
        family: entry.family,
        status: 'blocker',
        category: result.category,
        detail: result.detail,
      });
    } catch (error) {
      reports.push({
        modelId: entry.wavemillAlias,
        family: entry.family,
        status: 'blocker',
        category: 'provider_unavailable',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return reports;
}
