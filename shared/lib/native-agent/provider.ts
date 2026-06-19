/**
 * ToolCallingProvider seam — wraps Pi-ai behind a vendor-neutral interface.
 *
 * All Pi imports are confined to this file and messages.ts.
 * No Pi type must appear in any exported signature.
 *
 * @module native-agent/provider
 */

import {
  completeSimple,
  registerApiProvider,
  createAssistantMessageEventStream,
} from '@earendil-works/pi-ai';
import type { StreamFunction } from '@earendil-works/pi-ai';

import {
  buildPiContext,
  mapAssistantMessage,
  buildPiAssistantMessage,
  mapFinishReasonToStopReason,
} from './messages.ts';

// Re-export all neutral types so callers import only from provider.ts.
export type {
  AgentMessage,
  AgentToolSchema,
  FinishReason,
  MockTurnResult,
  MockTurnUsage,
  NativeToolCall,
  ProviderConversationState,
  ProviderTurnEvent,
  ProviderTurnInput,
  ProviderTurnResult,
} from './messages.ts';

export { mapPiUsageToSessionModelUsage } from './messages.ts';

// ─── Public interfaces ────────────────────────────────────────────────────────

/** Configuration for a Pi-backed ToolCallingProvider. */
export interface NativeProviderConfig {
  /** Registered Pi API identifier (from registerApiProvider). */
  api: string;
  /** Model identifier reported in turn results. */
  modelId: string;
  /** Provider name reported in turn results. */
  providerName: string;
  /** Base URL (required by Pi Model shape; any value works for mock providers). */
  baseUrl?: string;
}

/** Vendor-neutral provider interface. All methods accept and return Wavemill types only. */
export interface ToolCallingProvider {
  createTurn(input: import('./messages.ts').ProviderTurnInput): Promise<import('./messages.ts').ProviderTurnResult>;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Creates a `ToolCallingProvider` backed by a Pi-registered API provider.
 *
 * The provider must already be registered via `registerApiProvider` (or
 * `registerMockProvider` in tests) before `createTurn` is called.
 */
export function createToolCallingProvider(config: NativeProviderConfig): ToolCallingProvider {
  const piModel = buildPiModel(config);

  return {
    async createTurn(input) {
      const context = buildPiContext(input);
      const message = await completeSimple(piModel as Parameters<typeof completeSimple>[0], context, {
        signal: input.signal,
        temperature: input.temperature,
        maxTokens: input.maxTokens,
        metadata: input.metadata,
      });
      return mapAssistantMessage(message);
    },
  };
}

// ─── Mock substrate ───────────────────────────────────────────────────────────

/**
 * Registers a deterministic mock provider for use in tests.
 *
 * The handler receives a neutral context and returns a neutral result;
 * Pi types never appear in the handler signature. Using a unique `api`
 * string per test file avoids global Pi registry collisions.
 *
 * @example
 * registerMockProvider('my-test-provider', ({ messages }) => ({
 *   text: 'Hello',
 *   usage: { input: 10, output: 5 },
 * }));
 */
export function registerMockProvider(
  api: string,
  handler: (ctx: {
    messages: import('./messages.ts').AgentMessage[];
    systemPrompt?: string;
  }) => import('./messages.ts').MockTurnResult,
): void {
  const mockStream: StreamFunction = (model, context) => {
    const stream = createAssistantMessageEventStream();

    const neutralMessages = context.messages.map((m) => ({
      role: m.role as import('./messages.ts').AgentMessage['role'],
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
    }));

    const result = handler({ messages: neutralMessages, systemPrompt: context.systemPrompt });

    const piMsg = buildPiAssistantMessage(
      model.id,
      model.api,
      String(model.provider),
      result,
    );

    stream.push({ type: 'start', partial: piMsg });
    stream.push({
      type: 'done',
      reason: mapMockDoneReason(result.finishReason ?? 'stop'),
      message: piMsg,
    });

    return stream;
  };

  registerApiProvider({ api, stream: mockStream, streamSimple: mockStream });
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function buildPiModel(config: NativeProviderConfig) {
  return {
    id: config.modelId,
    name: config.modelId,
    api: config.api,
    provider: config.providerName,
    baseUrl: config.baseUrl ?? 'http://localhost:0/mock',
    reasoning: false,
    input: ['text'] as const,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8_192,
  };
}

function mapMockDoneReason(
  reason: import('./messages.ts').FinishReason,
): 'stop' | 'toolUse' | 'length' {
  const stopReason = mapFinishReasonToStopReason(reason);
  if (stopReason === 'stop' || stopReason === 'toolUse' || stopReason === 'length') {
    return stopReason;
  }
  throw new Error(`Unsupported mock provider finish reason for Pi done event: ${reason}`);
}
