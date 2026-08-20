import { OPENROUTER_DEFAULT_API_KEY_ENV, OPENROUTER_DEFAULT_BASE_URL } from './native-agent/providers.ts';

export interface OpenRouterCredits {
  totalCredits: number;
  totalUsage: number;
  balanceUsd: number;
  usageDaily: number | null;
}

export type OpenRouterCreditsTransport = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

export interface FetchOpenRouterCreditsOptions {
  env?: Record<string, string | undefined>;
  apiKeyEnv?: string;
  baseUrl?: string;
  transport?: OpenRouterCreditsTransport;
  signal?: AbortSignal;
}

export async function fetchOpenRouterCredits(
  opts: FetchOpenRouterCreditsOptions = {},
): Promise<OpenRouterCredits | null> {
  const env = opts.env ?? process.env;
  const apiKeyEnv = opts.apiKeyEnv?.trim() || OPENROUTER_DEFAULT_API_KEY_ENV;
  const apiKey = env[apiKeyEnv]?.trim();
  if (!apiKey) {
    return null;
  }

  const transport = opts.transport ?? fetch;
  const response = await transport(buildCreditsUrl(opts.baseUrl), {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    },
    signal: opts.signal,
  });

  if (response.status === 401 || response.status === 403) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`OpenRouter credits request failed with HTTP ${response.status}.`);
  }

  const body = await readJsonBody(response);
  return normalizeCreditsBody(body);
}

function buildCreditsUrl(baseUrl?: string): string {
  const normalizedBase = (baseUrl ?? OPENROUTER_DEFAULT_BASE_URL).replace(/\/+$/, '');
  if (normalizedBase.endsWith('/credits')) {
    return normalizedBase;
  }
  if (normalizedBase.endsWith('/v1')) {
    return `${normalizedBase}/credits`;
  }
  return `${normalizedBase}/v1/credits`;
}

async function readJsonBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.trim().length === 0) {
    throw new Error('OpenRouter credits response was empty.');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('OpenRouter credits response was not valid JSON.');
  }
}

function normalizeCreditsBody(body: unknown): OpenRouterCredits {
  if (!body || typeof body !== 'object') {
    throw new Error('OpenRouter credits response was not an object.');
  }

  const candidate = body as {
    total_credits?: unknown;
    total_usage?: unknown;
    usage_daily?: unknown;
  };
  const totalCredits = numberField(candidate.total_credits, 'total_credits');
  const totalUsage = numberField(candidate.total_usage, 'total_usage');
  const usageDaily = nullableNumberField(candidate.usage_daily, 'usage_daily');

  return {
    totalCredits,
    totalUsage,
    balanceUsd: Number((totalCredits - totalUsage).toFixed(12)),
    usageDaily,
  };
}

function numberField(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`OpenRouter credits response missing numeric ${field}.`);
  }
  return value;
}

function nullableNumberField(value: unknown, field: string): number | null {
  if (value == null) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`OpenRouter credits response has non-numeric ${field}.`);
  }
  return value;
}
