import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { clearConfigCache } from './config.ts';
import { appendJsonlRecord } from './jsonl-utils.ts';
import {
  LEGAL_TRANSITIONS,
  InvalidTransitionError,
  buildLifecycleResourceRef,
  canTransition,
  collectEvidenceForResource,
  evaluatePromotion,
  generateTransitionId,
  getCurrentState,
  listTransitionsForResource,
  promote,
  readActivePointers,
  recordTransition,
  reject,
  resolveLifecycleFiles,
  rollback,
  shouldRouteToCanary,
  validateActivePointerDocument,
  validateTransitionRecord,
  withPointerLock,
  writeActivePointersAtomic,
  type ActivePointerDocument,
} from './resource-lifecycle.ts';
import { registerResource } from './resource-registry.ts';

let tempDir: string;

const ACTOR = { kind: 'test', user: 'codex', sessionId: 'session-1' };

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'resource-lifecycle-'));
  clearConfigCache(tempDir);
});

afterEach(async () => {
  clearConfigCache(tempDir);
  await rm(tempDir, { recursive: true, force: true });
});

function createPromptResource(name: string, content: string, version?: string) {
  const resource = registerResource({
    type: 'prompt',
    name,
    content,
    version,
    uri: join(tempDir, 'tools', 'prompts', `${name}.md`),
  }, { repoDir: tempDir });
  assert.ok(resource);
  return resource;
}

function writeManifest(sessionId: string, resources: Array<{ id: string; version: string }>) {
  const manifestPath = join(tempDir, '.wavemill', 'manifests', `${sessionId}.json`);
  return mkdir(dirname(manifestPath), { recursive: true })
    .then(() => writeFile(manifestPath, JSON.stringify({ sessionId, resources }), 'utf-8'));
}

async function writeEvalRecord(sessionId: string, id: string, score: number) {
  const evalsPath = join(tempDir, '.wavemill', 'evals', 'evals.jsonl');
  await mkdir(dirname(evalsPath), { recursive: true });
  appendJsonlRecord(evalsPath, {
    id,
    timestamp: '2026-04-21T00:00:00.000Z',
    score,
    modelId: 'gpt-5.4',
    manifestRef: { sessionId, manifestDigest: `${sessionId}-digest` },
  });
}

describe('resource-lifecycle', () => {
  it('accepts and rejects transition pairs according to the matrix', () => {
    const states = ['init', 'draft', 'canary', 'stable', 'rejected', 'rolled_back'] as const;
    const targets = ['draft', 'canary', 'stable', 'rejected', 'rolled_back'] as const;
    for (const from of states) {
      for (const to of targets) {
        assert.equal(
          canTransition(from, to),
          LEGAL_TRANSITIONS[from].includes(to),
          `${from} -> ${to}`,
        );
      }
    }
  });

  it('exposes InvalidTransitionError details', () => {
    const error = new InvalidTransitionError('draft', 'rolled_back', 'prompt:test@v1');
    assert.equal(error.from, 'draft');
    assert.equal(error.to, 'rolled_back');
    assert.equal(error.resourceId, 'prompt:test@v1');
  });

  it('records and re-reads transition state', () => {
    const resource = createPromptResource('issue-writer', 'hello');
    const record = recordTransition({
      resource: buildLifecycleResourceRef(resource),
      fromState: null,
      toState: 'draft',
      actor: ACTOR,
      rationale: 'registered',
    }, tempDir);

    assert.ok(record);
    validateTransitionRecord(record!);
    assert.equal(getCurrentState('prompt', 'issue-writer', resource.version, tempDir), 'draft');
    assert.equal(listTransitionsForResource('prompt', 'issue-writer', tempDir).length, 1);
  });

  it('throws on illegal transitions', () => {
    const resource = createPromptResource('issue-writer', 'hello');
    recordTransition({
      resource: buildLifecycleResourceRef(resource),
      fromState: null,
      toState: 'draft',
      actor: ACTOR,
      rationale: 'registered',
    }, tempDir);

    assert.throws(() => {
      recordTransition({
        resource: buildLifecycleResourceRef(resource),
        fromState: 'draft',
        toState: 'rolled_back',
        actor: ACTOR,
        rationale: 'illegal',
      }, tempDir);
    }, InvalidTransitionError);
  });

  it('reads and writes active pointers atomically', async () => {
    const document: ActivePointerDocument = {
      schemaVersion: '1.0.0',
      updatedAt: '2026-04-21T00:00:00.000Z',
      entries: {
        'prompt:issue-writer': {
          stable: { id: 'prompt:issue-writer@v1', version: 'v1', updatedAt: '2026-04-21T00:00:00.000Z' },
        },
      },
    };

    validateActivePointerDocument(document);
    writeActivePointersAtomic(document, tempDir);
    const reloaded = readActivePointers(tempDir);
    assert.deepEqual(reloaded.entries['prompt:issue-writer']?.stable?.version, 'v1');
  });

  it('serializes concurrent pointer lock holders', async () => {
    const order: string[] = [];

    const first = withPointerLock(tempDir, async () => {
      order.push('first-start');
      await new Promise((resolve) => setTimeout(resolve, 60));
      order.push('first-end');
      return 'first';
    });
    const second = withPointerLock(tempDir, async () => {
      order.push('second');
      return 'second';
    });

    const results = await Promise.all([first, second]);
    assert.deepEqual(results, ['first', 'second']);
    assert.deepEqual(order, ['first-start', 'first-end', 'second']);
  });

  it('returns null when registry is disabled', async () => {
    const resource = registerResource({
      type: 'prompt',
      name: 'disabled-prompt',
      content: 'x',
      version: 'v1',
    }, { repoDir: tempDir });
    assert.ok(resource);

    await writeFile(join(tempDir, '.wavemill-config.json'), JSON.stringify({
      registry: { enabled: false },
    }), 'utf-8');
    clearConfigCache(tempDir);

    const result = recordTransition({
      resource: buildLifecycleResourceRef(resource!),
      fromState: null,
      toState: 'draft',
      actor: ACTOR,
      rationale: 'no-op',
    }, tempDir);

    assert.equal(result, null);
    assert.equal(existsSync(resolveLifecycleFiles(tempDir).transitionLog), false);
  });

  it('collects eval evidence from manifests and eval records', async () => {
    const resource = createPromptResource('issue-writer', 'v2', 'v2');
    await writeManifest('session-1', [{ id: resource.id, version: resource.version }]);
    await writeEvalRecord('session-1', 'eval-1', 0.9);
    await writeEvalRecord('session-1', 'eval-2', 0.8);

    const evidence = collectEvidenceForResource(buildLifecycleResourceRef(resource), tempDir);
    const evalEvidence = evidence.find((entry) => entry.kind === 'eval');
    assert.ok(evalEvidence);
    assert.equal(evalEvidence?.aggregate.count, 2);
    assert.ok(Math.abs((evalEvidence?.aggregate.meanScore || 0) - 0.85) < 1e-9);
  });

  it('evaluates promotion thresholds and stable hash differences', async () => {
    const stable = createPromptResource('issue-writer', 'stable', 'v1');
    const candidate = createPromptResource('issue-writer', 'candidate', 'v2');

    writeActivePointersAtomic({
      schemaVersion: '1.0.0',
      updatedAt: '2026-04-21T00:00:00.000Z',
      entries: {
        'prompt:issue-writer': {
          stable: { id: stable.id, version: stable.version, updatedAt: '2026-04-21T00:00:00.000Z' },
        },
      },
    }, tempDir);

    await writeManifest('session-1', [{ id: candidate.id, version: candidate.version }]);
    await writeEvalRecord('session-1', 'eval-1', 0.85);
    await writeEvalRecord('session-1', 'eval-2', 0.95);

    const canaryEval = evaluatePromotion(buildLifecycleResourceRef(candidate), 'canary', tempDir);
    assert.equal(canaryEval.eligible, true);

    const stableEval = evaluatePromotion(buildLifecycleResourceRef(candidate), 'stable', tempDir, {
      promotion: { minEvalRecords: 2, minMeanScore: 0.8, requireAllAboveAssisted: true, requireChallengeWin: false },
    } as any);
    assert.equal(stableEval.eligible, true);
    assert.equal(stableEval.aggregate.evalCount, 2);
  });

  it('promotes draft to canary and then stable with evidence', async () => {
    const stable = createPromptResource('issue-writer', 'stable', 'v1');
    const candidate = createPromptResource('issue-writer', 'candidate', 'v2');

    writeActivePointersAtomic({
      schemaVersion: '1.0.0',
      updatedAt: '2026-04-21T00:00:00.000Z',
      entries: {
        'prompt:issue-writer': {
          stable: { id: stable.id, version: stable.version, updatedAt: '2026-04-21T00:00:00.000Z' },
        },
      },
    }, tempDir);

    await writeManifest('session-1', [{ id: candidate.id, version: candidate.version }]);
    for (const [index, score] of [0.9, 0.85, 0.8, 0.95, 0.9].entries()) {
      await writeEvalRecord('session-1', `eval-${index}`, score);
    }

    const canaryResult = await promote(buildLifecycleResourceRef(candidate), {
      toState: 'canary',
      rationale: 'canary first',
      trafficPercent: 100,
      actor: ACTOR,
    }, tempDir);
    assert.equal(canaryResult?.pointerEntry.canary?.version, 'v2');

    const stableResult = await promote(buildLifecycleResourceRef(candidate), {
      toState: 'stable',
      rationale: 'good enough',
      actor: ACTOR,
    }, tempDir);
    assert.equal(stableResult?.pointerEntry.stable?.version, 'v2');
    assert.equal(stableResult?.pointerEntry.previousStable?.version, 'v1');
    assert.equal(readActivePointers(tempDir).entries['prompt:issue-writer']?.stable?.version, 'v2');
  });

  it('records force promotion metadata without evidence', async () => {
    const candidate = createPromptResource('issue-writer', 'candidate', 'v2');
    const result = await promote(buildLifecycleResourceRef(candidate), {
      toState: 'stable',
      rationale: 'manual override',
      actor: ACTOR,
      force: true,
    }, tempDir);

    assert.equal(result?.record.metadata?.force, true);
  });

  it('rejects and clears the active canary pointer', async () => {
    const candidate = createPromptResource('issue-writer', 'candidate', 'v2');
    recordTransition({
      resource: buildLifecycleResourceRef(candidate),
      fromState: null,
      toState: 'draft',
      actor: ACTOR,
      rationale: 'registered',
    }, tempDir);
    recordTransition({
      resource: buildLifecycleResourceRef(candidate),
      fromState: 'draft',
      toState: 'canary',
      actor: ACTOR,
      rationale: 'canary',
    }, tempDir);
    writeActivePointersAtomic({
      schemaVersion: '1.0.0',
      updatedAt: '2026-04-21T00:00:00.000Z',
      entries: {
        'prompt:issue-writer': {
          canary: { id: candidate.id, version: candidate.version, updatedAt: '2026-04-21T00:00:00.000Z', trafficPercent: 25 },
        },
      },
    }, tempDir);

    const result = await reject(buildLifecycleResourceRef(candidate), {
      rationale: 'bad signal',
      actor: ACTOR,
    }, tempDir);

    assert.equal(result?.pointerEntry.canary, undefined);
  });

  it('rolls back to the previous stable version', async () => {
    const stable = createPromptResource('issue-writer', 'stable', 'v1');
    const candidate = createPromptResource('issue-writer', 'candidate', 'v2');
    writeActivePointersAtomic({
      schemaVersion: '1.0.0',
      updatedAt: '2026-04-21T00:00:00.000Z',
      entries: {
        'prompt:issue-writer': {
          stable: { id: candidate.id, version: candidate.version, updatedAt: '2026-04-21T00:00:00.000Z' },
          previousStable: { id: stable.id, version: stable.version, updatedAt: '2026-04-20T00:00:00.000Z' },
        },
      },
    }, tempDir);

    const result = await rollback('prompt', 'issue-writer', {
      rationale: 'restore previous',
      actor: ACTOR,
    }, tempDir);

    assert.equal(result?.pointerEntry.stable?.version, 'v1');
    assert.equal(result?.rolledBack.toState, 'rolled_back');
    assert.equal(result?.restored.toState, 'stable');
  });

  it('uses canary routing percentages deterministically', () => {
    assert.equal(shouldRouteToCanary({ canary: { id: 'x', version: '1', trafficPercent: 0 } }, 'session'), false);
    assert.equal(shouldRouteToCanary({ canary: { id: 'x', version: '1', trafficPercent: 100 } }, 'session'), true);
  });

  it('writes validated transition records to lifecycle log', async () => {
    const resource = createPromptResource('issue-writer', 'hello', 'v1');
    const record = recordTransition({
      resource: buildLifecycleResourceRef(resource),
      fromState: null,
      toState: 'draft',
      actor: ACTOR,
      rationale: 'registered',
      transitionId: generateTransitionId(),
    }, tempDir);
    const content = await readFile(resolveLifecycleFiles(tempDir).transitionLog, 'utf-8');

    assert.ok(content.includes(record!.transitionId));
  });
});
