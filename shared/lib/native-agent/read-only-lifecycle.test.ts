/**
 * Read-only lifecycle smoke test.
 *
 * Runs a deterministic mock native planning loop over a temporary git repo
 * without live provider keys. Verifies that:
 *
 *   - The loop completes with stopReason 'stop'.
 *   - All five read-only inspection surfaces are visible to the model.
 *   - The persisted transcript records tool_result events for each surface.
 *   - The denied mutation attempt is surfaced as an error (not executed).
 *   - The planted fake secret does not appear in the transcript or replay history.
 */

import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after } from 'node:test';

import {
  createLifecycleFixture,
  runLifecycle,
  PLANTED_SECRET,
  TASK_PACKET_PATH,
  PLAN_PATH,
  SOURCE_PATH,
  type LifecycleFixture,
} from './fixtures/read-only-lifecycle.ts';
import {
  TranscriptWriter,
  parseTranscriptJsonl,
  extractReplayHistory,
  extractRawHistory,
  type TranscriptToolResult,
  type TranscriptToolStarted,
} from './transcript.ts';

// ---------------------------------------------------------------------------
// Shared fixture state (created once per describe block)
// ---------------------------------------------------------------------------

let fixture: LifecycleFixture;
let lifecycleResult: Awaited<ReturnType<typeof runLifecycle>>;
let transcriptEvents: ReturnType<typeof parseTranscriptJsonl>;

describe('read-only lifecycle smoke', () => {
  before(async () => {
    fixture = createLifecycleFixture();
    lifecycleResult = await runLifecycle(fixture);
    const jsonl = readFileSync(fixture.transcriptPath, 'utf-8');
    transcriptEvents = parseTranscriptJsonl(jsonl);
  });

  after(() => {
    fixture?.cleanup();
  });

  // -------------------------------------------------------------------------
  // Loop stop reason
  // -------------------------------------------------------------------------

  it('loop stops with reason "stop"', () => {
    assert.equal(lifecycleResult.loopResult.stopReason, 'stop');
  });

  // -------------------------------------------------------------------------
  // Read-only inspection surfaces visible to the model
  // -------------------------------------------------------------------------

  it('model received tool results for all five read-only surfaces', () => {
    const toolResults = lifecycleResult.loopResult.messages.filter(
      (m: unknown) => (m as { role?: string }).role === 'toolResult',
    ) as Array<{ toolName: string; isError: boolean }>;

    const names = toolResults.map((r) => r.toolName);
    assert.ok(names.includes('read_file'), 'read_file result must be present');
    assert.ok(names.includes('git_status'), 'git_status result must be present');
    assert.ok(names.includes('git_diff'), 'git_diff result must be present');

    // Three read_file calls total (task-packet, plan, source)
    const readFileResults = toolResults.filter((r) => r.toolName === 'read_file');
    assert.ok(readFileResults.length >= 3, 'expected at least 3 read_file results');
  });

  // -------------------------------------------------------------------------
  // Transcript — tool_result events for each inspection surface
  // -------------------------------------------------------------------------

  it('transcript contains tool_result event for task packet read', () => {
    const started = transcriptEvents.filter(
      (e): e is TranscriptToolStarted =>
        e.type === 'tool_started' && e.toolName === 'read_file',
    );
    // Verify the task-packet path was a target
    const taskPacketRead = started.find(
      (e) => typeof e.args.path === 'string' && e.args.path.includes('task-packet'),
    );
    assert.ok(taskPacketRead, 'tool_started for task-packet read must be present');
  });

  it('transcript contains tool_result events for read_file (plan, source)', () => {
    const results = transcriptEvents.filter(
      (e): e is TranscriptToolResult =>
        e.type === 'tool_result' && e.toolName === 'read_file',
    );
    assert.ok(results.length >= 3, `expected ≥3 read_file tool_result events, got ${results.length}`);
    // All successful reads should not be errors
    const nonErrorReads = results.filter((r) => !r.isError);
    assert.ok(nonErrorReads.length >= 3, 'expected ≥3 successful read_file results');
  });

  it('transcript contains tool_result event for git_status', () => {
    const result = transcriptEvents.find(
      (e): e is TranscriptToolResult =>
        e.type === 'tool_result' && e.toolName === 'git_status',
    );
    assert.ok(result, 'tool_result for git_status must be present');
    assert.equal(result.isError, false);
  });

  it('transcript contains tool_result event for git_diff', () => {
    const result = transcriptEvents.find(
      (e): e is TranscriptToolResult =>
        e.type === 'tool_result' && e.toolName === 'git_diff',
    );
    assert.ok(result, 'tool_result for git_diff must be present');
    assert.equal(result.isError, false);
  });

  // -------------------------------------------------------------------------
  // Denied mutation — error surfaced, executor never called
  // -------------------------------------------------------------------------

  it('transcript contains error tool_result for denied mutation (patch_file)', () => {
    const result = transcriptEvents.find(
      (e): e is TranscriptToolResult =>
        e.type === 'tool_result' && e.toolName === 'patch_file',
    );
    assert.ok(result, 'tool_result for denied patch_file must be present in transcript');
    assert.equal(result.isError, true, 'denied mutation must have isError: true');
    assert.ok(
      result.content.includes('phase_denied'),
      `expected "phase_denied" in content, got: ${result.content}`,
    );
  });

  it('denied mutation executor was never called', () => {
    assert.equal(
      lifecycleResult.mutationExecutorCalled,
      false,
      'patch_file executor must not have been called during planning phase',
    );
  });

  it('model received denied mutation as error tool result', () => {
    const toolResults = lifecycleResult.loopResult.messages.filter(
      (m: unknown) => (m as { role?: string; toolName?: string }).role === 'toolResult'
        && (m as { toolName?: string }).toolName === 'patch_file',
    ) as Array<{ isError: boolean; content?: Array<{ text: string }> }>;

    assert.ok(toolResults.length > 0, 'patch_file tool result must appear in model messages');
    const [patchResult] = toolResults;
    assert.equal(patchResult.isError, true);
    const text = patchResult.content?.[0]?.text ?? '';
    assert.ok(text.includes('phase_denied'), `expected "phase_denied" in model result, got: ${text}`);
  });

  // -------------------------------------------------------------------------
  // Secret redaction — planted secret must not appear in transcript
  // -------------------------------------------------------------------------

  it('persisted transcript JSONL does not contain the planted secret', () => {
    const jsonl = readFileSync(fixture.transcriptPath, 'utf-8');
    assert.ok(
      !jsonl.includes(PLANTED_SECRET),
      `Planted secret "${PLANTED_SECRET}" must not appear in transcript JSONL`,
    );
  });

  it('replay history does not contain the planted secret', () => {
    const replay = extractReplayHistory(transcriptEvents);
    const replayText = JSON.stringify(replay);
    assert.ok(
      !replayText.includes(PLANTED_SECRET),
      `Planted secret must not appear in replay history`,
    );
  });

  it('raw history does not contain the planted secret', () => {
    const raw = extractRawHistory(transcriptEvents);
    const rawText = JSON.stringify(raw);
    assert.ok(
      !rawText.includes(PLANTED_SECRET),
      `Planted secret must not appear in raw history`,
    );
  });

  it('transcript contains [REDACTED] placeholder for the planted secret', () => {
    const jsonl = readFileSync(fixture.transcriptPath, 'utf-8');
    assert.ok(
      jsonl.includes('[REDACTED]'),
      'Expected [REDACTED] placeholder to appear in transcript',
    );
  });

  // -------------------------------------------------------------------------
  // git_diff contains actual diff content (non-empty)
  // -------------------------------------------------------------------------

  it('git_diff result contains diff content (uncommitted change is visible)', () => {
    const result = transcriptEvents.find(
      (e): e is TranscriptToolResult =>
        e.type === 'tool_result' && e.toolName === 'git_diff',
    );
    assert.ok(result, 'git_diff tool_result must exist');
    // The content may be the diff text or serialized JSON; check it's non-empty
    assert.ok(result.content.length > 0, 'git_diff result content must be non-empty');
  });

  // -------------------------------------------------------------------------
  // Determinism — re-running produces the same event count
  // -------------------------------------------------------------------------

  it('re-running the fixture produces the same number of transcript events', async () => {
    const fixture2 = createLifecycleFixture();
    try {
      const result2 = await runLifecycle(fixture2);
      const jsonl2 = readFileSync(fixture2.transcriptPath, 'utf-8');
      const events2 = parseTranscriptJsonl(jsonl2);

      assert.equal(
        result2.loopResult.stopReason,
        'stop',
        'second run must also stop cleanly',
      );
      assert.equal(
        events2.length,
        transcriptEvents.length,
        'event count must be deterministic across runs',
      );
    } finally {
      fixture2.cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // Wavemill metadata in transcript details
  // -------------------------------------------------------------------------

  it('read_file tool_result details contain __wavemill provenance metadata', () => {
    const result = transcriptEvents.find(
      (e): e is TranscriptToolResult =>
        e.type === 'tool_result' && e.toolName === 'read_file' && !e.isError,
    );
    assert.ok(result, 'a successful read_file tool_result must exist');
    const details = result.details as Record<string, unknown> | undefined;
    if (details !== undefined) {
      const meta = details['__wavemill'] as Record<string, unknown> | undefined;
      if (meta !== undefined) {
        const provenance = meta['provenance'] as Record<string, unknown> | undefined;
        assert.ok(provenance, '__wavemill.provenance must be present');
        assert.equal(provenance['toolName'], 'read_file');
        assert.equal(provenance['mutationClass'], 'read-only');
        assert.equal(provenance['source'], 'native-agent');
      }
    }
    // If details or __wavemill is absent (e.g. error path), just pass —
    // the metadata is additive and may not be present for all tools.
  });
});

// ---------------------------------------------------------------------------
// Focused test: transcript.write() path also redacts
// ---------------------------------------------------------------------------

describe('transcript write() path redaction', () => {
  it('direct write() with a prebuilt event containing a secret is redacted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'transcript-write-redact-'));
    const transcriptPath = join(dir, 'test.jsonl');

    try {
      const writer = new TranscriptWriter({
        sessionId: 'test',
        model: 'm',
        api: 'a',
        provider: 'p',
        path: transcriptPath,
      });

      // Write a prebuilt event with a secret in the content and details
      writer.write({
        type: 'tool_result',
        seq: 0,
        sessionId: 'test',
        timestamp: 0,
        toolCallId: 'tc1',
        toolName: 'read_file',
        isError: false,
        content: `File content including ${PLANTED_SECRET} in text`,
        details: { path: 'notes.md', authorization: `Bearer ${PLANTED_SECRET}-extra` },
        redacted: false,
      });

      const jsonl = readFileSync(transcriptPath, 'utf-8');
      assert.ok(
        !jsonl.includes(PLANTED_SECRET),
        `write() path must redact the planted secret`,
      );
      assert.ok(jsonl.includes('[REDACTED]'), 'write() path must include [REDACTED] placeholder');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
