import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  fromPiMessage,
  toPiMessage,
  type AgentMessage,
  type AgentTurn,
  type NativeToolResultMessage,
  type NativeUserMessage,
} from './messages.ts';

declare module './messages.ts' {
  interface CustomAgentMessages {
    artifact: {
      role: 'artifact';
      artifactId: string;
      title?: string;
    };
  }
}

// ---------------------------------------------------------------------------
// Pi-shaped fixtures (plain objects matching Pi structural types)
// ---------------------------------------------------------------------------

const TEST_USAGE = {
  input: 100,
  output: 50,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 150,
  cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
};

const piUserMsg = {
  role: 'user' as const,
  content: 'Hello, world!',
  timestamp: 1_000_000,
};

const piUserMsgArray = {
  role: 'user' as const,
  content: [{ type: 'text' as const, text: 'Hello, array!' }],
  timestamp: 1_000_001,
};

const piAssistantMsg = {
  role: 'assistant' as const,
  content: [{ type: 'text' as const, text: 'Hi there.' }],
  api: 'anthropic-messages',
  provider: 'anthropic',
  model: 'claude-3-5-sonnet-20241022',
  usage: TEST_USAGE,
  stopReason: 'stop' as const,
  timestamp: 2_000_000,
};

const piAssistantWithToolCall = {
  role: 'assistant' as const,
  content: [
    { type: 'text' as const, text: 'Let me check.' },
    {
      type: 'toolCall' as const,
      id: 'call_abc',
      name: 'read_file',
      arguments: { path: 'notes.md' },
    },
  ],
  api: 'anthropic-messages',
  provider: 'anthropic',
  model: 'claude-3-5-sonnet-20241022',
  usage: TEST_USAGE,
  stopReason: 'toolUse' as const,
  timestamp: 3_000_000,
};

const piAssistantWithThinking = {
  role: 'assistant' as const,
  content: [
    { type: 'thinking' as const, thinking: 'I should answer carefully.', thinkingSignature: 'sig-123' },
    { type: 'text' as const, text: 'Here is my answer.' },
  ],
  api: 'anthropic-messages',
  provider: 'anthropic',
  model: 'claude-3-7-sonnet-20250219',
  usage: TEST_USAGE,
  stopReason: 'stop' as const,
  timestamp: 4_000_000,
};

const piToolResultMsg = {
  role: 'toolResult' as const,
  toolCallId: 'call_abc',
  toolName: 'read_file',
  content: [{ type: 'text' as const, text: 'File content here.' }],
  isError: false,
  timestamp: 5_000_000,
};

const piToolResultError = {
  role: 'toolResult' as const,
  toolCallId: 'call_xyz',
  toolName: 'run_command',
  content: [{ type: 'text' as const, text: 'Command not found.' }],
  details: { exitCode: 127 },
  isError: true,
  timestamp: 6_000_000,
};

// ---------------------------------------------------------------------------
// Round-trip helpers
// ---------------------------------------------------------------------------

function roundTrip(piMsg: Parameters<typeof fromPiMessage>[0]) {
  const native = fromPiMessage(piMsg);
  const piBack = toPiMessage(native);
  return { native, piBack };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('native-agent messages adapter', () => {
  describe('fromPiMessage → toPiMessage round-trips', () => {
    it('round-trips a user text message (string content)', () => {
      const { native, piBack } = roundTrip(piUserMsg);
      assert.equal((native as NativeUserMessage).role, 'user');
      assert.deepEqual(piBack, piUserMsg);
    });

    it('round-trips a user message with array content (text blocks only)', () => {
      const { native, piBack } = roundTrip(piUserMsgArray);
      assert.equal((native as NativeUserMessage).role, 'user');
      assert.deepEqual(piBack, piUserMsgArray);
    });

    it('round-trips an assistant text message', () => {
      const { native, piBack } = roundTrip(piAssistantMsg);
      const turn = native as AgentTurn;
      assert.equal(turn.role, 'assistant');
      assert.equal(turn.api, 'anthropic-messages');
      assert.equal(turn.stopReason, 'stop');
      assert.deepEqual(piBack, piAssistantMsg);
    });

    it('round-trips an assistant message containing a tool call', () => {
      const { native, piBack } = roundTrip(piAssistantWithToolCall);
      const turn = native as AgentTurn;
      assert.equal(turn.role, 'assistant');
      assert.equal(turn.content.length, 2);
      const toolCallBlock = turn.content.find((c) => c.type === 'tool_call');
      assert.ok(toolCallBlock);
      assert.equal((toolCallBlock as { type: 'tool_call'; id: string }).id, 'call_abc');
      assert.deepEqual(piBack, piAssistantWithToolCall);
    });

    it('round-trips a tool result message', () => {
      const { native, piBack } = roundTrip(piToolResultMsg);
      const result = native as NativeToolResultMessage;
      assert.equal(result.role, 'tool_result');
      assert.equal(result.toolCallId, 'call_abc');
      assert.equal(result.isError, false);
      assert.deepEqual(piBack, piToolResultMsg);
    });
  });

  describe('edge cases', () => {
    it('assistant message with text + tool call preserves both content blocks', () => {
      const native = fromPiMessage(piAssistantWithToolCall) as AgentTurn;
      const textBlock = native.content.find((c) => c.type === 'text');
      const toolBlock = native.content.find((c) => c.type === 'tool_call');
      assert.ok(textBlock && textBlock.type === 'text' && textBlock.text === 'Let me check.');
      assert.ok(toolBlock && toolBlock.type === 'tool_call' && toolBlock.name === 'read_file');
    });

    it('assistant message with thinking content round-trips losslessly', () => {
      const { native, piBack } = roundTrip(piAssistantWithThinking);
      const turn = native as AgentTurn;
      const thinkingBlock = turn.content.find((c) => c.type === 'thinking');
      assert.ok(thinkingBlock);
      assert.equal(
        (thinkingBlock as { type: 'thinking'; thinkingSignature?: string }).thinkingSignature,
        'sig-123',
      );
      assert.deepEqual(piBack, piAssistantWithThinking);
    });

    it('tool result with isError: true and details preserves fields', () => {
      const { native, piBack } = roundTrip(piToolResultError);
      const result = native as NativeToolResultMessage;
      assert.equal(result.isError, true);
      assert.deepEqual(result.details, { exitCode: 127 });
      assert.deepEqual(piBack, piToolResultError);
    });

    it('toPiMessage throws a clear error for custom message variants', () => {
      const customMsg = { role: 'artifact' } as unknown as AgentMessage;
      assert.throws(
        () => toPiMessage(customMsg),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.ok(
            err.message.includes('artifact') || err.message.includes('custom message variant'),
            `Expected error to mention the role, got: ${err.message}`,
          );
          return true;
        },
      );
    });

    it('tool call arguments are preserved as Record<string, unknown>', () => {
      const native = fromPiMessage(piAssistantWithToolCall) as AgentTurn;
      const toolBlock = native.content.find((c) => c.type === 'tool_call') as
        | { type: 'tool_call'; arguments: Record<string, unknown> }
        | undefined;
      assert.ok(toolBlock);
      assert.deepEqual(toolBlock.arguments, { path: 'notes.md' });
    });

    it('assistant round-trip preserves usage fields', () => {
      const native = fromPiMessage(piAssistantMsg) as AgentTurn;
      assert.deepEqual(native.usage, TEST_USAGE);
    });

    it('assistant round-trip preserves optional metadata (responseModel, responseId)', () => {
      const msgWithMeta = {
        ...piAssistantMsg,
        responseModel: 'claude-3-5-sonnet-20241022-v2',
        responseId: 'resp_abc123',
      };
      const { piBack } = roundTrip(msgWithMeta);
      assert.deepEqual(piBack, msgWithMeta);
    });
  });

  describe('declaration merging widens AgentMessage', () => {
    it('a custom message variant is assignable to AgentMessage', () => {
      // This is a compile-time type test. If it compiles, declaration merging works.
      const customMsg: AgentMessage = {
        role: 'artifact',
        artifactId: 'artifact-1',
        title: 'Trace output',
      };
      assert.equal(customMsg.role, 'artifact');
      assert.equal(customMsg.artifactId, 'artifact-1');

      // Confirm that the standard variants remain assignable too.
      const userMsg: AgentMessage = { role: 'user', content: 'test' };
      assert.equal(userMsg.role, 'user');

      const toolResultMsg: AgentMessage = {
        role: 'tool_result',
        toolCallId: 'c1',
        toolName: 'foo',
        content: [],
        isError: false,
      };
      assert.equal(toolResultMsg.role, 'tool_result');
    });
  });
});
