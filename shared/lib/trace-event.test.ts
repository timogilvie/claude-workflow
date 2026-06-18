/**
 * Tests for trace-event.ts (HOK-2259)
 *
 * Covers: generateTraceId, loadTraceContext, saveTraceContext,
 *         resolveTraceContext, appendTraceEvent, appendTraceEventSync,
 *         archiveTraceFile, and attachTraceId from eval-record-builder.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  generateTraceId,
  loadTraceContext,
  saveTraceContext,
  resolveTraceContext,
  appendTraceEvent,
  appendTraceEventSync,
  archiveTraceFile,
  getTraceFilePath,
  getTraceContextPath,
  TRACE_SCHEMA_VERSION,
  type TraceContext,
  type TraceEvent,
} from './trace-event.ts';
import { attachTraceId } from './eval-record-builder.ts';

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

async function makeTmpDir(label: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `trace-${label}-`));
}

function readJsonlLines(filePath: string): TraceEvent[] {
  const raw = fsSync.readFileSync(filePath, 'utf-8');
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TraceEvent);
}

// ────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────

describe('generateTraceId', () => {
  it('produces a string with the trc_ prefix', () => {
    const id = generateTraceId();
    assert.ok(id.startsWith('trc_'), `expected trc_ prefix, got: ${id}`);
  });

  it('matches trc_<8-hex>_<16-hex> format', () => {
    const id = generateTraceId();
    assert.match(id, /^trc_[0-9a-f]{8}_[0-9a-f]{16}$/);
  });

  it('generates unique IDs on successive calls', () => {
    const ids = new Set(Array.from({ length: 10 }, () => generateTraceId()));
    assert.equal(ids.size, 10);
  });
});

describe('loadTraceContext', () => {
  it('returns null for a directory with no .trace-context.json', async () => {
    const dir = await makeTmpDir('missing');
    assert.equal(loadTraceContext(dir), null);
  });

  it('returns null for a non-existent directory', () => {
    assert.equal(loadTraceContext('/nonexistent/path/9999'), null);
  });

  it('returns null for malformed JSON', async () => {
    const dir = await makeTmpDir('bad-json');
    await fs.writeFile(path.join(dir, '.trace-context.json'), '{bad json}', 'utf-8');
    assert.equal(loadTraceContext(dir), null);
  });

  it('returns null when required fields are missing', async () => {
    const dir = await makeTmpDir('missing-fields');
    await fs.writeFile(
      path.join(dir, '.trace-context.json'),
      JSON.stringify({ schemaVersion: '1.0' }),
      'utf-8',
    );
    assert.equal(loadTraceContext(dir), null);
  });
});

describe('saveTraceContext / loadTraceContext round-trip', () => {
  it('saves and loads context correctly', async () => {
    const dir = await makeTmpDir('save-load');
    const ctx: TraceContext = {
      traceId: generateTraceId(),
      issueId: 'HOK-9999',
      slug: 'test-feature',
      featureDir: dir,
    };

    await saveTraceContext(ctx);

    const loaded = loadTraceContext(dir);
    assert.notEqual(loaded, null);
    assert.equal(loaded!.traceId, ctx.traceId);
    assert.equal(loaded!.issueId, ctx.issueId);
    assert.equal(loaded!.slug, ctx.slug);
    assert.equal(loaded!.featureDir, dir);
  });

  it('writes atomically (context file is well-formed JSON)', async () => {
    const dir = await makeTmpDir('atomic-write');
    const ctx: TraceContext = {
      traceId: 'trc_00000001_0102030405060708',
      issueId: 'HOK-1',
      slug: 'a',
      featureDir: dir,
    };
    await saveTraceContext(ctx);

    const raw = fsSync.readFileSync(getTraceContextPath(dir), 'utf-8');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.traceId, ctx.traceId);
    assert.equal(parsed.schemaVersion, TRACE_SCHEMA_VERSION);
    assert.ok(parsed.createdAt, 'createdAt should be present');
  });
});

describe('resolveTraceContext', () => {
  it('creates a new context when none exists', async () => {
    const dir = await makeTmpDir('resolve-new');
    const ctx = await resolveTraceContext(dir, 'HOK-100', 'my-feature');
    assert.ok(ctx.traceId.startsWith('trc_'));
    assert.equal(ctx.issueId, 'HOK-100');
    assert.equal(ctx.slug, 'my-feature');
  });

  it('returns the same traceId on a second call (idempotent)', async () => {
    const dir = await makeTmpDir('resolve-idem');
    const ctx1 = await resolveTraceContext(dir, 'HOK-101', 'idem-feature');
    const ctx2 = await resolveTraceContext(dir, 'HOK-101', 'idem-feature');
    assert.equal(ctx1.traceId, ctx2.traceId);
  });

  it('creates a new traceId when issueId changes', async () => {
    const dir = await makeTmpDir('resolve-changed');
    const ctx1 = await resolveTraceContext(dir, 'HOK-200', 'feature');
    const ctx2 = await resolveTraceContext(dir, 'HOK-201', 'feature');
    assert.notEqual(ctx1.traceId, ctx2.traceId);
  });
});

describe('appendTraceEvent', () => {
  it('appends a valid JSONL line to trace.jsonl', async () => {
    const dir = await makeTmpDir('append');
    const ctx: TraceContext = {
      traceId: 'trc_00000001_aabbccdd00112233',
      issueId: 'HOK-500',
      slug: 'append-test',
      featureDir: dir,
    };

    await appendTraceEvent(ctx, { phase: 'launch', event: 'task_launched', status: 'ok' });

    const tracePath = getTraceFilePath(dir);
    assert.ok(fsSync.existsSync(tracePath), 'trace.jsonl should exist');
    const lines = readJsonlLines(tracePath);
    assert.equal(lines.length, 1);

    const event = lines[0];
    assert.equal(event.traceId, ctx.traceId);
    assert.equal(event.issueId, ctx.issueId);
    assert.equal(event.slug, ctx.slug);
    assert.equal(event.phase, 'launch');
    assert.equal(event.event, 'task_launched');
    assert.equal(event.status, 'ok');
    assert.equal(event.schemaVersion, TRACE_SCHEMA_VERSION);
    assert.ok(event.timestamp, 'timestamp should be present');
  });

  it('appends multiple events in order', async () => {
    const dir = await makeTmpDir('multi-append');
    const ctx: TraceContext = {
      traceId: generateTraceId(),
      issueId: 'HOK-600',
      slug: 'multi',
      featureDir: dir,
    };

    await appendTraceEvent(ctx, { phase: 'planning', event: 'phase_started', status: 'ok' });
    await appendTraceEvent(ctx, { phase: 'coding', event: 'phase_started', status: 'ok' });
    await appendTraceEvent(ctx, { phase: 'coding', event: 'phase_completed', status: 'ok' });

    const lines = readJsonlLines(getTraceFilePath(dir));
    assert.equal(lines.length, 3);
    assert.equal(lines[0].event, 'phase_started');
    assert.equal(lines[0].phase, 'planning');
    assert.equal(lines[1].event, 'phase_started');
    assert.equal(lines[1].phase, 'coding');
    assert.equal(lines[2].event, 'phase_completed');
  });

  it('is best-effort: does not throw when featureDir is invalid', async () => {
    const ctx: TraceContext = {
      traceId: 'trc_00000000_0000000000000000',
      issueId: 'HOK-0',
      slug: 'noop',
      featureDir: '/nonexistent/path/to/feature',
    };
    await assert.doesNotReject(() =>
      appendTraceEvent(ctx, { phase: 'launch', event: 'task_launched' }),
    );
  });

  it('includes optional meta in the event', async () => {
    const dir = await makeTmpDir('meta');
    const ctx: TraceContext = {
      traceId: generateTraceId(),
      issueId: 'HOK-700',
      slug: 'meta-test',
      featureDir: dir,
    };

    await appendTraceEvent(ctx, {
      phase: 'eval',
      event: 'eval_recorded',
      status: 'ok',
      meta: { score: 0.85, evalId: 'eval-abc' },
    });

    const lines = readJsonlLines(getTraceFilePath(dir));
    assert.equal(lines[0].meta?.score, 0.85);
    assert.equal(lines[0].meta?.evalId, 'eval-abc');
  });
});

describe('appendTraceEventSync', () => {
  it('appends synchronously without throwing', async () => {
    const dir = await makeTmpDir('sync-append');
    const ctx: TraceContext = {
      traceId: generateTraceId(),
      issueId: 'HOK-800',
      slug: 'sync-test',
      featureDir: dir,
    };

    appendTraceEventSync(ctx, { phase: 'launch', event: 'route_assigned', status: 'ok' });

    const lines = readJsonlLines(getTraceFilePath(dir));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].event, 'route_assigned');
  });

  it('is best-effort: does not throw for invalid path', () => {
    const ctx: TraceContext = {
      traceId: 'trc_00000000_0000000000000000',
      issueId: 'HOK-0',
      slug: 'noop',
      featureDir: '/nonexistent/path',
    };
    assert.doesNotThrow(() =>
      appendTraceEventSync(ctx, { phase: 'launch', event: 'task_launched' }),
    );
  });
});

describe('archiveTraceFile', () => {
  it('copies trace.jsonl to archive directory', async () => {
    const src = await makeTmpDir('archive-src');
    const dst = await makeTmpDir('archive-dst');
    const ctx: TraceContext = {
      traceId: generateTraceId(),
      issueId: 'HOK-900',
      slug: 'archive-test',
      featureDir: src,
    };

    await appendTraceEvent(ctx, { phase: 'cleanup', event: 'cleanup_archived', status: 'ok' });

    const ok = await archiveTraceFile(src, dst);
    assert.ok(ok, 'archiveTraceFile should return true');
    assert.ok(fsSync.existsSync(path.join(dst, 'trace.jsonl')), 'archived trace.jsonl should exist');

    const srcLines = readJsonlLines(getTraceFilePath(src));
    const dstLines = readJsonlLines(path.join(dst, 'trace.jsonl'));
    assert.deepEqual(srcLines.length, dstLines.length);
  });

  it('returns false when source trace.jsonl does not exist', async () => {
    const src = await makeTmpDir('no-trace-src');
    const dst = await makeTmpDir('no-trace-dst');
    const ok = await archiveTraceFile(src, dst);
    assert.equal(ok, false);
  });

  it('is best-effort: returns false for invalid paths', async () => {
    const ok = await archiveTraceFile('/nonexistent/src', '/nonexistent/dst');
    assert.equal(ok, false);
  });
});

describe('lifecycle: traceId persists across resolve and append', () => {
  it('traceId is stable across multiple resolveTraceContext and appendTraceEvent calls', async () => {
    const dir = await makeTmpDir('lifecycle');
    const issueId = 'HOK-1234';
    const slug = 'lifecycle-feature';

    // First resolve creates the trace context
    const ctx1 = await resolveTraceContext(dir, issueId, slug);
    await appendTraceEvent(ctx1, { phase: 'launch', event: 'task_launched', status: 'ok' });

    // Simulate reroute: second resolve should reuse same traceId
    const ctx2 = await resolveTraceContext(dir, issueId, slug);
    await appendTraceEvent(ctx2, { phase: 'coding', event: 'route_assigned', status: 'ok' });

    assert.equal(ctx1.traceId, ctx2.traceId, 'traceId must be stable across resolves');

    const lines = readJsonlLines(getTraceFilePath(dir));
    assert.equal(lines.length, 2);
    assert.ok(lines.every((l) => l.traceId === ctx1.traceId), 'all events share same traceId');
  });

  it('archiving includes all events written before and after cleanup_archived', async () => {
    const dir = await makeTmpDir('lifecycle-archive');
    const archiveDir = await makeTmpDir('lifecycle-archive-dst');
    const ctx = await resolveTraceContext(dir, 'HOK-5555', 'archive-lifecycle');

    await appendTraceEvent(ctx, { phase: 'launch', event: 'task_launched', status: 'ok' });
    await appendTraceEvent(ctx, { phase: 'coding', event: 'phase_completed', status: 'ok' });
    await archiveTraceFile(dir, archiveDir);
    await appendTraceEvent(ctx, { phase: 'cleanup', event: 'cleanup_archived', status: 'ok' });
    await archiveTraceFile(dir, archiveDir);

    const archived = readJsonlLines(path.join(archiveDir, 'trace.jsonl'));
    assert.equal(archived.length, 3, 'archive should include all 3 events after final copy');
    assert.equal(archived[2].event, 'cleanup_archived');
  });
});

describe('attachTraceId from eval-record-builder', () => {
  it('sets traceId on an eval record', () => {
    const record = { id: 'test', schemaVersion: '1.0' } as Parameters<typeof attachTraceId>[0];
    attachTraceId(record, 'trc_00aabbcc_0011223344556677');
    assert.equal((record as Record<string, unknown>).traceId, 'trc_00aabbcc_0011223344556677');
  });

  it('does not set traceId for empty string', () => {
    const record = { id: 'test', schemaVersion: '1.0' } as Parameters<typeof attachTraceId>[0];
    attachTraceId(record, '');
    assert.equal((record as Record<string, unknown>).traceId, undefined);
  });

  it('does not set traceId for null or undefined', () => {
    const record = { id: 'test', schemaVersion: '1.0' } as Parameters<typeof attachTraceId>[0];
    attachTraceId(record, null);
    assert.equal((record as Record<string, unknown>).traceId, undefined);
    attachTraceId(record, undefined);
    assert.equal((record as Record<string, unknown>).traceId, undefined);
  });

  it('trims whitespace before setting', () => {
    const record = { id: 'test', schemaVersion: '1.0' } as Parameters<typeof attachTraceId>[0];
    attachTraceId(record, '  trc_00aabbcc_0011223344556677  ');
    assert.equal((record as Record<string, unknown>).traceId, 'trc_00aabbcc_0011223344556677');
  });
});
