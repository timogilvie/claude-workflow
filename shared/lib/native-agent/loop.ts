import { createHash } from 'node:crypto';
import {
  runAgentLoopContinue,
  type AfterToolCallResult,
  type AgentContext,
  type AgentEventSink,
  type AgentLoopConfig,
  type AgentMessage,
  type AfterToolCallContext,
  type BeforeToolCallContext,
  type ShouldStopAfterTurnContext,
} from '@earendil-works/pi-agent-core';
import type { AgentEvent } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, Model } from '@earendil-works/pi-ai';

// Re-export the Pi agent context type through the loop seam so loop callers can
// construct an AgentContext without importing Pi vendor packages directly.
export type { AgentContext } from '@earendil-works/pi-agent-core';
import { computeModelCost, type ModelPricing } from '../workflow-cost.ts';
import type { ModelRegistry } from '../model-registry.ts';
import { assertToolCompat } from './tool-compat-validator.ts';
import {
  transformContext,
  type ReplayCompactionEvent,
  type ReplayCompactionOptions,
} from './compaction.ts';
import { buildTrustMetadata } from './provenance.ts';
import { toProviderRequestModelId, type ProviderModelConfig } from './provider.ts';
import { evaluateBeforeToolCallPolicy, type ToolPolicyConfig } from './tools/policies.ts';
import { redactSecrets, redactSecretsInValue } from './tools/redaction.ts';
import type {
  OutputCapPolicy,
  ToolMetadata,
  ToolOutputCapMetadata,
  ToolPhase,
  ToolProvenanceMetadata,
  ToolRedactionMetadata,
  ToolResultMetadata,
} from './tools/types.ts';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface LoopBudget {
  maxTurns?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxTotalTokens?: number;
  maxToolCalls?: number;
  maxWallClockMs?: number;
  maxCostUsd?: number;
}

export type LoopStopReason =
  | 'stop'
  | 'turn_limit'
  | 'token_limit'
  | 'tool_call_limit'
  | 'wall_clock_limit'
  | 'cost_limit'
  | 'aborted'
  | 'error';

/**
 * Heartbeat event shape compatible with `wavemill_hook_write`.
 * Emitted via `onHeartbeat` to keep the dashboard alive during long turns.
 */
export interface HeartbeatEvent {
  state: 'working';
  event: string;
  detail?: string;
  agent: string;
}

export const HEARTBEAT_AGENT = 'native-agent';

export interface WavemillLoopConfig {
  model: ProviderModelConfig;
  /** Pi agent context (systemPrompt, messages, tools) for this run. */
  context: AgentContext;
  /**
   * Converts Pi AgentMessage[] to LLM-compatible Message[] before each turn.
   * Must not throw; return a safe fallback on errors.
   */
  convertToLlm: AgentLoopConfig['convertToLlm'];
  /**
   * Called after each tool call finishes. May override content/details/isError/terminate.
   * Receives the agent abort signal; must honour it.
   */
  afterToolCall?: AgentLoopConfig['afterToolCall'];
  /**
   * Called before each tool call. Return `{ block: true }` to prevent execution.
   * Epic 2 wires in real phase policy here; stub it out or omit in Epic 1.
   */
  beforeToolCall?: AgentLoopConfig['beforeToolCall'];
  toolPolicy?: {
    phase: ToolPhase;
    config?: ToolPolicyConfig;
    worktreePath: string;
    registry: readonly ToolMetadata[];
  };
  /** Optional prior-session state; passed as AgentContext messages and is sufficient
   *  for continuation via replayed thinkingSignature / responseId metadata. */
  priorState?: { messages: AgentMessage[] };
  budget?: LoopBudget;
  signal?: AbortSignal;
  /** Invoked on Pi progress events so the dashboard sees a live agent. */
  onHeartbeat?: (event: HeartbeatEvent) => void;
  /** Optional sink for all Pi AgentEvents. Used for transcript writing and monitoring. */
  onEvent?: (event: AgentEvent) => void;
  /** Optional replay-history compaction applied only to provider context. */
  compaction?: ReplayCompactionOptions;
  /** Receives metadata for replay compaction events emitted by transformContext. */
  onCompactionEvents?: (events: ReplayCompactionEvent[]) => void;
  /** Required when `budget.maxCostUsd` is set; used to compute turn cost. */
  modelPricing?: ModelPricing;
  /** Optional registry override for tool compatibility validation. */
  compatRegistry?: ModelRegistry;
  temperature?: number;
  maxTokens?: number;
}

export interface LoopResult {
  messages: AgentMessage[];
  stopReason: LoopStopReason;
  turnsCompleted: number;
  toolCallsExecuted: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  wallClockMs: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return JSON.stringify(value);
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + (value as unknown[]).map(stableStringify).join(',') + ']';
  }
  const sorted = Object.keys(value as Record<string, unknown>).sort();
  const pairs = sorted.map(
    (k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`,
  );
  return '{' + pairs.join(',') + '}';
}

function computeArgsFingerprint(args: unknown): string {
  const stable = stableStringify(args ?? {});
  return createHash('sha256').update(stable).digest('hex').slice(0, 16);
}

function finalAssistantStopReason(messages: AgentMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === 'assistant' && typeof message.stopReason === 'string') {
      return message.stopReason;
    }
  }
  return null;
}

function deriveOutputCapMetadata(
  policy: OutputCapPolicy | undefined,
  redactedDetails: unknown,
): ToolOutputCapMetadata {
  const d: Record<string, unknown> =
    redactedDetails !== null &&
    redactedDetails !== undefined &&
    typeof redactedDetails === 'object' &&
    !Array.isArray(redactedDetails)
      ? (redactedDetails as Record<string, unknown>)
      : {};

  const capped = d.truncated === true;
  const result: ToolOutputCapMetadata = { capped };

  if (policy && policy.strategy !== 'none') {
    result.strategy = policy.strategy;
    if (policy.maxBytes !== undefined) {
      result.limit = policy.maxBytes;
      result.limitKind = 'bytes';
      if (typeof d.originalBytes === 'number') result.originalLength = d.originalBytes;
      if (typeof d.retainedBytes === 'number') result.retainedLength = d.retainedBytes;
    } else if (policy.maxItems !== undefined) {
      result.limit = policy.maxItems;
      result.limitKind = 'items';
      if (typeof d.totalLines === 'number') result.originalLength = d.totalLines;
      if (typeof d.returnedLines === 'number') result.retainedLength = d.returnedLines;
    }
  }

  return result;
}

function toPiModel(config: ProviderModelConfig): Model<string> {
  const requestModelId = toProviderRequestModelId(config);
  return {
    id: requestModelId,
    name: config.name ?? requestModelId,
    api: config.api,
    provider: config.provider,
    baseUrl: config.baseUrl ?? 'http://localhost:0/mock',
    headers: config.headers ?? {},
    ...(config.compat !== undefined ? { compat: config.compat } : {}),
    reasoning: config.reasoning ?? false,
    input: config.input ?? ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: config.contextWindow ?? 200_000,
    maxTokens: config.maxTokens ?? 8192,
  } as unknown as Model<string>;
}

interface ComposedSignal {
  signal: AbortSignal;
  cleanup: () => void;
  isWallClockExpiry: () => boolean;
}

function composeAbortSignal(
  callerSignal: AbortSignal | undefined,
  maxWallClockMs: number | undefined,
): ComposedSignal {
  const controller = new AbortController();
  let wallClockExpired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function abort() {
    if (!controller.signal.aborted) {
      controller.abort();
    }
  }

  function cleanup() {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  }

  if (callerSignal?.aborted) {
    abort();
  } else if (callerSignal) {
    callerSignal.addEventListener('abort', abort, { once: true });
  }

  if (maxWallClockMs !== undefined) {
    timer = setTimeout(() => {
      wallClockExpired = true;
      abort();
    }, maxWallClockMs);
  }

  return { signal: controller.signal, cleanup, isWallClockExpiry: () => wallClockExpired };
}

// ---------------------------------------------------------------------------
// Main loop function
// ---------------------------------------------------------------------------

/**
 * Drive Pi's agentLoop with Wavemill-owned budget accounting, abort composition,
 * heartbeat emission, and deterministic fail-fast batch semantics.
 */
export async function runWavemillLoop(config: WavemillLoopConfig): Promise<LoopResult> {
  const { context, convertToLlm, budget, signal: callerSignal, onHeartbeat, modelPricing, temperature, maxTokens } = config;

  const startTime = Date.now();
  const composed = composeAbortSignal(callerSignal, budget?.maxWallClockMs);

  // Build a name→metadata map for quick lookup inside afterToolCall.
  const toolMetadataByName = new Map<string, ToolMetadata>(
    (config.toolPolicy?.registry ?? []).map((m) => [m.name, m]),
  );

  if (composed.signal.aborted) {
    composed.cleanup();
    return {
      messages: [],
      stopReason: 'aborted',
      turnsCompleted: 0,
      toolCallsExecuted: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCostUsd: 0,
      wallClockMs: 0,
    };
  }

  let turnsCompleted = 0;
  let toolCallsExecuted = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCostUsd = 0;
  let budgetStopReason: LoopStopReason | undefined;

  // Per-turn batch failure tracking for fail-fast semantics.
  // Key: the Pi AssistantMessage object for the current turn.
  const batchFailed = new WeakMap<AssistantMessage, boolean>();
  // Tool call ids that were skipped by beforeToolCall (not real failures).
  const skippedCallIds = new Set<string>();

  const toolsForCompat = config.toolPolicy?.registry.length
    ? config.toolPolicy.registry
    : (context.tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description ?? tool.name,
      executionMode: tool.executionMode ?? 'sequential',
    }));

  if (toolsForCompat.length > 0 && isNativeCompatProvider(config.model.provider)) {
    // Native providers must always be validated. Unknown transports throw via
    // `assertToolCompat`'s transport-capability lookup, so adding a new transport
    // to `ProviderModelConfig` cannot silently bypass the fail-fast gate.
    assertToolCompat({
      model: resolveRegistryModelId(config.model),
      provider: config.model.provider as 'openai' | 'openrouter',
      transport: config.model.api,
      tools: toolsForCompat,
      registry: config.compatRegistry,
    });
  }

  const piConfig: AgentLoopConfig = {
    model: toPiModel(config.model),
    convertToLlm,
    temperature,
    maxTokens,

    shouldStopAfterTurn: async (ctx: ShouldStopAfterTurnContext) => {
      const msg = ctx.message as AssistantMessage;
      const usage = msg.usage;
      if (usage) {
        const input = usage.input ?? 0;
        const output = usage.output ?? 0;
        const cacheWrite = usage.cacheWrite ?? 0;
        const cacheRead = usage.cacheRead ?? 0;
        totalInputTokens += input;
        totalOutputTokens += output;
        if (modelPricing) {
          totalCostUsd += computeModelCost(
            { inputTokens: input, outputTokens: output, cacheCreationTokens: cacheWrite, cacheReadTokens: cacheRead },
            modelPricing,
          );
        }
      }
      turnsCompleted++;

      // Evaluate budget limits in deterministic order.
      if (budget?.maxTurns !== undefined && turnsCompleted >= budget.maxTurns) {
        budgetStopReason = 'turn_limit';
        return true;
      }
      if (budget?.maxInputTokens !== undefined && totalInputTokens >= budget.maxInputTokens) {
        budgetStopReason = 'token_limit';
        return true;
      }
      if (budget?.maxOutputTokens !== undefined && totalOutputTokens >= budget.maxOutputTokens) {
        budgetStopReason = 'token_limit';
        return true;
      }
      if (
        budget?.maxTotalTokens !== undefined &&
        totalInputTokens + totalOutputTokens >= budget.maxTotalTokens
      ) {
        budgetStopReason = 'token_limit';
        return true;
      }
      if (budget?.maxToolCalls !== undefined && toolCallsExecuted >= budget.maxToolCalls) {
        budgetStopReason = 'tool_call_limit';
        return true;
      }
      if (budget?.maxCostUsd !== undefined && totalCostUsd >= budget.maxCostUsd) {
        budgetStopReason = 'cost_limit';
        return true;
      }
      // Gracefully exit if the abort signal fired during this turn (e.g. wall-clock or caller cancel).
      if (composed.signal.aborted) {
        return true;
      }
      return false;
    },

    beforeToolCall: async (ctx: BeforeToolCallContext, signal?: AbortSignal) => {
      // Fail-fast: skip subsequent calls once the batch has a failure.
      if (batchFailed.get(ctx.assistantMessage)) {
        skippedCallIds.add(ctx.toolCall.id);
        return { block: true, reason: 'skipped_after_failure' };
      }
      if (config.toolPolicy) {
        const decision = evaluateBeforeToolCallPolicy({
          ...config.toolPolicy,
          toolCall: {
            name: ctx.toolCall.name,
            arguments: ctx.args as Record<string, unknown>,
          },
        });
        if (decision.kind === 'deny') {
          return { block: true, reason: decision.message };
        }
      }
      // Caller-supplied policy (Epic 2). Pass-through stub in Epic 1.
      if (config.beforeToolCall) {
        return config.beforeToolCall(ctx, signal);
      }
      return undefined;
    },

    afterToolCall: async (ctx: AfterToolCallContext, signal?: AbortSignal) => {
      const isSkipped = skippedCallIds.has(ctx.toolCall.id);
      skippedCallIds.delete(ctx.toolCall.id);

      if (!isSkipped) {
        toolCallsExecuted++;
        // A real failure marks the batch so subsequent calls are skipped.
        if (ctx.isError) {
          batchFailed.set(ctx.assistantMessage, true);
        }
      }

      // Run caller override first so gitAfterToolCall etc. can adjust isError/details.
      let callerOverride: AfterToolCallResult | undefined;
      if (config.afterToolCall) {
        callerOverride = await config.afterToolCall(ctx, signal);
      }

      // Compute effective content and details after caller override.
      type ContentBlock = { type: string; text: string };
      const baseResult = ctx.result as { content?: ContentBlock[]; details?: unknown } | null | undefined;
      const existingMetadata = (
        ctx.result &&
        typeof ctx.result === 'object' &&
        'metadata' in ctx.result
      )
        ? (ctx.result as { metadata?: ToolResultMetadata }).metadata
        : undefined;
      const effectiveContent = ((callerOverride?.content ?? baseResult?.content ?? []) as ContentBlock[]);
      const effectiveDetails: unknown =
        callerOverride?.details !== undefined ? callerOverride.details : baseResult?.details;

      // Redact content text blocks before Pi appends them to replay context.
      let contentMatchCount = 0;
      let contentRedacted = false;
      const contentCategories: string[] = [];
      const redactedContent = effectiveContent.map((block) => {
        if (block.type === 'text') {
          const r = redactSecrets(block.text);
          if (r.redacted) {
            contentRedacted = true;
            contentMatchCount += r.matchCount;
            for (const c of r.categories) contentCategories.push(c);
          }
          return { type: 'text' as const, text: r.text };
        }
        return block;
      });

      // Redact details value tree.
      const detailsResult =
        effectiveDetails !== undefined && effectiveDetails !== null
          ? redactSecretsInValue(effectiveDetails)
          : { value: effectiveDetails, redacted: false, matchCount: 0, categories: [] as string[] };

      // Build provenance fingerprint.
      const provenance: ToolProvenanceMetadata = {
        tool: ctx.toolCall.name,
        argsFingerprint: computeArgsFingerprint(ctx.args),
      };

      // Derive output cap metadata from policy + actual truncation fields.
      const toolMeta = toolMetadataByName.get(ctx.toolCall.name);
      const outputCap = deriveOutputCapMetadata(toolMeta?.outputCapPolicy, detailsResult.value);

      // Aggregate redaction status.
      const allCategories = [...new Set([...contentCategories, ...detailsResult.categories])];
      const redaction: ToolRedactionMetadata = {
        redacted: contentRedacted || detailsResult.redacted,
        matchCount: contentMatchCount + detailsResult.matchCount,
        categories: allCategories,
      };

      const trust = buildTrustMetadata({
        sourceKind: existingMetadata?.trust?.sourceKind,
        content: redactedContent,
        details: detailsResult.value,
      });

      const metadata: ToolResultMetadata = {
        ...existingMetadata,
        provenance,
        outputCap,
        redaction,
        trust,
      };

      // Embed __wavemill metadata in details (plain-object only; transcript extracts it).
      const baseDetails = detailsResult.value;
      const enrichedDetails: unknown =
        baseDetails !== null &&
        baseDetails !== undefined &&
        typeof baseDetails === 'object' &&
        !Array.isArray(baseDetails)
          ? { ...(baseDetails as Record<string, unknown>), __wavemill: metadata }
          : baseDetails === undefined
            ? { __wavemill: metadata }
            : baseDetails;

      const override: AfterToolCallResult = {
        ...(callerOverride?.isError !== undefined ? { isError: callerOverride.isError } : {}),
        ...(callerOverride?.terminate !== undefined ? { terminate: callerOverride.terminate } : {}),
        content: redactedContent as AfterToolCallResult['content'],
        details: enrichedDetails,
      };
      (override as AfterToolCallResult & { metadata?: ToolResultMetadata }).metadata = metadata;

      return override;
    },
  };

  if (config.compaction) {
    piConfig.transformContext = async (messages: AgentMessage[]) => {
      const result = transformContext(messages, config.compaction!);
      if (result.events.length > 0) {
        try {
          config.onCompactionEvents?.(result.events);
        } catch {
          // Compaction event sinks are diagnostic; replay compaction should not
          // fail an otherwise valid provider request.
        }
      }
      return result.messages;
    };
  }

  let finalMessages: AgentMessage[] = [];
  let loopError: unknown;

  const emit: AgentEventSink = (event) => {
    config.onEvent?.(event);
    switch (event.type) {
      case 'turn_start':
        onHeartbeat?.({ state: 'working', event: 'turn_start', agent: HEARTBEAT_AGENT });
        break;
      case 'message_update':
        onHeartbeat?.({ state: 'working', event: 'message_update', agent: HEARTBEAT_AGENT });
        break;
      case 'tool_execution_start':
        onHeartbeat?.({
          state: 'working',
          event: 'tool_execution_start',
          detail: event.toolName,
          agent: HEARTBEAT_AGENT,
        });
        break;
      case 'agent_end':
        finalMessages = event.messages;
        break;
      default:
        break;
    }
  };

  try {
    finalMessages = await runAgentLoopContinue(context, piConfig, emit, composed.signal);
  } catch (err) {
    loopError = err;
  } finally {
    composed.cleanup();
  }

  const wallClockMs = Date.now() - startTime;

  let stopReason: LoopStopReason;
  const finalStopReason = finalAssistantStopReason(finalMessages);
  if (composed.signal.aborted && (loopError || !budgetStopReason)) {
    // Abort takes precedence over a loop error since the error may be caused by the abort.
    stopReason = composed.isWallClockExpiry() ? 'wall_clock_limit' : 'aborted';
  } else if (loopError) {
    stopReason = 'error';
  } else if (finalStopReason === 'error') {
    stopReason = 'error';
  } else if (finalStopReason === 'aborted') {
    stopReason = composed.isWallClockExpiry() ? 'wall_clock_limit' : 'aborted';
  } else if (finalStopReason === 'stop' && budgetStopReason === 'turn_limit') {
    stopReason = 'stop';
  } else if (budgetStopReason) {
    stopReason = budgetStopReason;
  } else if (composed.signal.aborted) {
    stopReason = composed.isWallClockExpiry() ? 'wall_clock_limit' : 'aborted';
  } else {
    stopReason = 'stop';
  }

  return {
    messages: finalMessages,
    stopReason,
    turnsCompleted,
    toolCallsExecuted,
    totalInputTokens,
    totalOutputTokens,
    totalCostUsd,
    wallClockMs,
  };
}

function resolveRegistryModelId(model: ProviderModelConfig): string {
  if (model.name && model.name.trim().length > 0) {
    return model.name.trim();
  }

  const separator = model.id.indexOf(':');
  return separator === -1 ? model.id : model.id.slice(separator + 1);
}

function isNativeCompatProvider(provider: string): boolean {
  return provider === 'openai' || provider === 'openrouter';
}
