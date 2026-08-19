import type { AgentMessage } from '@earendil-works/pi-agent-core';

const DEFAULT_COMPACTABLE_TOOLS = new Set(['read_file', 'search_text', 'git_diff']);
export const TOKEN_BYTES = 4;

export type CompactionLimitReason = 'byte_limit' | 'token_limit' | 'byte_and_token_limit';

export interface ReplayCompactionOptions {
  maxOutputBytes?: number;
  maxOutputTokens?: number;
  compactableTools?: Iterable<string>;
}

export interface ReplayCompactionEvent {
  type: 'context_compacted';
  toolCallId: string;
  toolName: string;
  originalBytes: number;
  retainedBytes: number;
  originalEstimatedTokens: number;
  retainedEstimatedTokens: number;
  reason: CompactionLimitReason;
}

export interface TransformContextResult {
  messages: AgentMessage[];
  events: ReplayCompactionEvent[];
}

interface TextBlock {
  type: 'text';
  text: string;
}

type ToolResultAgentMessage = AgentMessage & {
  role: 'toolResult';
  toolCallId: string;
  toolName: string;
  content: unknown;
  isError?: boolean;
};

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

export function estimateTokensFromBytes(bytes: number): number {
  return Math.ceil(bytes / TOKEN_BYTES);
}

function asToolResult(message: AgentMessage): ToolResultAgentMessage | undefined {
  const candidate = message as {
    role?: unknown;
    toolCallId?: unknown;
    toolName?: unknown;
    content?: unknown;
    isError?: unknown;
  };
  if (candidate.role !== 'toolResult') return undefined;
  if (typeof candidate.toolCallId !== 'string') return undefined;
  if (typeof candidate.toolName !== 'string') return undefined;
  return message as ToolResultAgentMessage;
}

function isTextBlock(block: unknown): block is TextBlock {
  return (
    typeof block === 'object' &&
    block !== null &&
    (block as { type?: unknown }).type === 'text' &&
    typeof (block as { text?: unknown }).text === 'string'
  );
}

function compactableToolSet(options: ReplayCompactionOptions): Set<string> {
  return new Set(options.compactableTools ?? DEFAULT_COMPACTABLE_TOOLS);
}

function determineReason(bytesExceeded: boolean, tokensExceeded: boolean): CompactionLimitReason | undefined {
  if (bytesExceeded && tokensExceeded) return 'byte_and_token_limit';
  if (bytesExceeded) return 'byte_limit';
  if (tokensExceeded) return 'token_limit';
  return undefined;
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (byteLength(text) <= maxBytes) return text;

  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (byteLength(text.slice(0, mid)) <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return text.slice(0, low);
}

function validateOptions(options: ReplayCompactionOptions): void {
  if (options.maxOutputBytes !== undefined && (!Number.isFinite(options.maxOutputBytes) || options.maxOutputBytes <= 0)) {
    throw new Error('Replay compaction maxOutputBytes must be greater than 0');
  }
  if (options.maxOutputTokens !== undefined && (!Number.isFinite(options.maxOutputTokens) || options.maxOutputTokens <= 0)) {
    throw new Error('Replay compaction maxOutputTokens must be greater than 0');
  }
}

function capBytes(options: ReplayCompactionOptions): number | undefined {
  const tokenBytes = options.maxOutputTokens === undefined ? undefined : options.maxOutputTokens * TOKEN_BYTES;
  if (options.maxOutputBytes === undefined) return tokenBytes;
  if (tokenBytes === undefined) return options.maxOutputBytes;
  return Math.min(options.maxOutputBytes, tokenBytes);
}

export function transformContext(
  messages: AgentMessage[],
  options: ReplayCompactionOptions,
): TransformContextResult {
  validateOptions(options);

  const allowedTools = compactableToolSet(options);
  const maxBytes = capBytes(options);
  if (maxBytes === undefined) {
    return { messages, events: [] };
  }

  const events: ReplayCompactionEvent[] = [];
  let changed = false;
  const nextMessages = messages.map((message) => {
    const toolResult = asToolResult(message);
    if (!toolResult || toolResult.isError === true || !allowedTools.has(toolResult.toolName)) {
      return message;
    }
    if (!Array.isArray(toolResult.content)) return message;

    let messageChanged = false;
    const nextContent = toolResult.content.map((block) => {
      if (!isTextBlock(block)) return block;

      const originalBytes = byteLength(block.text);
      const originalEstimatedTokens = estimateTokensFromBytes(originalBytes);
      const bytesExceeded = options.maxOutputBytes !== undefined && originalBytes > options.maxOutputBytes;
      const tokensExceeded = options.maxOutputTokens !== undefined && originalEstimatedTokens > options.maxOutputTokens;
      const reason = determineReason(bytesExceeded, tokensExceeded);
      if (reason === undefined) return block;

      const retainedText = truncateUtf8(block.text, maxBytes);
      const retainedBytes = byteLength(retainedText);
      const retainedEstimatedTokens = estimateTokensFromBytes(retainedBytes);
      const marker = [
        '',
        `[Replay compaction: ${toolResult.toolName} output truncated; originalBytes=${originalBytes}; retainedBytes=${retainedBytes}; originalEstimatedTokens=${originalEstimatedTokens}; retainedEstimatedTokens=${retainedEstimatedTokens}; reason=${reason}]`,
      ].join('\n');

      events.push({
        type: 'context_compacted',
        toolCallId: toolResult.toolCallId,
        toolName: toolResult.toolName,
        originalBytes,
        retainedBytes,
        originalEstimatedTokens,
        retainedEstimatedTokens,
        reason,
      });
      messageChanged = true;
      return { ...block, text: retainedText + marker };
    });

    if (!messageChanged) return message;
    changed = true;
    return { ...toolResult, content: nextContent } as AgentMessage;
  });

  return { messages: changed ? nextMessages : messages, events };
}
