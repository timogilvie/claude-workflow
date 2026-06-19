import type {
  AssistantMessage,
  Context,
  Message,
  TextContent,
  ToolCall,
  ToolResultMessage,
  Usage,
  UserMessage,
} from '@earendil-works/pi-ai';
import type { SessionModelUsage } from '../session-adapters.ts';

export type NativeAgentRole = 'system' | 'user' | 'assistant' | 'tool_result';

export interface NativeTextContent {
  type: 'text';
  text: string;
}

export interface NativeToolCallContent {
  type: 'tool_call';
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface NativeToolResultContent {
  type: 'tool_result';
  toolCallId: string;
  toolName: string;
  isError?: boolean;
  content: NativeTextContent[];
}

export type NativeMessageContent =
  | NativeTextContent
  | NativeToolCallContent
  | NativeToolResultContent;

export interface NativeAgentMessage {
  role: NativeAgentRole;
  content: string | NativeMessageContent[];
  timestamp?: number;
}

export interface NativeAssistantMessage {
  role: 'assistant';
  content: (NativeTextContent | NativeToolCallContent)[];
  timestamp: number;
  raw: unknown;
}

export function mapPiUsageToSessionModelUsage(
  usage: Partial<Usage> | null | undefined,
): SessionModelUsage {
  return {
    inputTokens: usage?.input ?? 0,
    cacheCreationTokens: usage?.cacheWrite ?? 0,
    cacheReadTokens: usage?.cacheRead ?? 0,
    outputTokens: usage?.output ?? 0,
  };
}

export function createPiContext(
  messages: NativeAgentMessage[],
  tools?: Context['tools'],
): Context {
  let systemPrompt: string | undefined;
  const piMessages: Message[] = [];

  for (const message of messages) {
    if (message.role === 'system') {
      const text = nativeContentToText(message.content);
      systemPrompt = systemPrompt ? `${systemPrompt}\n\n${text}` : text;
      continue;
    }

    piMessages.push(toPiMessage(message));
  }

  return {
    systemPrompt,
    messages: piMessages,
    tools,
  };
}

export function toNativeAssistantMessage(message: AssistantMessage): NativeAssistantMessage {
  return {
    role: 'assistant',
    content: message.content.flatMap((content) => {
      if (content.type === 'text') {
        return [{ type: 'text', text: content.text } satisfies NativeTextContent];
      }
      if (content.type === 'toolCall') {
        return [{
          type: 'tool_call',
          id: content.id,
          name: content.name,
          arguments: content.arguments,
        } satisfies NativeToolCallContent];
      }
      return [];
    }),
    timestamp: message.timestamp,
    raw: message,
  };
}

function toPiMessage(message: NativeAgentMessage): Message {
  switch (message.role) {
    case 'user':
      return {
        role: 'user',
        content: toPiUserContent(message.content),
        timestamp: message.timestamp ?? Date.now(),
      } satisfies UserMessage;
    case 'assistant':
      return toPiAssistantMessage(message);
    case 'tool_result':
      return toPiToolResultMessage(message);
    case 'system':
      throw new Error('System messages are represented as Pi context.systemPrompt');
  }
}

function toPiUserContent(content: NativeAgentMessage['content']): UserMessage['content'] {
  if (typeof content === 'string') {
    return content;
  }

  return content
    .filter((item): item is NativeTextContent => item.type === 'text')
    .map((item) => ({ type: 'text', text: item.text }) satisfies TextContent);
}

function toPiAssistantMessage(message: NativeAgentMessage): AssistantMessage {
  const content = Array.isArray(message.content) ? message.content : [{ type: 'text', text: message.content }];

  return {
    role: 'assistant',
    content: content.flatMap((item): (TextContent | ToolCall)[] => {
      if (item.type === 'text') {
        return [{ type: 'text', text: item.text }];
      }
      if (item.type === 'tool_call') {
        return [{
          type: 'toolCall',
          id: item.id,
          name: item.name,
          arguments: item.arguments,
        }];
      }
      return [];
    }),
    api: 'wavemill-native-history',
    provider: 'wavemill',
    model: 'history',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: message.timestamp ?? Date.now(),
  };
}

function toPiToolResultMessage(message: NativeAgentMessage): ToolResultMessage {
  const result = firstToolResult(message.content);
  if (!result) {
    throw new Error('tool_result messages require tool_result content');
  }

  return {
    role: 'toolResult',
    toolCallId: result.toolCallId,
    toolName: result.toolName,
    content: result.content.map((item) => ({ type: 'text', text: item.text })),
    isError: result.isError ?? false,
    timestamp: message.timestamp ?? Date.now(),
  };
}

function firstToolResult(content: NativeAgentMessage['content']): NativeToolResultContent | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }

  return content.find((item): item is NativeToolResultContent => item.type === 'tool_result');
}

function nativeContentToText(content: NativeAgentMessage['content']): string {
  if (typeof content === 'string') {
    return content;
  }

  return content
    .filter((item): item is NativeTextContent => item.type === 'text')
    .map((item) => item.text)
    .join('\n');
}
