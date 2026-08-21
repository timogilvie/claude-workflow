import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AgentMessage } from './loop.ts';
import { estimatePromptTokens } from './context-window-guard.ts';
import { compactTranscript } from './transcript-compactor.ts';

function toolResult(id: string, text: string): AgentMessage {
  return {
    role: 'toolResult',
    toolCallId: id,
    toolName: 'read_file',
    content: [{ type: 'text', text }],
    isError: false,
    timestamp: 0,
  } as AgentMessage;
}

function user(text: string): AgentMessage {
  return { role: 'user', content: text, timestamp: 0 } as AgentMessage;
}

function tokens(messages: AgentMessage[]): number {
  return estimatePromptTokens({ messages }).inputTokens;
}

describe('transcript compactor', () => {
  it('returns the original transcript when it is already under target', () => {
    const messages = [user('ok'), toolResult('tc1', 'small')];
    const result = compactTranscript(messages, { targetTokens: tokens(messages) });

    assert.equal(result.messages, messages);
    assert.equal(result.strategy, 'noop');
    assert.equal(result.droppedCount, 0);
  });

  it('drops oldest tool results by replacing them with paired stubs', () => {
    const messages = [
      user('start'),
      toolResult('old', 'x'.repeat(4_000)),
      toolResult('new', 'y'.repeat(16)),
    ];

    const result = compactTranscript(messages, {
      targetTokens: tokens(messages) - 500,
      minRetainedToolResults: 1,
    });

    assert.equal(result.strategy, 'drop-oldest-tool-results');
    assert.equal(result.droppedCount, 1);
    assert.equal((result.messages[1] as any).toolCallId, 'old');
    assert.match((result.messages[1] as any).content[0].text, /^\[Compacted: read_file result dropped;/);
    assert.equal((result.messages[2] as any).content[0].text, 'y'.repeat(16));
    assert.ok(tokens(result.messages) < tokens(messages));
  });

  it('respects the retained tail of tool results', () => {
    const messages = [
      toolResult('a', 'a'.repeat(2_000)),
      toolResult('b', 'b'.repeat(2_000)),
      toolResult('c', 'c'.repeat(2_000)),
    ];

    const result = compactTranscript(messages, {
      targetTokens: 1,
      minRetainedToolResults: 2,
    });

    assert.equal(result.droppedCount, 1);
    assert.match((result.messages[0] as any).content[0].text, /\[Compacted:/);
    assert.equal((result.messages[1] as any).content[0].text, 'b'.repeat(2_000));
    assert.equal((result.messages[2] as any).content[0].text, 'c'.repeat(2_000));
  });

  it('falls back to truncating stubs when the target is still exceeded', () => {
    const messages = [
      toolResult('a', 'a'.repeat(2_000)),
      toolResult('b', 'b'.repeat(2_000)),
    ];

    const result = compactTranscript(messages, {
      targetTokens: 0,
      minRetainedToolResults: 0,
    });

    assert.equal(result.strategy, 'drop-oldest-tool-results-and-truncate');
    assert.equal(result.droppedCount, 2);
  });

  it('leaves transcripts without droppable tool results unchanged', () => {
    const messages = [user('x'.repeat(2_000))];
    const result = compactTranscript(messages, {
      targetTokens: 1,
      minRetainedToolResults: 0,
    });

    assert.equal(result.messages, messages);
    assert.equal(result.strategy, 'noop');
  });
});
