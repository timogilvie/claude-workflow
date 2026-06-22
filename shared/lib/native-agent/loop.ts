import {
  runAgentLoopContinue,
  type AgentContext,
  type AgentEvent,
  type AgentEventSink,
  type AgentLoopConfig,
  type AgentMessage,
  type AfterToolCallContext,
  type BeforeToolCallContext,
  type ShouldStopAfterTurnContext,
} from '@earendil-works/pi-agent-core';
import type { AssistantMessage, Model } from '@earendil-works/pi-ai';
import { computeModelCost, type ModelPricing } from '../workflow-cost.ts';
import {
  transformContext,
  type ReplayCompactionEvent,
  type ReplayCompactionOptions,
} from './compaction.ts';
import type { ProviderModelConfig } from './provider.ts';
import { evaluateBeforeToolCallPolicy, type ToolPolicyConfig } from './tools/policies.ts';
import type { ToolMetadata, ToolPhase } from './tools/types.ts';

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
  /** Optional replay-history compaction applied only to provider context. */
  compaction?: ReplayCompactionOptions;
  /** Receives metadata for replay compaction events emitted by transformContext. */
  onCompactionEvents?: (events: ReplayCompactionEvent[]) => void;
  /**
   * Optional sink that receives every Pi AgentEvent before the loop's own
   * handling. Use to wire a TranscriptWriter or other event observer without
   * modifying the loop internals.
   */
  eventSink?: (event: AgentEvent) => void;
  /** Required when `budget.maxCostUsd` is set; used to compute turn cost. */
  modelPricing?: ModelPricing;
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

function toPiModel(config: ProviderModelConfig): Model<string> {
  return {
    id: config.id,
    name: config.name ?? config.id,
    api: config.api,
    provider: config.provider,
    baseUrl: config.baseUrl ?? 'http://localhost:0/mock',
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
  const { context, convertToLlm, budget, signal: callerSignal, onHeartbeat, modelPricing, temperature, maxTokens, eventSink } = config;

  const startTime = Date.now();
  const composed = composeAbortSignal(callerSignal, budget?.maxWallClockMs);

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

      if (config.afterToolCall) {
        return config.afterToolCall(ctx, signal);
      }
      return undefined;
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
    // Forward to optional external event sink first (e.g. TranscriptWriter).
    eventSink?.(event);

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
  if (composed.signal.aborted && (loopError || !budgetStopReason)) {
    // Abort takes precedence over a loop error since the error may be caused by the abort.
    stopReason = composed.isWallClockExpiry() ? 'wall_clock_limit' : 'aborted';
  } else if (loopError) {
    stopReason = 'error';
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
