import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  TranscriptWriter,
  defaultRedact,
  deriveTranscriptEvents,
  extractRawHistory,
  extractReplayHistory,
  parseTranscriptJsonl,
  TranscriptParseError,
  type TranscriptAssistantMessage,
  type TranscriptEvent,
  type TranscriptSessionEnded,
  type TranscriptSessionStarted,
  type TranscriptToolResult,
  type TranscriptToolStarted,
  type TranscriptTurnEnded,
  type TranscriptTurnStarted,
} from './transcript.ts';

import { successSessionInput } from './fixtures/success-session.ts';
import { blockedSessionInput } from './fixtures/blocked-session.ts';
import { malformedToolCallSessionInput } from './fixtures/malformed-tool-call-session.ts';

// ---------------------------------------------------------------------------
// Shared test helpers
// ---------------------------------------------------------------------------

const FIXED_TIME = 1_750_000_000;

function clock(): number {
  return FIXED_TIME;
}

const BASE_OPTS = {
  sessionId: 'test-session-1',
  model: 'hokusai-mini',
  api: 'hokusai-mock',
  provider: 'hokusai',
  clock,
};

function makeTempPath(): string {
  const dir = join(tmpdir(), `transcript-test-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, `session-${Date.now()}.jsonl`);
}

function removeTempDir(): void {
  try {
    rmSync(join(tmpdir(), `transcript-test-${process.pid}`), { recursive: true, force: true });
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// defaultRedact
// ---------------------------------------------------------------------------

describe('defaultRedact', () => {
  it('redacts known secret key names (case-insensitive)', () => {
    const input = {
      authorization: 'Bearer tok123',
      apiKey: 'sk-secret',
      api_key: 'another-secret',
      token: 'tok-xyz',
      secret: 'my-secret',
      password: 'hunter2',
    };
    const result = defaultRedact(input) as Record<string, unknown>;
    for (const key of Object.keys(input)) {
      assert.equal(result[key], '[REDACTED]', `Expected ${key} to be redacted`);
    }
  });

  it('preserves non-secret keys', () => {
    const input = { path: '/workspace/notes.md', bytes: 18, isError: false };
    const result = defaultRedact(input) as typeof input;
    assert.deepEqual(result, input);
  });

  it('redacts nested secret keys', () => {
    const input = { headers: { authorization: 'Bearer tok' }, status: 200 };
    const result = defaultRedact(input) as { headers: { authorization: string }; status: number };
    assert.equal(result.headers.authorization, '[REDACTED]');
    assert.equal(result.status, 200);
  });

  it('traverses arrays without breaking', () => {
    const input = [{ apiKey: 'secret' }, { path: '/foo' }];
    const result = defaultRedact(input) as Array<Record<string, unknown>>;
    assert.equal(result[0].apiKey, '[REDACTED]');
    assert.equal(result[1].path, '/foo');
  });

  it('returns primitives unchanged', () => {
    assert.equal(defaultRedact('hello'), 'hello');
    assert.equal(defaultRedact(42), 42);
    assert.equal(defaultRedact(null), null);
  });
});

// ---------------------------------------------------------------------------
// Per-event-family derivation
// ---------------------------------------------------------------------------

describe('deriveTranscriptEvents – event family derivation', () => {
  it('agent_start emits session_started with model/api/provider', () => {
    const events = deriveTranscriptEvents([{ type: 'agent_start' }], BASE_OPTS);
    assert.equal(events.length, 1);
    const ev = events[0] as TranscriptSessionStarted;
    assert.equal(ev.type, 'session_started');
    assert.equal(ev.model, 'hokusai-mini');
    assert.equal(ev.api, 'hokusai-mock');
    assert.equal(ev.provider, 'hokusai');
    assert.equal(ev.sessionId, 'test-session-1');
    assert.equal(ev.seq, 0);
    assert.equal(ev.timestamp, FIXED_TIME);
  });

  it('turn_start emits turn_started with correct turnIndex', () => {
    const events = deriveTranscriptEvents(
      [{ type: 'agent_start' }, { type: 'turn_start' }],
      BASE_OPTS,
    );
    const ev = events.find((e) => e.type === 'turn_started') as TranscriptTurnStarted;
    assert.ok(ev);
    assert.equal(ev.turnIndex, 0);
  });

  it('turn_end emits turn_ended and increments turnIndex for subsequent turns', () => {
    const assistantMsg = {
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text: 'Done.' }],
      api: 'hokusai-mock',
      provider: 'hokusai',
      model: 'hokusai-mini',
      usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'stop' as const,
      timestamp: FIXED_TIME,
    };
    const events = deriveTranscriptEvents(
      [
        { type: 'agent_start' },
        { type: 'turn_start' },
        { type: 'turn_end', message: assistantMsg, toolResults: [] },
        { type: 'turn_start' },
        { type: 'turn_end', message: assistantMsg, toolResults: [] },
      ],
      BASE_OPTS,
    );
    const ended = events.filter((e): e is TranscriptTurnEnded => e.type === 'turn_ended');
    assert.equal(ended.length, 2);
    assert.equal(ended[0].turnIndex, 0);
    assert.equal(ended[1].turnIndex, 1);
  });

  it('message_end for assistant emits assistant_message with rawContent and replayContent', () => {
    const msg = {
      role: 'assistant' as const,
      content: [
        { type: 'thinking' as const, thinking: 'I should think.', thinkingSignature: 'sig1' },
        { type: 'text' as const, text: 'My answer.' },
        { type: 'toolCall' as const, id: 'tc1', name: 'search', arguments: { query: 'test' } },
      ],
      api: 'hokusai-mock',
      provider: 'hokusai',
      model: 'hokusai-mini',
      usage: { input: 200, output: 30, cacheRead: 5, cacheWrite: 2, totalTokens: 237, cost: { input: 0.002, output: 0.0003, cacheRead: 0, cacheWrite: 0, total: 0.0023 } },
      stopReason: 'toolUse' as const,
      timestamp: FIXED_TIME,
    };
    const events = deriveTranscriptEvents([{ type: 'message_end', message: msg }], BASE_OPTS);
    assert.equal(events.length, 1);
    const ev = events[0] as TranscriptAssistantMessage;
    assert.equal(ev.type, 'assistant_message');
    assert.equal(ev.model, 'hokusai-mini');
    assert.equal(ev.stopReason, 'toolUse');

    // rawContent preserves thinking blocks
    assert.equal(ev.rawContent.length, 3);
    assert.equal(ev.rawContent[0].type, 'thinking');
    assert.equal(ev.rawContent[1].type, 'text');
    assert.equal(ev.rawContent[2].type, 'tool_call');

    // replayContent strips thinking blocks
    assert.equal(ev.replayContent.length, 2);
    assert.equal(ev.replayContent[0].type, 'text');
    assert.equal(ev.replayContent[1].type, 'tool_call');

    // usage is captured
    assert.ok(ev.usage);
    assert.equal(ev.usage.input, 200);
    assert.equal(ev.usage.cacheRead, 5);
    assert.ok(ev.usage.cost);
    assert.equal(ev.usage.cost.input, 0.002);
  });

  it('message_end for user message is skipped', () => {
    const userMsg = {
      role: 'user' as const,
      content: 'Hello.',
      timestamp: FIXED_TIME,
    };
    const events = deriveTranscriptEvents([{ type: 'message_end', message: userMsg }], BASE_OPTS);
    assert.equal(events.length, 0);
  });

  it('tool_execution_start emits tool_started with args', () => {
    const events = deriveTranscriptEvents(
      [{ type: 'tool_execution_start', toolCallId: 'tc1', toolName: 'read_file', args: { path: 'notes.md' } }],
      BASE_OPTS,
    );
    assert.equal(events.length, 1);
    const ev = events[0] as TranscriptToolStarted;
    assert.equal(ev.type, 'tool_started');
    assert.equal(ev.toolCallId, 'tc1');
    assert.equal(ev.toolName, 'read_file');
    assert.deepEqual(ev.args, { path: 'notes.md' });
  });

  it('tool_execution_end emits tool_result with first text content', () => {
    const events = deriveTranscriptEvents(
      [
        {
          type: 'tool_execution_end',
          toolCallId: 'tc1',
          toolName: 'read_file',
          result: { content: [{ type: 'text', text: 'File content here.' }], details: { bytes: 18 } },
          isError: false,
        },
      ],
      BASE_OPTS,
    );
    assert.equal(events.length, 1);
    const ev = events[0] as TranscriptToolResult;
    assert.equal(ev.type, 'tool_result');
    assert.equal(ev.toolCallId, 'tc1');
    assert.equal(ev.isError, false);
    assert.equal(ev.content, 'File content here.');
    assert.deepEqual(ev.details, { bytes: 18 });
    assert.equal(ev.redacted, false);
  });

  it('tool_execution_end redacts secret keys in details', () => {
    const events = deriveTranscriptEvents(
      [
        {
          type: 'tool_execution_end',
          toolCallId: 'tc2',
          toolName: 'api_call',
          result: {
            content: [{ type: 'text', text: 'ok' }],
            details: { authorization: 'Bearer secret', status: 200 },
          },
          isError: false,
        },
      ],
      BASE_OPTS,
    );
    const ev = events[0] as TranscriptToolResult;
    const details = ev.details as { authorization: string; status: number };
    assert.equal(details.authorization, '[REDACTED]');
    assert.equal(details.status, 200);
    assert.equal(ev.redacted, true);
  });

  it('agent_end emits session_ended with message count', () => {
    const events = deriveTranscriptEvents(
      [{ type: 'agent_end', messages: ['a', 'b', 'c'] as unknown[] }],
      BASE_OPTS,
    );
    const ev = events[0] as TranscriptSessionEnded;
    assert.equal(ev.type, 'session_ended');
    assert.equal(ev.messageCount, 3);
  });

  it('message_start and message_update are skipped', () => {
    const msg = { role: 'assistant' as const, content: [], api: 'x', provider: 'y', model: 'm', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop' as const, timestamp: 0 };
    const events = deriveTranscriptEvents(
      [
        { type: 'message_start', message: msg },
        { type: 'message_update', message: msg, assistantMessageEvent: { type: 'start', partial: msg } },
      ],
      BASE_OPTS,
    );
    assert.equal(events.length, 0);
  });

  it('seq values are monotonically increasing', () => {
    const events = deriveTranscriptEvents(
      [{ type: 'agent_start' }, { type: 'turn_start' }],
      BASE_OPTS,
    );
    assert.equal(events[0].seq, 0);
    assert.equal(events[1].seq, 1);
  });
});

// ---------------------------------------------------------------------------
// Writer tests (append-only JSONL)
// ---------------------------------------------------------------------------

describe('TranscriptWriter', () => {
  it('appends JSONL lines to file and produces parseable output', () => {
    const path = makeTempPath();
    const writer = new TranscriptWriter({ ...BASE_OPTS, path });

    writer.handleEvent({ type: 'agent_start' });
    writer.handleEvent({ type: 'turn_start' });
    writer.handleEvent({ type: 'agent_end', messages: [] });

    const content = readFileSync(path, 'utf-8');
    const lines = content.trim().split('\n');
    assert.equal(lines.length, 3);
    for (const line of lines) {
      assert.doesNotThrow(() => JSON.parse(line));
    }
    removeTempDir();
  });

  it('skipped Pi events do not write to file', () => {
    const path = makeTempPath();
    const writer = new TranscriptWriter({ ...BASE_OPTS, path });
    const msg = { role: 'user' as const, content: 'hi', timestamp: 0 };
    writer.handleEvent({ type: 'message_start', message: msg });
    writer.handleEvent({ type: 'message_end', message: msg }); // user message — skipped

    // File is not created when nothing is written
    assert.ok(!existsSync(path), 'file should not exist when no events are written');
    removeTempDir();
  });

  it('creates parent directory if it does not exist', () => {
    const dir = join(tmpdir(), `transcript-test-mkdir-${process.pid}`);
    const path = join(dir, 'nested', 'subdir', 'session.jsonl');
    const writer = new TranscriptWriter({ ...BASE_OPTS, path });
    writer.handleEvent({ type: 'agent_start' });
    const content = readFileSync(path, 'utf-8');
    assert.ok(content.includes('session_started'));
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null for skipped events and TranscriptEvent for written events', () => {
    const path = makeTempPath();
    const writer = new TranscriptWriter({ ...BASE_OPTS, path });
    const msg = { role: 'user' as const, content: 'hi', timestamp: 0 };
    const skipped = writer.handleEvent({ type: 'message_start', message: msg });
    const written = writer.handleEvent({ type: 'agent_start' });
    assert.equal(skipped, null);
    assert.ok(written !== null);
    assert.equal(written.type, 'session_started');
    removeTempDir();
  });

  it('supports custom redact function', () => {
    const path = makeTempPath();
    const alwaysRedact = (_v: unknown) => '[ALL_REDACTED]';
    const writer = new TranscriptWriter({ ...BASE_OPTS, path, redact: alwaysRedact });
    const result = writer.handleEvent({
      type: 'tool_execution_end',
      toolCallId: 'tc1',
      toolName: 'api_call',
      result: { content: [{ type: 'text', text: 'ok' }], details: { anything: 'sensitive' } },
      isError: false,
    });
    const ev = result as TranscriptToolResult;
    assert.equal(ev.details, '[ALL_REDACTED]');
    removeTempDir();
  });
});

// ---------------------------------------------------------------------------
// JSONL parse utilities
// ---------------------------------------------------------------------------

describe('parseTranscriptJsonl', () => {
  it('parses a valid session JSONL', () => {
    const events = deriveTranscriptEvents(successSessionInput, BASE_OPTS);
    const jsonl = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
    const parsed = parseTranscriptJsonl(jsonl);
    assert.equal(parsed.length, events.length);
    assert.deepEqual(parsed, events);
  });

  it('skips blank lines', () => {
    const jsonl = '{"type":"session_started","seq":0,"sessionId":"s","timestamp":0,"model":"m","api":"a","provider":"p"}\n\n\n';
    const events = parseTranscriptJsonl(jsonl);
    assert.equal(events.length, 1);
  });

  it('throws TranscriptParseError on malformed JSON', () => {
    const jsonl = '{"type":"session_started"}\nnot-json\n{"type":"session_ended"}';
    assert.throws(
      () => parseTranscriptJsonl(jsonl),
      (err: unknown) => {
        assert.ok(err instanceof TranscriptParseError);
        assert.ok(err.message.includes('line 2'));
        assert.equal(err.lineNumber, 2);
        assert.equal(err.line, 'not-json');
        return true;
      },
    );
  });

  it('parses empty string as empty array', () => {
    const events = parseTranscriptJsonl('');
    assert.deepEqual(events, []);
  });
});

// ---------------------------------------------------------------------------
// Raw vs replay history extraction
// ---------------------------------------------------------------------------

describe('extractRawHistory / extractReplayHistory', () => {
  it('extractReplayHistory returns only text and tool_call content, no thinking', () => {
    const msg = {
      role: 'assistant' as const,
      content: [
        { type: 'thinking' as const, thinking: 'hmm', thinkingSignature: 'sig' },
        { type: 'text' as const, text: 'Answer.' },
        { type: 'toolCall' as const, id: 'tc1', name: 'search', arguments: { q: 'x' } },
      ],
      api: 'hokusai-mock',
      provider: 'hokusai',
      model: 'hokusai-mini',
      usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'toolUse' as const,
      timestamp: FIXED_TIME,
    };
    const events = deriveTranscriptEvents([{ type: 'message_end', message: msg }], BASE_OPTS);
    const replay = extractReplayHistory(events);
    assert.equal(replay.length, 1);
    assert.equal(replay[0].length, 2);
    assert.equal(replay[0][0].type, 'text');
    assert.equal(replay[0][1].type, 'tool_call');
  });

  it('extractRawHistory returns full content including thinking blocks', () => {
    const msg = {
      role: 'assistant' as const,
      content: [
        { type: 'thinking' as const, thinking: 'deep thought', thinkingSignature: 'sig' },
        { type: 'text' as const, text: 'Answer.' },
      ],
      api: 'x',
      provider: 'y',
      model: 'm',
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'stop' as const,
      timestamp: FIXED_TIME,
    };
    const events = deriveTranscriptEvents([{ type: 'message_end', message: msg }], BASE_OPTS);
    const raw = extractRawHistory(events);
    assert.equal(raw.length, 1);
    assert.equal(raw[0].length, 2);
    assert.equal(raw[0][0].type, 'thinking');
    const thinkingBlock = raw[0][0] as { type: 'thinking'; thinking: string; thinkingSignature?: string };
    assert.equal(thinkingBlock.thinking, 'deep thought');
    assert.equal(thinkingBlock.thinkingSignature, 'sig');
  });
});

// ---------------------------------------------------------------------------
// Redaction: raw provider payload never written
// ---------------------------------------------------------------------------

describe('redaction before write', () => {
  it('assistant_message event does not contain raw provider payload', () => {
    const path = makeTempPath();
    const writer = new TranscriptWriter({ ...BASE_OPTS, path });
    const msg = {
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text: 'Hi.' }],
      api: 'hokusai-mock',
      provider: 'hokusai',
      model: 'hokusai-mini',
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'stop' as const,
      timestamp: FIXED_TIME,
    };
    writer.handleEvent({ type: 'message_end', message: msg });
    const content = readFileSync(path, 'utf-8');
    // The raw provider payload (e.g., the full message object at `raw: msg`) must not appear
    assert.ok(!content.includes('"raw"'), 'raw provider payload leaked into transcript');
    removeTempDir();
  });

  it('tool result with authorization in details is redacted before write', () => {
    const path = makeTempPath();
    const writer = new TranscriptWriter({ ...BASE_OPTS, path });
    writer.handleEvent({
      type: 'tool_execution_end',
      toolCallId: 'tc1',
      toolName: 'api_call',
      result: {
        content: [{ type: 'text', text: 'response body' }],
        details: { authorization: 'Bearer sk-1234', status: 200 },
      },
      isError: false,
    });
    const content = readFileSync(path, 'utf-8');
    assert.ok(!content.includes('sk-1234'), 'secret token leaked into transcript');
    assert.ok(content.includes('[REDACTED]'), 'expected [REDACTED] placeholder in transcript');
    removeTempDir();
  });
});

// ---------------------------------------------------------------------------
// Full fixture assertions
// ---------------------------------------------------------------------------

describe('success session fixture', () => {
  it('produces the correct event sequence', () => {
    const events = deriveTranscriptEvents(successSessionInput, BASE_OPTS);
    const types = events.map((e) => e.type);
    assert.deepEqual(types, [
      'session_started',
      'turn_started',
      'assistant_message',
      'tool_started',
      'tool_result',
      'turn_ended',
      'turn_started',
      'assistant_message',
      'turn_ended',
      'session_ended',
    ]);
  });

  it('tool_result in success session is not an error', () => {
    const events = deriveTranscriptEvents(successSessionInput, BASE_OPTS);
    const toolResult = events.find((e): e is TranscriptToolResult => e.type === 'tool_result');
    assert.ok(toolResult);
    assert.equal(toolResult.isError, false);
    assert.equal(toolResult.content, 'File content here.');
  });

  it('session_ended reports correct message count', () => {
    const events = deriveTranscriptEvents(successSessionInput, BASE_OPTS);
    const ended = events.find((e): e is TranscriptSessionEnded => e.type === 'session_ended');
    assert.ok(ended);
    assert.equal(ended.messageCount, 3);
  });

  it('assistant_message stopReason is toolUse for tool-calling turn', () => {
    const events = deriveTranscriptEvents(successSessionInput, BASE_OPTS);
    const assistantMsgs = events.filter((e): e is TranscriptAssistantMessage => e.type === 'assistant_message');
    assert.equal(assistantMsgs[0].stopReason, 'toolUse');
    assert.equal(assistantMsgs[1].stopReason, 'stop');
  });

  it('end-to-end writer produces parseable JSONL for the full session', () => {
    const path = makeTempPath();
    const writer = new TranscriptWriter({ ...BASE_OPTS, path });
    for (const ev of successSessionInput) {
      writer.handleEvent(ev);
    }
    const content = readFileSync(path, 'utf-8');
    assert.ok(content.endsWith('\n'), 'JSONL file should end with newline');
    const parsed = parseTranscriptJsonl(content) as TranscriptEvent[];
    const types = parsed.map((e) => e.type);
    assert.ok(types.includes('session_started'));
    assert.ok(types.includes('session_ended'));
    removeTempDir();
  });
});

describe('blocked session fixture', () => {
  it('produces the correct event sequence', () => {
    const events = deriveTranscriptEvents(blockedSessionInput, BASE_OPTS);
    const types = events.map((e) => e.type);
    assert.deepEqual(types, [
      'session_started',
      'turn_started',
      'assistant_message',
      'tool_started',
      'tool_result',
      'turn_ended',
      'turn_started',
      'assistant_message',
      'turn_ended',
      'session_ended',
    ]);
  });

  it('blocked tool result is recorded as error', () => {
    const events = deriveTranscriptEvents(blockedSessionInput, BASE_OPTS);
    const toolResult = events.find((e): e is TranscriptToolResult => e.type === 'tool_result');
    assert.ok(toolResult);
    assert.equal(toolResult.isError, true);
    assert.ok(toolResult.content.includes('path_denied'), 'expected error reason in content');
  });

  it('blocked tool args are preserved in tool_started', () => {
    const events = deriveTranscriptEvents(blockedSessionInput, BASE_OPTS);
    const toolStarted = events.find((e): e is TranscriptToolStarted => e.type === 'tool_started');
    assert.ok(toolStarted);
    assert.deepEqual(toolStarted.args, { path: '../secrets.env' });
  });

  it('turn_ended includes correct toolResultCount', () => {
    const events = deriveTranscriptEvents(blockedSessionInput, BASE_OPTS);
    const turnEnded = events.find((e): e is TranscriptTurnEnded => e.type === 'turn_ended');
    assert.ok(turnEnded);
    assert.equal(turnEnded.toolResultCount, 1);
  });

  it('does not throw during derivation', () => {
    assert.doesNotThrow(() => deriveTranscriptEvents(blockedSessionInput, BASE_OPTS));
  });
});

describe('malformed-tool-call session fixture', () => {
  it('produces the correct event sequence without throwing', () => {
    assert.doesNotThrow(() => deriveTranscriptEvents(malformedToolCallSessionInput, BASE_OPTS));
  });

  it('records malformed tool call result as isError: true', () => {
    const events = deriveTranscriptEvents(malformedToolCallSessionInput, BASE_OPTS);
    const toolResult = events.find((e): e is TranscriptToolResult => e.type === 'tool_result');
    assert.ok(toolResult);
    assert.equal(toolResult.isError, true);
    assert.ok(toolResult.content.includes('validation failed'), 'expected validation error in content');
  });

  it('preserves malformed tool call metadata in tool_started', () => {
    const events = deriveTranscriptEvents(malformedToolCallSessionInput, BASE_OPTS);
    const toolStarted = events.find((e): e is TranscriptToolStarted => e.type === 'tool_started');
    assert.ok(toolStarted);
    assert.equal(toolStarted.toolName, 'read_file');
    // args is the empty object (missing required 'path' field)
    assert.deepEqual(toolStarted.args, {});
  });

  it('does not leak malformed validation details as secret keys', () => {
    const path = makeTempPath();
    const writer = new TranscriptWriter({ ...BASE_OPTS, path });
    for (const ev of malformedToolCallSessionInput) {
      writer.handleEvent(ev);
    }
    const content = readFileSync(path, 'utf-8');
    // validation_failed is a non-secret detail — should pass through
    assert.ok(content.includes('validation_failed'));
    removeTempDir();
  });
});
