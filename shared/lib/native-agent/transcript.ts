/**
 * Append-only JSONL transcript writer and NativeAgentEvent derivation.
 *
 * Derives transcript-level `TranscriptEvent`s from Pi's `AgentEvent` stream and
 * writes them to an append-only JSONL file. Redaction runs before serialization.
 *
 * ## Raw history vs replay history
 *
 * `assistant_message` events carry two projections of the same content:
 *
 * - `rawContent`: all content blocks (text, thinking, tool_call) with the
 *   provider-level `raw` payload stripped. Use for debugging and auditing.
 * - `replayContent`: thinking blocks removed; only text and tool_call blocks
 *   remain. Use for context reconstruction in future resume/compaction work.
 *
 * Later epics that compact sessions for replay should consume `replayContent`
 * directly rather than re-deriving it from `rawContent`.
 *
 * ## Redaction
 *
 * Redaction runs before any event is serialized. The default policy:
 * - Strips raw provider payloads from assistant content.
 * - Masks common secret-bearing keys in tool result details
 *   (`authorization`, `apiKey`, `token`, `secret`, `password`, `key`).
 * - Preserves tool result text content so downstream debugging remains possible.
 *
 * Pass a custom `redact` function to `TranscriptWriterOptions` to override the
 * policy for a specific integration without changing transcript code.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { AgentEvent } from '@earendil-works/pi-agent-core';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { ReplayCompactionEvent } from './compaction.ts';
import { redactString, redactPayload } from './tools/redaction.ts';

// ---------------------------------------------------------------------------
// Transcript event types
// (distinct from provider-turn NativeAgentEvent in messages.ts)
// ---------------------------------------------------------------------------

interface TranscriptEventBase {
  seq: number;
  sessionId: string;
  timestamp: number;
}

export interface TranscriptSessionStarted extends TranscriptEventBase {
  type: 'session_started';
  model: string;
  api: string;
  provider: string;
}

export interface TranscriptTurnStarted extends TranscriptEventBase {
  type: 'turn_started';
  turnIndex: number;
}

export interface TranscriptTurnEnded extends TranscriptEventBase {
  type: 'turn_ended';
  turnIndex: number;
  stopReason: string;
  toolResultCount: number;
}

export type TranscriptRawContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; thinkingSignature?: string; redacted?: boolean }
  | { type: 'tool_call'; id: string; name: string; arguments: Record<string, unknown> };

export type TranscriptReplayContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; arguments: Record<string, unknown> };

export interface TranscriptUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

export interface TranscriptAssistantMessage extends TranscriptEventBase {
  type: 'assistant_message';
  model: string;
  responseModel?: string;
  responseId?: string;
  stopReason: string;
  usage?: TranscriptUsage;
  /** Raw history: all content blocks, provider payload stripped. */
  rawContent: TranscriptRawContentBlock[];
  /** Replay history: thinking removed, compact for context reconstruction. */
  replayContent: TranscriptReplayContentBlock[];
  redacted: boolean;
}

export interface TranscriptToolStarted extends TranscriptEventBase {
  type: 'tool_started';
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface TranscriptToolResult extends TranscriptEventBase {
  type: 'tool_result';
  toolCallId: string;
  toolName: string;
  isError: boolean;
  /** First text line of the result, redacted. */
  content: string;
  /** Redacted structured details, if present. */
  details?: unknown;
  redacted: boolean;
}

export interface TranscriptCompactionEvent extends TranscriptEventBase, ReplayCompactionEvent {}

export interface TranscriptSessionEnded extends TranscriptEventBase {
  type: 'session_ended';
  messageCount: number;
}

export type TranscriptEvent =
  | TranscriptSessionStarted
  | TranscriptTurnStarted
  | TranscriptTurnEnded
  | TranscriptAssistantMessage
  | TranscriptToolStarted
  | TranscriptToolResult
  | TranscriptCompactionEvent
  | TranscriptSessionEnded;

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/**
 * Default redaction function.
 *
 * Delegates to `redactPayload` from the native-agent redaction module, which
 * combines key-name-based value replacement (authorization, token, secret,
 * etc.) with pattern-based string redaction (Bearer tokens, AWS keys,
 * sk-… tokens, inline assignment forms).
 *
 * Replace the `redact` option on TranscriptWriterOptions to override.
 */
export function defaultRedact(value: unknown): unknown {
  return redactPayload(value);
}

// ---------------------------------------------------------------------------
// Content extraction
// ---------------------------------------------------------------------------

function extractRawContent(message: AssistantMessage): TranscriptRawContentBlock[] {
  const blocks: TranscriptRawContentBlock[] = [];
  for (const block of message.content) {
    if (block.type === 'text') {
      blocks.push({ type: 'text', text: block.text });
    } else if (block.type === 'thinking') {
      const tb: TranscriptRawContentBlock & { type: 'thinking' } = {
        type: 'thinking',
        thinking: block.thinking,
      };
      if (block.thinkingSignature !== undefined) tb.thinkingSignature = block.thinkingSignature;
      if (block.redacted !== undefined) tb.redacted = block.redacted;
      blocks.push(tb);
    } else if (block.type === 'toolCall') {
      blocks.push({
        type: 'tool_call',
        id: block.id,
        name: block.name,
        arguments: block.arguments as Record<string, unknown>,
      });
    }
  }
  return blocks;
}

function extractReplayContent(message: AssistantMessage): TranscriptReplayContentBlock[] {
  const blocks: TranscriptReplayContentBlock[] = [];
  for (const block of message.content) {
    if (block.type === 'text') {
      blocks.push({ type: 'text', text: block.text });
    } else if (block.type === 'toolCall') {
      blocks.push({
        type: 'tool_call',
        id: block.id,
        name: block.name,
        arguments: block.arguments as Record<string, unknown>,
      });
    }
    // thinking blocks are intentionally omitted from replay content
  }
  return blocks;
}

/** Apply redaction to text/thinking blocks in raw content. Does not mutate input. */
function redactRawContent(
  blocks: TranscriptRawContentBlock[],
  redactFn: RedactFn,
): TranscriptRawContentBlock[] {
  return blocks.map((block) => {
    if (block.type === 'text') {
      const redacted = redactFn(block.text);
      return { ...block, text: typeof redacted === 'string' ? redacted : block.text };
    }
    if (block.type === 'thinking') {
      const redacted = redactFn(block.thinking);
      return { ...block, thinking: typeof redacted === 'string' ? redacted : block.thinking };
    }
    if (block.type === 'tool_call') {
      const redactedArgs = redactFn(block.arguments);
      return {
        ...block,
        arguments: typeof redactedArgs === 'object' && redactedArgs !== null
          ? (redactedArgs as Record<string, unknown>)
          : block.arguments,
      };
    }
    return block;
  });
}

/** Apply redaction to text blocks and tool-call arguments in replay content. Does not mutate input. */
function redactReplayContent(
  blocks: TranscriptReplayContentBlock[],
  redactFn: RedactFn,
): TranscriptReplayContentBlock[] {
  return blocks.map((block) => {
    if (block.type === 'text') {
      const redacted = redactFn(block.text);
      return { ...block, text: typeof redacted === 'string' ? redacted : block.text };
    }
    if (block.type === 'tool_call') {
      const redactedArgs = redactFn(block.arguments);
      return {
        ...block,
        arguments: typeof redactedArgs === 'object' && redactedArgs !== null
          ? (redactedArgs as Record<string, unknown>)
          : block.arguments,
      };
    }
    return block;
  });
}

function extractUsage(message: AssistantMessage): TranscriptUsage | undefined {
  const u = message.usage;
  if (!u) return undefined;
  const usage: TranscriptUsage = {
    input: u.input ?? 0,
    output: u.output ?? 0,
    cacheRead: u.cacheRead ?? 0,
    cacheWrite: u.cacheWrite ?? 0,
    totalTokens: u.totalTokens ?? 0,
  };
  if (u.cost) {
    usage.cost = {
      input: u.cost.input,
      output: u.cost.output,
      cacheRead: u.cost.cacheRead,
      cacheWrite: u.cost.cacheWrite,
      total: u.cost.total,
    };
  }
  return usage;
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

/** Pluggable redaction function. Receives an arbitrary value and returns a redacted copy. */
export type RedactFn = (value: unknown) => unknown;

export interface TranscriptWriterOptions {
  /** Session identifier written to every event. */
  sessionId: string;
  /** Initial model identifier (from AgentLoopConfig). Individual message events carry the actual model used. */
  model: string;
  api: string;
  provider: string;
  /** Absolute path to the JSONL transcript file. Parent directory is created if needed. */
  path: string;
  /** Override to pin timestamps in tests. Defaults to Date.now. */
  clock?: () => number;
  /** Override to apply a custom redaction policy. Defaults to defaultRedact. */
  redact?: RedactFn;
}

/**
 * Append-only JSONL transcript writer.
 *
 * Call `handleEvent(piEvent)` for every event from the Pi `agentLoop` stream.
 * Derived `TranscriptEvent`s are redacted and appended to the JSONL file one
 * line at a time. Returns the derived event (or null for skipped events) so
 * callers can inspect events without re-reading the file.
 */
export class TranscriptWriter {
  private seq = 0;
  private turnIndex = 0;
  private readonly options: TranscriptWriterOptions;
  private readonly redactFn: RedactFn;
  private readonly clockFn: () => number;

  constructor(options: TranscriptWriterOptions) {
    this.options = options;
    this.redactFn = options.redact ?? defaultRedact;
    this.clockFn = options.clock ?? (() => Date.now());
    mkdirSync(dirname(options.path), { recursive: true });
  }

  /** Derive and write a transcript event. Returns null for skipped Pi events. */
  handleEvent(event: AgentEvent): TranscriptEvent | null {
    const derived = this.derive(event);
    if (derived !== null) {
      this.append(derived);
    }
    return derived;
  }

  /**
   * Write a pre-built transcript event directly. Useful for error or sentinel
   * events that are not derived from a Pi AgentEvent.
   */
  write(event: TranscriptEvent): void {
    this.append(event);
  }

  writeCompactionEvent(event: ReplayCompactionEvent): TranscriptCompactionEvent {
    const transcriptEvent: TranscriptCompactionEvent = {
      ...this.base(),
      ...event,
    };
    this.append(transcriptEvent);
    return transcriptEvent;
  }

  private nextSeq(): number {
    return this.seq++;
  }

  private base(): TranscriptEventBase {
    return {
      seq: this.nextSeq(),
      sessionId: this.options.sessionId,
      timestamp: this.clockFn(),
    };
  }

  private derive(event: AgentEvent): TranscriptEvent | null {
    switch (event.type) {
      case 'agent_start':
        return {
          ...this.base(),
          type: 'session_started',
          model: this.options.model,
          api: this.options.api,
          provider: this.options.provider,
        } satisfies TranscriptSessionStarted;

      case 'turn_start':
        return {
          ...this.base(),
          type: 'turn_started',
          turnIndex: this.turnIndex,
        } satisfies TranscriptTurnStarted;

      case 'turn_end': {
        const assistantMsg = event.message as AssistantMessage;
        const stopReason = (typeof assistantMsg?.stopReason === 'string')
          ? assistantMsg.stopReason
          : 'unknown';
        const result: TranscriptTurnEnded = {
          ...this.base(),
          type: 'turn_ended',
          turnIndex: this.turnIndex,
          stopReason,
          toolResultCount: event.toolResults.length,
        };
        this.turnIndex++;
        return result;
      }

      case 'message_end': {
        const msg = event.message;
        if ((msg as { role?: string }).role !== 'assistant') return null;
        const assistantMsg = msg as AssistantMessage;
        const rawContent = redactRawContent(extractRawContent(assistantMsg), this.redactFn);
        const replayContent = redactReplayContent(extractReplayContent(assistantMsg), this.redactFn);
        const usage = extractUsage(assistantMsg);
        const result: TranscriptAssistantMessage = {
          ...this.base(),
          type: 'assistant_message',
          model: assistantMsg.model,
          stopReason: assistantMsg.stopReason,
          rawContent,
          replayContent,
          redacted: true,
          ...(usage !== undefined && { usage }),
        };
        if (assistantMsg.responseModel !== undefined) result.responseModel = assistantMsg.responseModel;
        if (assistantMsg.responseId !== undefined) result.responseId = assistantMsg.responseId;
        return result;
      }

      case 'tool_execution_start':
        return {
          ...this.base(),
          type: 'tool_started',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args as Record<string, unknown>,
        } satisfies TranscriptToolStarted;

      case 'tool_execution_end': {
        const resultObj = event.result as {
          content?: Array<{ type?: string; text?: string }>;
          details?: unknown;
        } | null | undefined;
        const rawFirstText = resultObj?.content?.find((c) => c?.type === 'text')?.text ?? '';
        // Redact content text using pattern-based string redaction.
        const { text: redactedFirstText, applied: contentRedacted } = redactString(rawFirstText);
        const originalDetails = resultObj?.details;
        const redactedDetails = originalDetails !== undefined
          ? this.redactFn(originalDetails)
          : undefined;
        const detailsRedacted = redactedDetails !== undefined && !isDeepStrictEqual(redactedDetails, originalDetails);
        const toolResult: TranscriptToolResult = {
          ...this.base(),
          type: 'tool_result',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          isError: event.isError,
          content: redactedFirstText,
          redacted: contentRedacted || detailsRedacted,
        };
        if (redactedDetails !== undefined) toolResult.details = redactedDetails;
        return toolResult;
      }

      case 'agent_end':
        return {
          ...this.base(),
          type: 'session_ended',
          messageCount: event.messages.length,
        } satisfies TranscriptSessionEnded;

      // Intentionally skipped: message_start, message_update, tool_execution_update
      default:
        return null;
    }
  }

  /**
   * Apply a final redaction pass before serialization.
   *
   * Events that came through `derive()` are already partially redacted
   * (details via redactFn, content text via redactString). This method
   * provides a fail-closed guarantee for events written via `write()` that
   * bypass derivation. Double-redaction is idempotent for [REDACTED] values.
   */
  private sanitizeEvent(event: TranscriptEvent): TranscriptEvent {
    if (event.type === 'tool_result') {
      const redactedContent = redactString(event.content).text;
      const originalDetails = event.details;
      const redactedDetails = originalDetails !== undefined
        ? this.redactFn(originalDetails)
        : undefined;
      const changed =
        redactedContent !== event.content ||
        (redactedDetails !== undefined && !isDeepStrictEqual(redactedDetails, originalDetails));
      return {
        ...event,
        content: redactedContent,
        ...(redactedDetails !== undefined && { details: redactedDetails }),
        redacted: event.redacted || changed,
      };
    }
    if (event.type === 'assistant_message') {
      return {
        ...event,
        rawContent: redactRawContent(event.rawContent, this.redactFn),
        replayContent: redactReplayContent(event.replayContent, this.redactFn),
      };
    }
    return event;
  }

  private append(event: TranscriptEvent): void {
    const sanitized = this.sanitizeEvent(event);
    appendFileSync(this.options.path, JSON.stringify(sanitized) + '\n', 'utf-8');
  }
}

// ---------------------------------------------------------------------------
// Pure derivation (stateless, for testing or batch processing)
// ---------------------------------------------------------------------------

/**
 * Derive all transcript events from a sequence of Pi AgentEvents without writing to disk.
 *
 * @param events - Full ordered sequence from one agentLoop run.
 * @param opts - Session metadata and optional overrides.
 * @returns Ordered array of derived TranscriptEvents (skipped Pi events omitted).
 */
export function deriveTranscriptEvents(
  events: AgentEvent[],
  opts: Omit<TranscriptWriterOptions, 'path'>,
): TranscriptEvent[] {
  const writer = new TranscriptWriter({
    ...opts,
    path: '/dev/null',
  });
  const result: TranscriptEvent[] = [];
  for (const ev of events) {
    const derived = writer.handleEvent(ev);
    if (derived !== null) result.push(derived);
  }
  return result;
}

// ---------------------------------------------------------------------------
// JSONL parse utilities
// ---------------------------------------------------------------------------

export class TranscriptParseError extends Error {
  readonly line: string;
  readonly lineNumber: number;

  constructor(message: string, line: string, lineNumber: number) {
    super(message);
    this.name = 'TranscriptParseError';
    this.line = line;
    this.lineNumber = lineNumber;
  }
}

/**
 * Parse a session JSONL string into typed TranscriptEvent records.
 *
 * Fails fast on malformed lines — throws `TranscriptParseError` on the first
 * line that cannot be parsed as JSON. Blank lines are skipped.
 */
export function parseTranscriptJsonl(content: string): TranscriptEvent[] {
  const lines = content.split('\n');
  const events: TranscriptEvent[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new TranscriptParseError(
        `Malformed JSONL at line ${i + 1}: ${line.slice(0, 80)}`,
        line,
        i + 1,
      );
    }
    events.push(parsed as TranscriptEvent);
  }
  return events;
}

/**
 * Extract replay-safe history from a parsed transcript.
 *
 * Returns only the `replayContent` from each `assistant_message` event, in order.
 * Suitable for reconstructing LLM context without full debug payloads.
 */
export function extractReplayHistory(events: TranscriptEvent[]): TranscriptReplayContentBlock[][] {
  return events
    .filter((e): e is TranscriptAssistantMessage => e.type === 'assistant_message')
    .map((e) => e.replayContent);
}

/**
 * Extract raw debug history from a parsed transcript.
 *
 * Returns the `rawContent` from each `assistant_message` event, in order.
 * Includes thinking blocks; provider payloads are stripped.
 */
export function extractRawHistory(events: TranscriptEvent[]): TranscriptRawContentBlock[][] {
  return events
    .filter((e): e is TranscriptAssistantMessage => e.type === 'assistant_message')
    .map((e) => e.rawContent);
}
