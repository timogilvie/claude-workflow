import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mapPiUsageToSessionModelUsage } from './messages.ts';
import {
  createPiToolCallingProvider,
  registerScriptedPiProvider,
  type ProviderConversationState,
  type ToolCallingProvider,
} from './provider.ts';

describe('native-agent provider seam', () => {
  it('maps captured Pi usage to SessionModelUsage', () => {
    assert.deepEqual(
      mapPiUsageToSessionModelUsage({
        input: 1200,
        output: 350,
        cacheRead: 800,
        cacheWrite: 64,
        totalTokens: 2350,
        cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
      }),
      {
        inputTokens: 1200,
        outputTokens: 350,
        cacheReadTokens: 800,
        cacheCreationTokens: 64,
      },
    );
  });

  it('defaults missing usage fields to zero', () => {
    assert.deepEqual(
      mapPiUsageToSessionModelUsage({ input: 7, output: 3 }),
      {
        inputTokens: 7,
        outputTokens: 3,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    );

    assert.deepEqual(
      mapPiUsageToSessionModelUsage({
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      }),
      {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    );

    assert.deepEqual(mapPiUsageToSessionModelUsage(undefined), {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });

  it('runs a scripted mock turn through ToolCallingProvider', async () => {
    const api = 'hokusai-mock-test';
    registerScriptedPiProvider({
      api,
      provider: 'hokusai',
      turns: [
        {
          content: [
            {
              type: 'tool_call',
              id: 'call_1',
              name: 'read_file',
              arguments: { path: 'notes.md' },
            },
          ],
          usage: { input: 1200, output: 40, cacheRead: 800, cacheWrite: 64 },
          stopReason: 'tool_calls',
        },
      ],
    });

    const provider: ToolCallingProvider = createPiToolCallingProvider();
    const state: ProviderConversationState = {
      messages: [
        { role: 'system', content: 'You are a read-only planning agent.' },
        { role: 'user', content: 'Plan the change: read notes.md.' },
      ],
    };

    const result = await provider.createTurn({
      model: {
        id: 'hokusai-mini-test',
        api,
        provider: 'hokusai',
      },
      state,
      tools: [
        {
          name: 'read_file',
          description: 'Read a UTF-8 text file from the worktree.',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        },
      ],
    });

    assert.equal(result.finishReason, 'tool_calls');
    assert.equal(result.text, '');
    assert.deepEqual(result.toolCalls, [
      {
        id: 'call_1',
        name: 'read_file',
        arguments: { path: 'notes.md' },
      },
    ]);
    assert.deepEqual(result.usage, {
      inputTokens: 1200,
      outputTokens: 40,
      cacheReadTokens: 800,
      cacheCreationTokens: 64,
    });
    assert.equal(result.message.role, 'assistant');
  });

  it('normalizes a scripted final text turn', async () => {
    const api = 'hokusai-mock-text-test';
    registerScriptedPiProvider({
      api,
      turns: [
        {
          content: [{ type: 'text', text: 'Planning complete.' }],
          usage: { input: 1500, output: 60 },
          stopReason: 'stop',
        },
      ],
    });

    const provider = createPiToolCallingProvider();
    const result = await provider.createTurn({
      model: {
        id: 'hokusai-mini-text-test',
        api,
        provider: 'hokusai',
      },
      state: {
        messages: [{ role: 'user', content: 'Summarize.' }],
      },
    });

    assert.equal(result.finishReason, 'stop');
    assert.equal(result.text, 'Planning complete.');
    assert.deepEqual(result.toolCalls, []);
    assert.deepEqual(result.usage, {
      inputTokens: 1500,
      outputTokens: 60,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });
});
