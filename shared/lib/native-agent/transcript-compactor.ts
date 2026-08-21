import type { AgentMessage } from './loop.ts';
import { estimatePromptTokens } from './context-window-guard.ts';

export interface TranscriptCompactionOptions {
  targetTokens: number;
  minRetainedToolResults?: number;
  systemPrompt?: string;
  tools?: readonly { name: string; description?: string; parameters?: unknown }[];
}

export interface TranscriptCompactionResult {
  messages: AgentMessage[];
  droppedCount: number;
  droppedTokensEstimate: number;
  strategy: 'noop' | 'drop-oldest-tool-results' | 'drop-oldest-tool-results-and-truncate';
}

type ToolResultAgentMessage = AgentMessage & {
  role: 'toolResult';
  toolCallId: string;
  toolName: string;
  content: unknown;
};

interface TextBlock {
  type: 'text';
  text: string;
}

const DEFAULT_MIN_RETAINED_TOOL_RESULTS = 4;

export function compactTranscript(
  messages: AgentMessage[],
  options: TranscriptCompactionOptions,
): TranscriptCompactionResult {
  validateOptions(options);

  const minRetainedToolResults = options.minRetainedToolResults ?? DEFAULT_MIN_RETAINED_TOOL_RESULTS;
  const initialTokens = estimateMessages(messages, options);
  if (initialTokens <= options.targetTokens) {
    return {
      messages,
      droppedCount: 0,
      droppedTokensEstimate: 0,
      strategy: 'noop',
    };
  }

  const toolResultIndexes = messages
    .map((message, index) => ({ message: asToolResult(message), index }))
    .filter((entry): entry is { message: ToolResultAgentMessage; index: number } => entry.message !== undefined)
    .map((entry) => entry.index);
  const eligibleIndexes = toolResultIndexes.slice(
    0,
    Math.max(0, toolResultIndexes.length - minRetainedToolResults),
  );

  if (eligibleIndexes.length === 0) {
    return {
      messages,
      droppedCount: 0,
      droppedTokensEstimate: 0,
      strategy: 'noop',
    };
  }

  let nextMessages = messages;
  let currentTokens = initialTokens;
  let droppedCount = 0;
  let droppedTokensEstimate = 0;

  for (const index of eligibleIndexes) {
    const toolResult = asToolResult(nextMessages[index]!);
    if (!toolResult) continue;
    const beforeTokens = estimateMessages([toolResult], {});
    const stub = stubToolResult(toolResult, beforeTokens);
    const afterTokens = estimateMessages([stub], {});
    if (nextMessages === messages) {
      nextMessages = [...messages];
    }
    nextMessages[index] = stub;
    currentTokens = estimateMessages(nextMessages, options);
    droppedCount += 1;
    droppedTokensEstimate += Math.max(0, beforeTokens - afterTokens);
    if (currentTokens <= options.targetTokens) {
      return {
        messages: nextMessages,
        droppedCount,
        droppedTokensEstimate,
        strategy: 'drop-oldest-tool-results',
      };
    }
  }

  for (const index of eligibleIndexes) {
    const toolResult = asToolResult(nextMessages[index]!);
    if (!toolResult) continue;
    const truncated = truncateToolResultText(toolResult);
    if (truncated === toolResult) continue;
    nextMessages[index] = truncated;
    currentTokens = estimateMessages(nextMessages, options);
    if (currentTokens <= options.targetTokens) break;
  }

  return {
    messages: nextMessages,
    droppedCount,
    droppedTokensEstimate,
    strategy: 'drop-oldest-tool-results-and-truncate',
  };
}

function estimateMessages(
  messages: readonly AgentMessage[],
  options: Pick<TranscriptCompactionOptions, 'systemPrompt' | 'tools'>,
): number {
  return estimatePromptTokens({
    systemPrompt: options.systemPrompt,
    messages,
    tools: options.tools,
  }).inputTokens;
}

function validateOptions(options: TranscriptCompactionOptions): void {
  if (!Number.isFinite(options.targetTokens) || !Number.isInteger(options.targetTokens) || options.targetTokens < 0) {
    throw new Error('Transcript compaction targetTokens must be a non-negative integer');
  }
  if (
    options.minRetainedToolResults !== undefined
    && (
      !Number.isFinite(options.minRetainedToolResults)
      || !Number.isInteger(options.minRetainedToolResults)
      || options.minRetainedToolResults < 0
    )
  ) {
    throw new Error('Transcript compaction minRetainedToolResults must be a non-negative integer');
  }
}

function asToolResult(message: AgentMessage): ToolResultAgentMessage | undefined {
  const candidate = message as {
    role?: unknown;
    toolCallId?: unknown;
    toolName?: unknown;
    content?: unknown;
  };
  if (candidate.role !== 'toolResult') return undefined;
  if (typeof candidate.toolCallId !== 'string') return undefined;
  if (typeof candidate.toolName !== 'string') return undefined;
  return message as ToolResultAgentMessage;
}

function stubToolResult(toolResult: ToolResultAgentMessage, originalEstimatedTokens: number): AgentMessage {
  const originalBytes = Buffer.byteLength(extractText(toolResult.content), 'utf8');
  return {
    ...toolResult,
    content: [{
      type: 'text',
      text: `[Compacted: ${toolResult.toolName} result dropped; ${originalBytes} bytes / ${originalEstimatedTokens} tokens]`,
    }],
  } as AgentMessage;
}

function truncateToolResultText(toolResult: ToolResultAgentMessage): AgentMessage {
  if (!Array.isArray(toolResult.content)) return toolResult;
  let changed = false;
  const content = toolResult.content.map((block) => {
    if (!isTextBlock(block)) return block;
    if (block.text.length <= 16) return block;
    changed = true;
    return {
      ...block,
      text: block.text.slice(0, 16),
    };
  });
  return changed ? { ...toolResult, content } as AgentMessage : toolResult;
}

function isTextBlock(block: unknown): block is TextBlock {
  return (
    typeof block === 'object'
    && block !== null
    && (block as { type?: unknown }).type === 'text'
    && typeof (block as { text?: unknown }).text === 'string'
  );
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => (isTextBlock(block) ? block.text : ''))
    .join('');
}
