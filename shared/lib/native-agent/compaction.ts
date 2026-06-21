export const DEFAULT_COMPACTIBLE_TOOLS = ['read_file', 'search_text', 'git_diff'] as const;

const COMPACTION_MARKER = '[wavemill replay compaction]';
const TOKEN_CHARS = 4;

export interface CompactionConfig {
  maxOutputBytes: number;
  maxOutputTokens: number;
  compactibleTools?: readonly string[];
  retainMessage?: (message: unknown) => boolean;
  headBytes?: number;
  tailBytes?: number;
}

export interface CompactionEventInput {
  toolName: string;
  toolCallId: string;
  originalBytes: number;
  originalTokens: number;
  compactedBytes: number;
  compactedTokens: number;
  maxOutputBytes: number;
  maxOutputTokens: number;
  reason: 'tool_result_output_cap';
}

export interface TransformContextResult<TMessage = unknown> {
  messages: TMessage[];
  events: CompactionEventInput[];
}

interface TextBlock {
  type?: string;
  text?: string;
}

interface ToolResultRef {
  toolName: string;
  toolCallId: string;
  isError: boolean;
  content: TextBlock[];
  textIndex: number;
  text: string;
  legacyContentIndex?: number;
}

interface NormalizedConfig {
  maxOutputBytes: number;
  maxOutputTokens: number;
  compactibleTools: Set<string>;
  retainMessage?: (message: unknown) => boolean;
  headBytes?: number;
  tailBytes?: number;
}

export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / TOKEN_CHARS);
}

export function transformContext<TMessage = unknown>(
  messages: readonly TMessage[],
  config: CompactionConfig,
): TransformContextResult<TMessage> {
  const normalized = validateConfig(config);
  const events: CompactionEventInput[] = [];
  let output: TMessage[] | undefined;

  messages.forEach((message, index) => {
    const replacement = compactMessage(message, normalized, events);
    if (replacement !== message) {
      output ??= messages.slice() as TMessage[];
      output[index] = replacement;
    }
  });

  return {
    messages: output ?? (messages.slice() as TMessage[]),
    events,
  };
}

export function isCompactibleToolResult(
  message: unknown,
  compactibleTools: readonly string[] = DEFAULT_COMPACTIBLE_TOOLS,
): boolean {
  const ref = getToolResultRef(message);
  if (!ref) return false;
  return compactibleTools.includes(ref.toolName);
}

export function shouldRetainMessage(message: unknown, config: CompactionConfig): boolean {
  const ref = getToolResultRef(message);
  if (!ref) return true;
  if (ref.isError) return true;
  return config.retainMessage?.(message) === true;
}

export function extractToolResultText(message: unknown): string | undefined {
  return getToolResultRef(message)?.text;
}

function validateConfig(config: CompactionConfig): NormalizedConfig {
  if (!Number.isFinite(config.maxOutputBytes) || config.maxOutputBytes <= 0) {
    throw new Error('Compaction maxOutputBytes must be greater than 0');
  }
  if (!Number.isFinite(config.maxOutputTokens) || config.maxOutputTokens <= 0) {
    throw new Error('Compaction maxOutputTokens must be greater than 0');
  }
  if (config.headBytes !== undefined && (!Number.isFinite(config.headBytes) || config.headBytes < 0)) {
    throw new Error('Compaction headBytes must be greater than or equal to 0');
  }
  if (config.tailBytes !== undefined && (!Number.isFinite(config.tailBytes) || config.tailBytes < 0)) {
    throw new Error('Compaction tailBytes must be greater than or equal to 0');
  }
  if (
    config.headBytes !== undefined &&
    config.tailBytes !== undefined &&
    config.headBytes + config.tailBytes > config.maxOutputBytes
  ) {
    throw new Error('Compaction headBytes and tailBytes cannot exceed maxOutputBytes');
  }
  return {
    maxOutputBytes: Math.floor(config.maxOutputBytes),
    maxOutputTokens: Math.floor(config.maxOutputTokens),
    compactibleTools: new Set(config.compactibleTools ?? DEFAULT_COMPACTIBLE_TOOLS),
    retainMessage: config.retainMessage,
    headBytes: config.headBytes === undefined ? undefined : Math.floor(config.headBytes),
    tailBytes: config.tailBytes === undefined ? undefined : Math.floor(config.tailBytes),
  };
}

function compactMessage<TMessage>(
  message: TMessage,
  config: NormalizedConfig,
  events: CompactionEventInput[],
): TMessage {
  const ref = getToolResultRef(message);
  if (!ref) return message;
  if (ref.isError) return message;
  if (!config.compactibleTools.has(ref.toolName)) return message;
  if (config.retainMessage?.(message) === true) return message;
  if (ref.text.includes(COMPACTION_MARKER)) return message;

  const originalBytes = byteLength(ref.text);
  const originalTokens = estimateTokens(ref.text);
  if (originalBytes <= config.maxOutputBytes && originalTokens <= config.maxOutputTokens) {
    return message;
  }

  const compacted = truncateTextToCaps(ref.text, config, {
    toolName: ref.toolName,
    toolCallId: ref.toolCallId,
    originalBytes,
    originalTokens,
  });

  events.push({
    toolName: ref.toolName,
    toolCallId: ref.toolCallId,
    originalBytes,
    originalTokens,
    compactedBytes: byteLength(compacted),
    compactedTokens: estimateTokens(compacted),
    maxOutputBytes: config.maxOutputBytes,
    maxOutputTokens: config.maxOutputTokens,
    reason: 'tool_result_output_cap',
  });

  return replaceToolResultText(message, ref, compacted);
}

function truncateTextToCaps(
  text: string,
  config: NormalizedConfig,
  metadata: Pick<CompactionEventInput, 'toolName' | 'toolCallId' | 'originalBytes' | 'originalTokens'>,
): string {
  let headBudget = config.headBytes;
  let tailBudget = config.tailBytes;
  if (headBudget === undefined || tailBudget === undefined) {
    const markerBudget = Math.max(80, Math.floor(config.maxOutputBytes * 0.25));
    const available = Math.max(0, config.maxOutputBytes - markerBudget);
    headBudget ??= Math.floor(available / 2);
    tailBudget ??= available - headBudget;
  }

  headBudget = Math.max(0, headBudget);
  tailBudget = Math.max(0, tailBudget);

  let result = '';
  for (let attempt = 0; attempt < 64; attempt++) {
    const head = sliceUtf8Bytes(text, 0, headBudget);
    const tail = sliceUtf8BytesFromEnd(text, tailBudget);
    result = buildCompactedText(head, tail, metadata, 0, 0);
    for (let stableAttempt = 0; stableAttempt < 8; stableAttempt++) {
      const next = buildCompactedText(head, tail, metadata, byteLength(result), estimateTokens(result));
      if (next === result) break;
      result = next;
    }
    if (fitsCaps(result, config)) return result;

    if (headBudget === 0 && tailBudget === 0) {
      result = shrinkMarkerOnly(metadata, config);
      if (fitsCaps(result, config)) return result;
      throw new Error('Compaction caps are too small for the required marker');
    }

    if (headBudget >= tailBudget && headBudget > 0) {
      headBudget = Math.floor(headBudget * 0.8);
    } else if (tailBudget > 0) {
      tailBudget = Math.floor(tailBudget * 0.8);
    }
  }

  throw new Error('Compaction truncation did not converge within caps');
}

function buildCompactedText(
  head: string,
  tail: string,
  metadata: Pick<CompactionEventInput, 'toolName' | 'toolCallId' | 'originalBytes' | 'originalTokens'>,
  compactedBytes: number,
  compactedTokens: number,
): string {
  return `${head}\n${buildMarker(metadata, compactedBytes, compactedTokens)}\n${tail}`;
}

function buildMarker(
  metadata: Pick<CompactionEventInput, 'toolName' | 'toolCallId' | 'originalBytes' | 'originalTokens'>,
  compactedBytes: number,
  compactedTokens: number,
): string {
  return [
    COMPACTION_MARKER,
    `tool=${metadata.toolName}`,
    `toolCallId=${metadata.toolCallId}`,
    `originalBytes=${metadata.originalBytes}`,
    `originalTokens=${metadata.originalTokens}`,
    `compactedBytes=${compactedBytes}`,
    `compactedTokens=${compactedTokens}`,
    'reason=tool_result_output_cap',
  ].join(' ');
}

function shrinkMarkerOnly(
  metadata: Pick<CompactionEventInput, 'toolName' | 'toolCallId' | 'originalBytes' | 'originalTokens'>,
  config: NormalizedConfig,
): string {
  let marker = buildMarker(metadata, 0, 0);
  if (fitsCaps(marker, config)) return marker;
  while (marker.length > 0 && !fitsCaps(marker, config)) {
    marker = marker.slice(0, -1);
  }
  return marker;
}

function fitsCaps(text: string, config: NormalizedConfig): boolean {
  return byteLength(text) <= config.maxOutputBytes && estimateTokens(text) <= config.maxOutputTokens;
}

function getToolResultRef(message: unknown): ToolResultRef | undefined {
  if (!isRecord(message)) return undefined;
  const role = message.role;
  if (role === 'toolResult') {
    return directToolResultRef(message);
  }
  if (role !== 'tool_result') return undefined;
  const direct = directToolResultRef(message);
  if (direct) return direct;
  return legacyToolResultRef(message);
}

function directToolResultRef(message: Record<string, unknown>): ToolResultRef | undefined {
  if (typeof message.toolName !== 'string' || typeof message.toolCallId !== 'string') return undefined;
  if (!Array.isArray(message.content)) return undefined;
  const textIndex = message.content.findIndex(isTextBlockWithString);
  if (textIndex < 0) return undefined;
  const block = message.content[textIndex] as TextBlock;
  return {
    toolName: message.toolName,
    toolCallId: message.toolCallId,
    isError: message.isError === true,
    content: message.content as TextBlock[],
    textIndex,
    text: block.text ?? '',
  };
}

function legacyToolResultRef(message: Record<string, unknown>): ToolResultRef | undefined {
  if (!Array.isArray(message.content)) return undefined;
  const legacyContentIndex = message.content.findIndex((item) => {
    return isRecord(item) && item.type === 'tool_result';
  });
  if (legacyContentIndex < 0) return undefined;
  const item = message.content[legacyContentIndex];
  if (!isRecord(item)) return undefined;
  if (typeof item.toolName !== 'string' || typeof item.toolCallId !== 'string') return undefined;
  if (!Array.isArray(item.content)) return undefined;
  const textIndex = item.content.findIndex(isTextBlockWithString);
  if (textIndex < 0) return undefined;
  const block = item.content[textIndex] as TextBlock;
  return {
    toolName: item.toolName,
    toolCallId: item.toolCallId,
    isError: item.isError === true,
    content: item.content as TextBlock[],
    textIndex,
    text: block.text ?? '',
    legacyContentIndex,
  };
}

function replaceToolResultText<TMessage>(message: TMessage, ref: ToolResultRef, text: string): TMessage {
  const messageRecord = message as Record<string, unknown>;
  const content = [...ref.content];
  content[ref.textIndex] = { ...content[ref.textIndex], text };

  if (ref.legacyContentIndex !== undefined) {
    const outerContent = [...(messageRecord.content as unknown[])];
    outerContent[ref.legacyContentIndex] = {
      ...(outerContent[ref.legacyContentIndex] as Record<string, unknown>),
      content,
    };
    return { ...messageRecord, content: outerContent } as TMessage;
  }

  return { ...messageRecord, content } as TMessage;
}

function isTextBlockWithString(value: unknown): boolean {
  return isRecord(value) && value.type === 'text' && typeof value.text === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function sliceUtf8Bytes(text: string, startBytes: number, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const bytes = Buffer.from(text, 'utf8');
  const start = Math.max(0, startBytes);
  const end = Math.min(bytes.length, start + maxBytes);
  return bytes.subarray(start, end).toString('utf8').replace(/\uFFFD+$/u, '');
}

function sliceUtf8BytesFromEnd(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const bytes = Buffer.from(text, 'utf8');
  const start = Math.max(0, bytes.length - maxBytes);
  return bytes.subarray(start).toString('utf8').replace(/^\uFFFD+/u, '');
}
