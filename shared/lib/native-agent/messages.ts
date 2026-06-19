/**
 * Translation boundary between Pi-ai internal types and neutral Wavemill types.
 *
 * All Pi imports are confined to this file and provider.ts.
 * External callers must never see Pi types in any exported signature.
 *
 * @module native-agent/messages
 */

import type {
  AssistantMessage,
  Context,
  Message,
  TextContent,
  ToolCall,
  Usage,
} from '@earendil-works/pi-ai';
import type { SessionModelUsage } from '../session-adapters.ts';

// ─── Neutral public types ────────────────────────────────────────────────────

/** Role-tagged message for provider input. */
export interface AgentMessage {
  role: 'system' | 'user' | 'assistant' | 'toolResult';
  /** Plain-text content. Complex content (images, multi-part) is out of scope here. */
  content: string;
}

/** Neutral tool definition (schema is provider-agnostic JSON Schema object). */
export interface AgentToolSchema {
  name: string;
  description: string;
  schema: unknown;
}

/** Neutral tool call extracted from an assistant turn. */
export interface NativeToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** Normalized finish reason, independent of Pi's StopReason enum. */
export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'error' | 'aborted' | 'unknown';

/** Streaming event emitted during a provider turn (reserved for future use). */
export type ProviderTurnEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_call'; toolCall: NativeToolCall };

/** Optional continuation state returned by a provider turn. */
export interface ProviderConversationState {
  raw: unknown;
}

/** Input to a single provider turn. */
export interface ProviderTurnInput {
  systemPrompt?: string;
  messages: AgentMessage[];
  tools?: AgentToolSchema[];
  signal?: AbortSignal;
  temperature?: number;
  maxTokens?: number;
  metadata?: Record<string, unknown>;
  onEvent?: (event: ProviderTurnEvent) => void;
}

/** Neutral result of a single provider turn. */
export interface ProviderTurnResult {
  /** Turn identifier (from provider response or generated). */
  id: string;
  /** Provider name string (e.g. "hokusai", "anthropic"). */
  provider: string;
  /** Model identifier string (e.g. "claude-sonnet-4-6"). */
  model: string;
  /** Concatenated text from all text content blocks. */
  text: string;
  /** Tool calls requested by the assistant (empty if none). */
  toolCalls: NativeToolCall[];
  /** Normalized finish reason. */
  finishReason: FinishReason;
  /** Mapped token usage (Pi cost stays in raw only). */
  usage?: SessionModelUsage;
  /** Optional state for multi-turn continuation. */
  nextState?: ProviderConversationState;
  /** Raw provider response for debugging; type is intentionally unknown. */
  raw: unknown;
}

/** Usage shape used by the mock substrate (matches Pi field names). */
export interface MockTurnUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** Return value from a mock provider handler. */
export interface MockTurnResult {
  text?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  /** Usage in Pi field names so the mapping can be verified in tests. */
  usage?: MockTurnUsage;
  finishReason?: FinishReason;
  /** Override the model id reported in the result. */
  modelId?: string;
  /** Override the provider name reported in the result. */
  providerName?: string;
}

// ─── Usage mapping ───────────────────────────────────────────────────────────

/**
 * Maps Pi `Usage` to the neutral `SessionModelUsage` shape.
 *
 * - `input`     -> `inputTokens`
 * - `output`    -> `outputTokens`
 * - `cacheRead` -> `cacheReadTokens`
 * - `cacheWrite`-> `cacheCreationTokens`
 *
 * Missing fields default to 0. `undefined` usage produces all-zero result.
 * Negative values pass through unchanged (validation is not part of this seam).
 * Pi's `cost` field is not mapped; it stays inside `raw` only.
 */
export function mapPiUsageToSessionModelUsage(usage: Usage | undefined): SessionModelUsage {
  if (usage === undefined) {
    return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  }
  return {
    inputTokens: usage.input ?? 0,
    outputTokens: usage.output ?? 0,
    cacheReadTokens: usage.cacheRead ?? 0,
    cacheCreationTokens: usage.cacheWrite ?? 0,
  };
}

// ─── Message conversion ──────────────────────────────────────────────────────

/** Converts neutral input into a Pi `Context`. Tools are passed through as-is (cast). */
export function buildPiContext(input: ProviderTurnInput): Context {
  const now = Date.now();
  const messages: Message[] = input.messages
    .filter((m) => m.role !== 'system')
    .map((m) => convertNeutralMessage(m, now));

  return {
    systemPrompt: input.systemPrompt,
    messages,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tools: input.tools?.map((t) => ({ name: t.name, description: t.description, parameters: t.schema as any })),
  };
}

function convertNeutralMessage(msg: AgentMessage, timestamp: number): Message {
  if (msg.role === 'user') {
    return { role: 'user', content: msg.content, timestamp };
  }
  // assistant and toolResult roles are not needed for a simple single-turn seam
  return { role: 'user', content: msg.content, timestamp };
}

// ─── Result normalization ─────────────────────────────────────────────────────

/** Maps a Pi `AssistantMessage` to a neutral `ProviderTurnResult`. */
export function mapAssistantMessage(msg: AssistantMessage): ProviderTurnResult {
  const text = msg.content
    .filter((c): c is TextContent => c.type === 'text')
    .map((c) => c.text)
    .join('');

  const toolCalls: NativeToolCall[] = msg.content
    .filter((c): c is ToolCall => c.type === 'toolCall')
    .map((c) => ({ id: c.id, name: c.name, arguments: c.arguments as Record<string, unknown> }));

  return {
    id: msg.responseId ?? generateId(),
    provider: String(msg.provider),
    model: msg.model,
    text,
    toolCalls,
    finishReason: mapStopReason(msg.stopReason),
    usage: mapPiUsageToSessionModelUsage(msg.usage),
    raw: msg,
  };
}

/** Builds a Pi `AssistantMessage` from a neutral `MockTurnResult` and Pi model metadata. */
export function buildPiAssistantMessage(
  modelId: string,
  api: string,
  providerName: string,
  result: MockTurnResult,
): AssistantMessage {
  const content: AssistantMessage['content'] = [];

  if (result.text) {
    content.push({ type: 'text', text: result.text });
  }

  for (const tc of result.toolCalls ?? []) {
    content.push({
      type: 'toolCall',
      id: tc.id,
      name: tc.name,
      arguments: tc.arguments,
    });
  }

  const u = result.usage ?? {};
  const input = u.input ?? 0;
  const output = u.output ?? 0;
  const cacheRead = u.cacheRead ?? 0;
  const cacheWrite = u.cacheWrite ?? 0;

  const piUsage: Usage = {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };

  const stopReason = mapFinishReasonToStopReason(result.finishReason ?? 'stop');

  return {
    role: 'assistant',
    content,
    api,
    provider: result.providerName ?? providerName,
    model: result.modelId ?? modelId,
    usage: piUsage,
    stopReason,
    timestamp: Date.now(),
  };
}

function mapStopReason(reason: string): FinishReason {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'toolUse':
      return 'tool_calls';
    case 'length':
      return 'length';
    case 'error':
      return 'error';
    case 'aborted':
      return 'aborted';
    default:
      return 'unknown';
  }
}

/** Maps neutral FinishReason back to a Pi stop reason string. */
export function mapFinishReasonToStopReason(reason: FinishReason): 'stop' | 'toolUse' | 'length' | 'error' | 'aborted' {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'tool_calls':
      return 'toolUse';
    case 'length':
      return 'length';
    case 'error':
      return 'error';
    case 'aborted':
      return 'aborted';
    default:
      return 'stop';
  }
}

function generateId(): string {
  return `turn-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}
