import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  estimateTokens,
  extractToolResultText,
  isCompactibleToolResult,
  shouldRetainMessage,
  transformContext,
  type CompactionConfig,
} from './compaction.ts';

const CONFIG: CompactionConfig = {
  maxOutputBytes: 260,
  maxOutputTokens: 80,
  headBytes: 48,
  tailBytes: 48,
};

function nativeToolResult(toolName: string, text: string, isError = false) {
  return {
    role: 'tool_result' as const,
    toolCallId: `call-${toolName}`,
    toolName,
    content: [{ type: 'text' as const, text }],
    isError,
    timestamp: 1,
  };
}

function piToolResult(toolName: string, text: string, isError = false) {
  return {
    role: 'toolResult' as const,
    toolCallId: `call-${toolName}`,
    toolName,
    content: [{ type: 'text' as const, text }],
    isError,
    timestamp: 1,
  };
}

function legacyToolResult(toolName: string, text: string, isError = false) {
  return {
    role: 'tool_result' as const,
    content: [{
      type: 'tool_result' as const,
      toolCallId: `call-${toolName}`,
      toolName,
      isError,
      content: [{ type: 'text' as const, text }],
    }],
  };
}

function assistantWithContinuation() {
  return {
    role: 'assistant' as const,
    content: [
      { type: 'thinking' as const, thinking: 'reasoning', thinkingSignature: 'sig-thinking' },
      { type: 'toolCall' as const, id: 'tc-cont', name: 'read_file', arguments: {}, thoughtSignature: 'sig-tool' },
      { type: 'text' as const, text: 'answer' },
    ],
    api: 'api',
    provider: 'provider',
    model: 'model',
    responseId: 'resp-1',
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'toolUse',
    timestamp: 1,
    raw: { preserved: true },
  };
}

function longText(prefix: string): string {
  return `${prefix}:` + Array.from({ length: 80 }, (_, i) => ` line-${i}-abcdefghi`).join('');
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

describe('native-agent compaction', () => {
  it('caps oversized read_file, search_text, and git_diff tool results with clear markers', () => {
    const messages = [
      nativeToolResult('read_file', longText('read')),
      piToolResult('search_text', longText('search')),
      legacyToolResult('git_diff', longText('diff')),
    ];

    const result = transformContext(messages, CONFIG);
    assert.equal(result.events.length, 3);

    for (const message of result.messages) {
      const text = extractToolResultText(message);
      assert.ok(text);
      assert.ok(text.includes('[wavemill replay compaction]'));
      assert.ok(utf8Bytes(text) <= CONFIG.maxOutputBytes);
      assert.ok(estimateTokens(text) <= CONFIG.maxOutputTokens);
    }

    assert.deepEqual(
      result.events.map((event) => event.toolName),
      ['read_file', 'search_text', 'git_diff'],
    );
  });

  it('leaves small compactible output byte-identical', () => {
    const message = nativeToolResult('read_file', 'short output');
    const result = transformContext([message], CONFIG);
    assert.equal(result.events.length, 0);
    assert.equal(result.messages[0], message);
  });

  it('compacts one byte over the byte cap but not exactly at the cap', () => {
    const exact = nativeToolResult('read_file', 'a'.repeat(CONFIG.maxOutputBytes));
    const over = nativeToolResult('read_file', 'a'.repeat(CONFIG.maxOutputBytes + 1));

    assert.equal(transformContext([exact], { ...CONFIG, maxOutputTokens: 1_000 }).events.length, 0);
    assert.equal(transformContext([over], { ...CONFIG, maxOutputTokens: 1_000 }).events.length, 1);
  });

  it('leaves non-compactible tools unchanged', () => {
    const message = nativeToolResult('write_file', longText('write'));
    const result = transformContext([message], CONFIG);
    assert.equal(result.events.length, 0);
    assert.equal(result.messages[0], message);
  });

  it('does not mutate input history or nested content', () => {
    const messages = [nativeToolResult('read_file', longText('read'))];
    const snapshot = structuredClone(messages);

    const result = transformContext(messages, CONFIG);

    assert.deepEqual(messages, snapshot);
    assert.notEqual(result.messages[0], messages[0]);
    assert.notEqual((result.messages[0] as any).content, messages[0].content);
  });

  it('is idempotent on already compacted replay output', () => {
    const once = transformContext([nativeToolResult('read_file', longText('read'))], CONFIG);
    const twice = transformContext(once.messages, CONFIG);

    assert.equal(twice.events.length, 0);
    assert.deepEqual(twice.messages, once.messages);
  });

  it('preserves provider continuation metadata unchanged', () => {
    const assistant = assistantWithContinuation();
    const result = transformContext([assistant, nativeToolResult('read_file', longText('read'))], CONFIG);

    assert.equal(result.messages[0], assistant);
    assert.deepEqual(result.messages[0], assistant);
  });

  it('retains error tool results unchanged', () => {
    const message = nativeToolResult('read_file', longText('error'), true);
    const result = transformContext([message], CONFIG);

    assert.equal(result.events.length, 0);
    assert.equal(result.messages[0], message);
  });

  it('retains active plan, task summary, and completion-contract messages via retain predicate', () => {
    const plan = { role: 'tool_result' as const, toolName: 'read_file', toolCallId: 'plan', content: [{ type: 'text' as const, text: longText('plan') }], isError: false, retainKind: 'active_plan' };
    const diff = { ...nativeToolResult('git_diff', longText('diff')), retainKind: 'current_diff_summary' };
    const contract = { ...nativeToolResult('search_text', longText('contract')), retainKind: 'completion_contract' };

    const result = transformContext([plan, diff, contract], {
      ...CONFIG,
      retainMessage: (message) => (message as { retainKind?: string }).retainKind !== undefined,
    });

    assert.equal(result.events.length, 0);
    assert.equal(result.messages[0], plan);
    assert.equal(result.messages[1], diff);
    assert.equal(result.messages[2], contract);
  });

  it('reports event metadata for original and compacted output sizes', () => {
    const message = nativeToolResult('read_file', longText('read'));
    const result = transformContext([message], CONFIG);
    const event = result.events[0];
    const text = extractToolResultText(result.messages[0]);

    assert.ok(text);
    assert.equal(event.toolName, 'read_file');
    assert.equal(event.toolCallId, 'call-read_file');
    assert.equal(event.originalBytes, utf8Bytes(message.content[0].text));
    assert.equal(event.originalTokens, estimateTokens(message.content[0].text));
    assert.equal(event.compactedBytes, utf8Bytes(text));
    assert.equal(event.compactedTokens, estimateTokens(text));
    assert.ok(text.includes(`compactedBytes=${event.compactedBytes}`));
    assert.ok(text.includes(`compactedTokens=${event.compactedTokens}`));
    assert.equal(event.maxOutputBytes, CONFIG.maxOutputBytes);
    assert.equal(event.maxOutputTokens, CONFIG.maxOutputTokens);
    assert.equal(event.reason, 'tool_result_output_cap');
  });

  it('exposes compactibility and retention helpers', () => {
    const compactible = nativeToolResult('read_file', 'x');
    const error = nativeToolResult('read_file', 'x', true);
    const user = { role: 'user' as const, content: 'keep this state' };

    assert.equal(isCompactibleToolResult(compactible), true);
    assert.equal(isCompactibleToolResult(nativeToolResult('write_file', 'x')), false);
    assert.equal(shouldRetainMessage(error, CONFIG), true);
    assert.equal(shouldRetainMessage(user, CONFIG), true);
  });
});
