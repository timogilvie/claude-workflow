import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path, { dirname, join } from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { ReviewResult } from '../../review-runner.ts';
import type { RouteBatchOptions, RouteBatchResult } from '../../route-batch.ts';
import { createInMemoryDedupeRegistry } from './dedupe.ts';
import {
  createCommandTools,
  createDefaultExpander,
  executeReviewChanges,
  executeRouteTask,
  executeWriteStageResult,
  type CommandToolsDeps,
} from './command-tools.ts';
import type {
  WorkflowToolStageArtifactEntry,
  WorkflowToolTranscriptEvent,
} from './linear-tools.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, 'fixtures', 'commands');

function loadFixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as T;
}

function loadFixtureText(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

function makeTempDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'workflow-command-tools-'));
}

function makeDeps(overrides: Partial<CommandToolsDeps> = {}): CommandToolsDeps & {
  transcriptEvents: WorkflowToolTranscriptEvent[];
  stageArtifactEntries: WorkflowToolStageArtifactEntry[];
} {
  const transcriptEvents: WorkflowToolTranscriptEvent[] = [];
  const stageArtifactEntries: WorkflowToolStageArtifactEntry[] = [];

  return {
    registry: overrides.registry ?? createInMemoryDedupeRegistry({ clock: () => 1_000 }),
    transcript: { append(event) { transcriptEvents.push(event); } },
    stageArtifact: { append(entry) { stageArtifactEntries.push(entry); } },
    sessionId: overrides.sessionId ?? 'sess-test-1',
    phase: overrides.phase ?? 'coding',
    repoDir: overrides.repoDir ?? process.cwd(),
    clock: overrides.clock ?? (() => 1_000),
    agentName: overrides.agentName,
    modelName: overrides.modelName,
    expander: overrides.expander,
    reviewChangesImpl: overrides.reviewChangesImpl,
    routeBatchImpl: overrides.routeBatchImpl,
    readFileImpl: overrides.readFileImpl,
    readStageResultImpl: overrides.readStageResultImpl,
    writeStageResultImpl: overrides.writeStageResultImpl,
    updateStageResultImpl: overrides.updateStageResultImpl,
    transcriptEvents,
    stageArtifactEntries,
  };
}

let tempDirs: string[] = [];

beforeEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe('executeReviewChanges', () => {
  it('returns structured counts and transcript metadata on success', async () => {
    const reviewResult = loadFixture<ReviewResult>('review-success.json');
    const deps = makeDeps({
      phase: 'review',
      reviewChangesImpl: async () => reviewResult,
    });

    const result = await executeReviewChanges({ base: 'auto/integration', json: true }, deps);
    assert.ok(result.ok);
    assert.equal(result.tool, 'review_changes');
    assert.equal(result.findingCount, 3);
    assert.equal(result.blockingCount, 1);

    const event = deps.transcriptEvents[0];
    assert.equal(event.tool, 'review_changes');
    assert.equal((event.details as { invocation: { base: string } }).invocation.base, 'auto/integration');
    assert.equal((event.details as { diagnostics: { verdict: string } }).diagnostics.verdict, 'not_ready');
  });

  it('returns review_failed and records diagnostics on failure', async () => {
    const failure = loadFixture<{ message: string }>('review-failure.json');
    const deps = makeDeps({
      phase: 'review',
      reviewChangesImpl: async () => {
        throw new Error(failure.message);
      },
    });

    const result = await executeReviewChanges({ base: 'auto/integration' }, deps);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'review_failed');
    assert.match(result.message, /review delegate exploded/);
    assert.equal((deps.transcriptEvents[0].details as { diagnostics: { error: string } }).diagnostics.error, 'review_failed');
  });

  it('denies review_changes outside review phase', async () => {
    const deps = makeDeps({ phase: 'coding' });
    const result = await executeReviewChanges({ base: 'auto/integration' }, deps);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'policy_denied');
  });

  it('succeeds on retry after a transient failure', async () => {
    const reviewResult = loadFixture<ReviewResult>('review-success.json');
    let attempts = 0;
    const deps = makeDeps({
      phase: 'review',
      reviewChangesImpl: async () => {
        attempts++;
        if (attempts === 1) {
          throw new Error('transient review failure');
        }
        return reviewResult;
      },
    });

    const first = await executeReviewChanges({ base: 'auto/integration' }, deps);
    const second = await executeReviewChanges({ base: 'auto/integration' }, deps);
    assert.equal(first.ok, false);
    assert.ok(second.ok);
    assert.equal(deps.transcriptEvents.length, 2);
  });
});

describe('executeRouteTask', () => {
  it('maps route decisions into the contract shape and records metadata', async () => {
    const repoDir = makeTempDir();
    tempDirs.push(repoDir);
    const taskPacketPath = join(repoDir, 'task-packet.md');
    writeFileSync(taskPacketPath, loadFixtureText('task-packet.md'));
    const decision = loadFixture<RouteBatchResult['decision']>('route-decision.json');
    let capturedOptions: RouteBatchOptions | undefined;
    const deps = makeDeps({
      phase: 'planning',
      repoDir,
      routeBatchImpl: async (_tasks, options) => {
        capturedOptions = options;
        return [{ task: { prompt: 'x' }, decision }];
      },
    });

    const result = await executeRouteTask({
      taskPacketPath,
      repoDir,
      routeMode: 'stage-aware',
      modelsAvailable: ['gpt-5.5', 'claude-sonnet-4-6'],
    }, deps);
    assert.ok(result.ok);
    assert.equal(result.route.model, 'openai/gpt-5-codex');
    assert.equal(result.route.mode, 'stage-aware');
    assert.match(result.route.rationale ?? '', /runtime wiring/);
    assert.deepEqual(capturedOptions?.modelsAvailable, ['gpt-5.5', 'claude-sonnet-4-6']);
    assert.equal((deps.transcriptEvents[0].details as { diagnostics: { routeDecision: { coder: string } } }).diagnostics.routeDecision.coder, 'openai/gpt-5-codex');
  });

  it('returns io_error when the task packet cannot be read', async () => {
    const deps = makeDeps({ phase: 'planning' });
    const result = await executeRouteTask({ taskPacketPath: '/missing/task-packet.md' }, deps);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'io_error');
  });

  it('returns route_failed when the router throws and succeeds on retry', async () => {
    const repoDir = makeTempDir();
    tempDirs.push(repoDir);
    const taskPacketPath = join(repoDir, 'task-packet.md');
    writeFileSync(taskPacketPath, loadFixtureText('task-packet.md'));
    const decision = loadFixture<RouteBatchResult['decision']>('route-decision.json');
    let attempts = 0;
    const deps = makeDeps({
      phase: 'planning',
      repoDir,
      routeBatchImpl: async () => {
        attempts++;
        if (attempts === 1) {
          throw new Error('router unavailable');
        }
        return [{ task: { prompt: 'x' }, decision }];
      },
    });

    const first = await executeRouteTask({ taskPacketPath, repoDir }, deps);
    const second = await executeRouteTask({ taskPacketPath, repoDir }, deps);
    assert.equal(first.ok, false);
    assert.equal(first.error, 'route_failed');
    assert.ok(second.ok);
  });
});

describe('executeWriteStageResult', () => {
  it('creates, reuses, and updates the same stage-result artifact idempotently', async () => {
    const featureDir = makeTempDir();
    tempDirs.push(featureDir);
    const registry = createInMemoryDedupeRegistry({ clock: () => 1_000 });
    const initial = loadFixture<Record<string, unknown>>('stage-result-initial.json');
    const updated = loadFixture<Record<string, unknown>>('stage-result-updated.json');
    initial.featureDir = featureDir;
    updated.featureDir = featureDir;

    const deps = makeDeps({ phase: 'coding', registry });
    const created = await executeWriteStageResult(initial as never, deps);
    const reused = await executeWriteStageResult(initial as never, deps);
    const changed = await executeWriteStageResult(updated as never, deps);

    assert.ok(created.ok && created.idempotency.outcome === 'created');
    assert.ok(reused.ok && reused.idempotency.outcome === 'reused');
    assert.ok(changed.ok && changed.idempotency.outcome === 'updated');
    assert.equal(deps.stageArtifactEntries.length, 3);

    const stored = JSON.parse(readFileSync(join(featureDir, '.coding-result.json'), 'utf8')) as { notes: string };
    assert.match(stored.notes, /transcript metadata/);
  });

  it('records transcript and stage-artifact diagnostics on writer failure', async () => {
    const featureDir = makeTempDir();
    tempDirs.push(featureDir);
    const initial = loadFixture<Record<string, unknown>>('stage-result-initial.json');
    initial.featureDir = featureDir;
    const deps = makeDeps({
      phase: 'coding',
      writeStageResultImpl: async () => {
        throw new Error('disk full');
      },
    });

    const result = await executeWriteStageResult(initial as never, deps);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'io_error');
    assert.equal(deps.transcriptEvents.length, 1);
    assert.equal(deps.stageArtifactEntries.length, 1);
    assert.equal((deps.stageArtifactEntries[0].details as { diagnostics: { error: string } }).diagnostics.error, 'io_error');
  });

  it('succeeds on retry after a failed write without polluting the dedupe registry', async () => {
    const featureDir = makeTempDir();
    tempDirs.push(featureDir);
    const initial = loadFixture<Record<string, unknown>>('stage-result-initial.json');
    initial.featureDir = featureDir;
    const registry = createInMemoryDedupeRegistry({ clock: () => 1_000 });
    let attempts = 0;
    const deps = makeDeps({
      phase: 'coding',
      registry,
      writeStageResultImpl: async (dir, result) => {
        attempts++;
        if (attempts === 1) {
          throw new Error('transient fs error');
        }
        writeFileSync(join(dir, `.${result.stage}-result.json`), `${JSON.stringify(result, null, 2)}\n`);
      },
    });

    const first = await executeWriteStageResult(initial as never, deps);
    const second = await executeWriteStageResult(initial as never, deps);
    assert.equal(first.ok, false);
    assert.ok(second.ok);
    assert.ok(second.ok && second.idempotency.outcome === 'created');
    assert.equal(registry.size(), 1);
  });
});

describe('factories', () => {
  it('createCommandTools exposes expandIssue through the same wrapper surface', async () => {
    const deps = makeDeps({
      phase: 'planning',
      expander: async () => '/tmp/task-packet.md',
    });

    const tools = createCommandTools(deps);
    const result = await tools.expandIssue({ issue: 'HOK-2358' });
    assert.ok(result.ok);
    assert.equal(result.taskPacketPath, '/tmp/task-packet.md');
  });

  it('createDefaultExpander writes task packet artifacts via injected business functions', async () => {
    const repoDir = makeTempDir();
    const outputDir = makeTempDir();
    tempDirs.push(repoDir, outputDir);

    const expander = createDefaultExpander({
      repoDir,
      getIssueContext: async () => ({
        identifier: 'HOK-2358',
        title: 'Wrap command tools',
        description: 'Expand the workflow tools.',
      }),
      loadPromptTemplateImpl: async () => 'prompt',
      gatherCodebaseContextImpl: async () => 'context',
      getOperatingModeImpl: () => 'normal',
      expandIssueImpl: async () => ({
        text: '# Header\n\n<!-- SPLIT: HEADER ABOVE, DETAILS BELOW -->\n\n## Details',
      }),
    });

    const taskPacketPath = await expander({ issue: 'HOK-2358', outputDir }, { sessionId: 'sess-1', phase: 'planning' });
    assert.equal(taskPacketPath, join(outputDir, 'task-packet.md'));
    assert.equal(readFileSync(taskPacketPath, 'utf8').includes('## Details'), true);
    assert.equal(readFileSync(join(outputDir, 'task-packet-header.md'), 'utf8').includes('# Header'), true);
  });
});
