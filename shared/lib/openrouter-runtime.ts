import { errorMessage } from './error-utils.ts';
import type {
  FamilyCapabilities,
} from './openrouter-capabilities.ts';
import { getFamilyCapabilities } from './openrouter-capabilities.ts';
import type {
  NormalizedCatalogEntry,
  NormalizedPricing,
} from './openrouter-catalog.ts';
import {
  assertOpenRouterBalanceSufficient,
  capOpenRouterMaxTokensForBalance,
} from './native-agent/openrouter-credits-guard.ts';

export type BlockerCategory =
  | 'provider_unavailable'
  | 'unsupported_parameter'
  | 'auth_rate_limit'
  | 'billing_exhausted'
  | 'model_response_error';

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

export interface OpenRouterRequest {
  modelId: string;
  messages: Message[];
  temperature?: number;
  stream?: boolean;
  tools?: unknown[];
  estimatedTokens?: number;
  maxOutputTokens?: number;
}

export type ConstraintResult =
  | { ok: true }
  | { ok: false; category: 'unsupported_parameter'; detail: string };

export type OpenRouterTransport = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export type DispatchResult =
  | {
    status: 'ok';
    modelId: string;
    content: string;
    usage?: TokenUsage;
    costUsd: number | null;
    raw: unknown;
  }
  | {
    status: 'blocker';
    modelId: string;
    category: BlockerCategory;
    detail: string;
    raw?: unknown;
  };

interface ErrorBody {
  error?: {
    message?: unknown;
    code?: unknown;
  };
  message?: unknown;
}

export function classifyOpenRouterError(input: {
  status: number;
  body: unknown;
  transportError?: Error;
}): { category: BlockerCategory; detail: string; raw: unknown } {
  const raw = redactSensitive(input.body);

  if (input.transportError) {
    return {
      category: 'provider_unavailable',
      detail: input.transportError.message || 'OpenRouter transport failed',
      raw,
    };
  }

  if (input.status === 401 || input.status === 403 || input.status === 429) {
    return {
      category: 'auth_rate_limit',
      detail: extractErrorDetail(input.status, input.body),
      raw,
    };
  }

  if (input.status === 402) {
    return {
      category: 'billing_exhausted',
      detail: extractErrorDetail(input.status, input.body),
      raw,
    };
  }

  if (input.status >= 500 && input.status <= 599) {
    return {
      category: 'provider_unavailable',
      detail: extractErrorDetail(input.status, input.body),
      raw,
    };
  }

  if (
    input.status === 400
    && isUnsupportedParameterError(input.body)
  ) {
    return {
      category: 'unsupported_parameter',
      detail: extractErrorDetail(input.status, input.body),
      raw,
    };
  }

  if (input.status === 200 && !extractAssistantContent(input.body)) {
    return {
      category: 'model_response_error',
      detail: 'OpenRouter response did not include assistant content.',
      raw,
    };
  }

  return {
    category: 'model_response_error',
    detail: extractErrorDetail(input.status, input.body),
    raw,
  };
}

export function enforceConstraints(
  request: OpenRouterRequest,
  entry: NormalizedCatalogEntry,
): ConstraintResult {
  const capabilities = resolveCapabilities(entry);
  const requestedTools = request.tools?.length ?? 0;

  if (
    typeof request.estimatedTokens === 'number'
    && typeof request.maxOutputTokens === 'number'
    && typeof entry.contextTokens === 'number'
    && request.estimatedTokens + request.maxOutputTokens > entry.contextTokens
  ) {
    return {
      ok: false,
      category: 'unsupported_parameter',
      detail: `Requested token budget exceeds ${entry.wavemillAlias} context window (${entry.contextTokens} tokens).`,
    };
  }

  if (
    typeof request.temperature === 'number'
    && !capabilities.supportsTemperature
  ) {
    return {
      ok: false,
      category: 'unsupported_parameter',
      detail: `${entry.wavemillAlias} does not support temperature overrides.`,
    };
  }

  if (
    typeof request.temperature === 'number'
    && capabilities.temperatureRange
    && (
      request.temperature < capabilities.temperatureRange[0]
      || request.temperature > capabilities.temperatureRange[1]
    )
  ) {
    return {
      ok: false,
      category: 'unsupported_parameter',
      detail: `${entry.wavemillAlias} temperature must be between ${capabilities.temperatureRange[0]} and ${capabilities.temperatureRange[1]}.`,
    };
  }

  if (request.stream === true && !capabilities.supportsStreaming) {
    return {
      ok: false,
      category: 'unsupported_parameter',
      detail: `${entry.wavemillAlias} does not support streaming responses.`,
    };
  }

  if (requestedTools > 0 && !capabilities.supportsTools) {
    return {
      ok: false,
      category: 'unsupported_parameter',
      detail: `${entry.wavemillAlias} does not support tool calls.`,
    };
  }

  return { ok: true };
}

export async function dispatchOpenRouterRequest(
  request: OpenRouterRequest,
  entry: NormalizedCatalogEntry,
  opts: {
    apiKey: string;
    baseUrl?: string;
    transport?: OpenRouterTransport;
    timeoutMs?: number;
    repoDir?: string;
  },
): Promise<DispatchResult> {
  const modelId = entry.wavemillAlias;
  const constraint = enforceConstraints(request, entry);
  if (!constraint.ok) {
    return {
      status: 'blocker',
      modelId,
      category: constraint.category,
      detail: constraint.detail,
    };
  }

  if (typeof opts.apiKey !== 'string' || opts.apiKey.trim().length === 0) {
    throw new Error('OpenRouter API key is required for direct dispatch.');
  }

  assertOpenRouterBalanceSufficient({
    repoDir: opts.repoDir,
    model: modelId,
    pricing: entry.pricing,
  });

  const payload: Record<string, unknown> = {
    model: entry.openrouterId,
    messages: request.messages,
  };
  if (typeof request.temperature === 'number') {
    payload.temperature = request.temperature;
  }
  if (typeof request.maxOutputTokens === 'number') {
    payload.max_tokens = capOpenRouterMaxTokensForBalance({
      requestedMaxTokens: request.maxOutputTokens,
      pricing: entry.pricing,
      repoDir: opts.repoDir,
      inputCostReserveUsd: estimateInputCostReserveUsd(request.estimatedTokens, entry.pricing),
    });
  }
  if ((request.tools?.length ?? 0) > 0) {
    payload.tools = request.tools;
  }

  const transport = opts.transport ?? fetch;
  const url = buildChatCompletionsUrl(opts.baseUrl);
  const init: RequestInit = {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  };

  const { signal, cancel } = createTimeoutSignal(opts.timeoutMs);
  if (signal) {
    init.signal = signal;
  }

  try {
    const response = await transport(url, init);
    const body = await readResponseBody(response);
    if (!response.ok) {
      const failure = classifyOpenRouterError({ status: response.status, body });
      return {
        status: 'blocker',
        modelId,
        category: failure.category,
        detail: failure.detail,
        raw: failure.raw,
      };
    }

    const content = extractAssistantContent(body);
    if (!content) {
      const failure = classifyOpenRouterError({ status: response.status, body });
      return {
        status: 'blocker',
        modelId,
        category: failure.category,
        detail: failure.detail,
        raw: failure.raw,
      };
    }

    const usage = extractUsage(body);
    return {
      status: 'ok',
      modelId,
      content,
      usage: usage ?? undefined,
      costUsd: computeRunCostUsd(usage, entry.pricing),
      raw: redactSensitive(body),
    };
  } catch (error) {
    const failure = classifyOpenRouterError({
      status: 0,
      body: {
        error: { message: errorMessage(error) },
      },
      transportError: error instanceof Error ? error : new Error(errorMessage(error)),
    });
    return {
      status: 'blocker',
      modelId,
      category: failure.category,
      detail: failure.detail,
      raw: failure.raw,
    };
  } finally {
    cancel();
  }
}

export function computeRunCostUsd(
  usage: TokenUsage | null | undefined,
  pricing: NormalizedPricing,
): number | null {
  if (!usage) {
    return null;
  }

  if (
    pricing.inputPerMTok === null
    || pricing.outputPerMTok === null
  ) {
    return null;
  }

  const cost = (
    (usage.inputTokens / 1_000_000) * pricing.inputPerMTok
    + (usage.outputTokens / 1_000_000) * pricing.outputPerMTok
  );
  return Number(cost.toFixed(12));
}

function resolveCapabilities(entry: NormalizedCatalogEntry): FamilyCapabilities {
  return entry.capabilities ?? getFamilyCapabilities(entry.family);
}

function buildChatCompletionsUrl(baseUrl?: string): string {
  const normalizedBase = (baseUrl ?? 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
  if (normalizedBase.endsWith('/chat/completions')) {
    return normalizedBase;
  }
  if (normalizedBase.endsWith('/v1')) {
    return `${normalizedBase}/chat/completions`;
  }
  return `${normalizedBase}/v1/chat/completions`;
}

function estimateInputCostReserveUsd(
  estimatedTokens: number | undefined,
  pricing: NormalizedPricing,
): number {
  if (
    typeof estimatedTokens !== 'number'
    || !Number.isFinite(estimatedTokens)
    || estimatedTokens <= 0
    || typeof pricing.inputPerMTok !== 'number'
    || !Number.isFinite(pricing.inputPerMTok)
    || pricing.inputPerMTok <= 0
  ) {
    return 0;
  }
  return (estimatedTokens / 1_000_000) * pricing.inputPerMTok;
}

function createTimeoutSignal(
  timeoutMs?: number,
): { signal?: AbortSignal; cancel: () => void } {
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return { cancel: () => {} };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    cancel: () => clearTimeout(timer),
  };
}

async function readResponseBody(response: Response): Promise<unknown> {
  if (typeof response.text === 'function') {
    const raw = await response.text();
    if (raw.length === 0) {
      return null;
    }
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return raw;
    }
  }

  if (typeof response.json === 'function') {
    return response.json();
  }

  return null;
}

function isUnsupportedParameterError(body: unknown): boolean {
  const code = extractErrorCode(body);
  if (code === 'unsupported_parameter') {
    return true;
  }

  const detail = extractErrorMessage(body);
  return /unsupported|invalid parameter/i.test(detail);
}

function extractErrorCode(body: unknown): string {
  if (!body || typeof body !== 'object') {
    return '';
  }
  const maybeCode = (body as ErrorBody).error?.code;
  return typeof maybeCode === 'string' ? maybeCode : '';
}

function extractErrorMessage(body: unknown): string {
  if (!body || typeof body !== 'object') {
    return '';
  }

  const errorBody = body as ErrorBody;
  if (typeof errorBody.error?.message === 'string') {
    return errorBody.error.message;
  }
  if (typeof errorBody.message === 'string') {
    return errorBody.message;
  }
  return '';
}

function extractErrorDetail(status: number, body: unknown): string {
  return extractErrorMessage(body) || `OpenRouter request failed with HTTP ${status}.`;
}

function extractAssistantContent(body: unknown): string | null {
  if (!body || typeof body !== 'object') {
    return null;
  }

  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return null;
  }

  const firstChoice = choices[0] as {
    message?: { content?: unknown };
  } | null;
  const content = firstChoice?.message?.content;
  if (typeof content === 'string') {
    return content.trim().length > 0 ? content : null;
  }

  if (Array.isArray(content)) {
    const text = content
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }
        if (
          part
          && typeof part === 'object'
          && 'text' in part
          && typeof (part as { text?: unknown }).text === 'string'
        ) {
          return (part as { text: string }).text;
        }
        return '';
      })
      .join('')
      .trim();
    return text.length > 0 ? text : null;
  }

  return null;
}

function extractUsage(body: unknown): TokenUsage | null {
  if (!body || typeof body !== 'object') {
    return null;
  }

  const usage = (body as {
    usage?: {
      prompt_tokens?: unknown;
      completion_tokens?: unknown;
    };
  }).usage;

  if (!usage) {
    return null;
  }

  const inputTokens = normalizeTokenCount(usage.prompt_tokens);
  const outputTokens = normalizeTokenCount(usage.completion_tokens);
  if (inputTokens === null || outputTokens === null) {
    return null;
  }

  return { inputTokens, outputTokens };
}

function normalizeTokenCount(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return value;
}

function redactSensitive(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitive(item));
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (/(authorization|api[-_]?key|token|secret)/i.test(key)) {
      redacted[key] = '[redacted]';
      continue;
    }
    redacted[key] = redactSensitive(nested);
  }
  return redacted;
}
