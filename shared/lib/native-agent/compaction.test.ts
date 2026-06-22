import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { transformContext } from './compaction.ts';

function toolResult(toolName: string, text: string, overrides: Partial<Record<string, unknown>> = {}): AgentMessage {
  return {
    role: 'toolResult',
    toolCallId: `${toolName}-call`,
    toolName,
    content: [{ type: 'text', text }],
    isError: false,
    timestamp: 0,
    ...overrides,
  } as AgentMessage;
}

function userMessage(text: string): AgentMessage {
  return { role: 'user', content: text, timestamp: 0 } as AgentMessage;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function firstText(message: AgentMessage): string {
  return ((message as any).content as Array<{ type: string; text?: string }>).find((b) => b.type === 'text')?.text ?? '';
}

describe('native-agent replay compaction', () => {
  it('compacts oversized read_file, search_text, and git_diff results', () => {
    const messages = [
      toolResult('read_file', 'r'.repeat(80)),
      toolResult('search_text', 's'.repeat(80)),
      toolResult('git_diff', 'd'.repeat(80)),
    ];

    const result = transformContext(messages, { maxOutputBytes: 16 });

    assert.equal(result.events.length, 3);
    assert.deepEqual(result.events.map((e) => e.toolName), ['read_file', 'search_text', 'git_diff']);
    for (const message of result.messages) {
      const text = firstText(message);
      assert.ok(text.startsWith(text[0]!.repeat(16)));
      assert.ok(text.includes('[Replay compaction:'));
    }
  });

  it('leaves under-cap, exact-cap, unknown, and non-compactable results unchanged by reference', () => {
    const exact = toolResult('git_diff', 'x'.repeat(16));
    const under = toolResult('read_file', 'short');
    const runTests = toolResult('run_tests', 'r'.repeat(100));
    const unknown = toolResult('unknown_tool', 'u'.repeat(100));

    const result = transformContext([exact, under, runTests, unknown], { maxOutputBytes: 16 });

    assert.equal(result.events.length, 0);
    assert.equal(result.messages[0], exact);
    assert.equal(result.messages[1], under);
    assert.equal(result.messages[2], runTests);
    assert.equal(result.messages[3], unknown);
  });

  it('compacts one byte over the cap with UTF-8-safe truncation', () => {
    const message = toolResult('git_diff', 'é'.repeat(9));

    const result = transformContext([message], { maxOutputBytes: 17 });

    assert.equal(result.events.length, 1);
    assert.equal(result.events[0]!.originalBytes, 18);
    assert.equal(result.events[0]!.retainedBytes, 16);
    assert.ok(firstText(result.messages[0]!).startsWith('é'.repeat(8)));
  });

  it('uses maxOutputTokens when the byte cap does not trigger', () => {
    const message = toolResult('search_text', 'x'.repeat(20));

    const result = transformContext([message], { maxOutputBytes: 100, maxOutputTokens: 3 });

    assert.equal(result.events.length, 1);
    assert.equal(result.events[0]!.reason, 'token_limit');
    assert.equal(result.events[0]!.retainedBytes, 12);
  });

  it('reports byte_and_token_limit when both caps are exceeded', () => {
    const result = transformContext([toolResult('read_file', 'x'.repeat(100))], {
      maxOutputBytes: 20,
      maxOutputTokens: 3,
    });

    assert.equal(result.events[0]!.reason, 'byte_and_token_limit');
    assert.equal(result.events[0]!.retainedBytes, 12);
  });

  it('preserves failed tool results and skipped_after_failure unchanged', () => {
    const failed = toolResult('read_file', 'stack trace'.repeat(20), { isError: true });
    const skipped = toolResult('read_file', 'skipped_after_failure', { isError: true });

    const result = transformContext([failed, skipped], { maxOutputBytes: 8 });

    assert.equal(result.events.length, 0);
    assert.equal(result.messages[0], failed);
    assert.equal(result.messages[1], skipped);
  });

  it('preserves active plan, summaries, completion state, and provider continuation metadata', () => {
    const largePlan = userMessage(`Active plan\n${'p'.repeat(500)}`);
    const summary = userMessage(`Current diff summary\n${'s'.repeat(500)}`);
    const assistant = {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'reasoning', thinkingSignature: 'thinking-sig' },
        { type: 'toolCall', id: 'tc1', name: 'read_file', arguments: {}, thoughtSignature: 'thought-sig' },
      ],
      api: 'api',
      provider: 'provider',
      model: 'model',
      responseId: 'response-id',
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'toolUse',
      timestamp: 0,
    } as AgentMessage;
    const before = clone([largePlan, summary, assistant]);

    const result = transformContext([largePlan, summary, assistant], { maxOutputBytes: 8 });

    assert.deepEqual(result.messages, before);
    assert.equal(result.messages[0], largePlan);
    assert.equal(result.messages[1], summary);
    assert.equal(result.messages[2], assistant);
  });

  it('does not mutate the input history and only replaces compacted message objects', () => {
    const compacted = toolResult('read_file', 'x'.repeat(100));
    const untouched = toolResult('read_file', 'ok');
    const messages = [compacted, untouched];
    const before = clone(messages);

    const result = transformContext(messages, { maxOutputBytes: 10 });

    assert.deepEqual(messages, before);
    assert.notEqual(result.messages[0], compacted);
    assert.equal(result.messages[1], untouched);
  });

  it('leaves image and non-text content unchanged', () => {
    const message = {
      role: 'toolResult',
      toolCallId: 'image-call',
      toolName: 'read_file',
      content: [{ type: 'image', image: 'base64' }],
      isError: false,
      timestamp: 0,
    } as unknown as AgentMessage;

    const result = transformContext([message], { maxOutputBytes: 1 });

    assert.equal(result.events.length, 0);
    assert.equal(result.messages[0], message);
  });

  it('emits metadata-only events without raw payloads', () => {
    const raw = 'SECRET_RAW_PAYLOAD_'.repeat(20);
    const result = transformContext([toolResult('read_file', raw)], { maxOutputBytes: 10 });
    const eventJson = JSON.stringify(result.events[0]);

    assert.ok(!eventJson.includes('SECRET_RAW_PAYLOAD'));
    assert.deepEqual(Object.keys(result.events[0]!).sort(), [
      'originalBytes',
      'originalEstimatedTokens',
      'reason',
      'retainedBytes',
      'retainedEstimatedTokens',
      'toolCallId',
      'toolName',
      'type',
    ]);
  });

  it('throws for invalid byte or token caps', () => {
    assert.throws(() => transformContext([], { maxOutputBytes: 0 }), /maxOutputBytes/);
    assert.throws(() => transformContext([], { maxOutputTokens: 0 }), /maxOutputTokens/);
  });
});
