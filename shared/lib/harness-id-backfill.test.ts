import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { backfillHarnessIds } from './harness-id-backfill.ts';
import { computeHarnessId, resolveManifestPath } from './resource-manifest.ts';

function makeRepo(): string {
  const repoDir = mkdtempSync(join(tmpdir(), 'harness-backfill-'));
  mkdirSync(join(repoDir, '.wavemill', 'manifests'), { recursive: true });
  mkdirSync(join(repoDir, '.wavemill', 'evals'), { recursive: true });
  return repoDir;
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function readJsonl(path: string): any[] {
  const records: any[] = [];
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // Malformed JSONL lines are intentionally preserved by the backfill.
    }
  }
  return records;
}

test('backfillHarnessIds stamps manifests, evals, and uniquely mapped challenge arms', () => {
  const repoDir = makeRepo();
  try {
    const promptRef = { id: 'prompt:main@sha256:prompt', version: 'sha256:prompt' };
    const harnessId = computeHarnessId([promptRef]);
    const manifest = {
      manifestSchemaVersion: '1.0.0',
      sessionId: 'session-1',
      workflowType: 'feature',
      createdAt: '2026-08-21T00:00:00.000Z',
      phases: { coding: [promptRef] },
      resources: [promptRef],
      digest: 'closed-digest',
    };
    writeFileSync(resolveManifestPath('session-1', repoDir), `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
    writeFileSync(join(repoDir, '.wavemill', 'manifests', 'bad.json'), '{bad json\n', 'utf-8');

    const evalsPath = join(repoDir, '.wavemill', 'evals', 'evals.jsonl');
    writeFileSync(evalsPath, [
      JSON.stringify({ id: 'eval-1', prUrl: 'https://github.com/org/repo/pull/1', manifestRef: { sessionId: 'session-1', manifestDigest: 'closed-digest' } }),
      JSON.stringify({ id: 'eval-2', prUrl: 'https://github.com/org/repo/pull/2', harnessId: 'b'.repeat(64) }),
      JSON.stringify({ id: 'eval-3', prUrl: 'https://github.com/org/repo/pull/3', harnessId: 'c'.repeat(64) }),
      JSON.stringify({ id: 'eval-4', prUrl: 'https://github.com/org/repo/pull/3', harnessId: 'd'.repeat(64) }),
      JSON.stringify({ id: 'eval-unmapped' }),
      '{bad json',
      '',
    ].join('\n'), 'utf-8');

    const challengesPath = join(repoDir, '.wavemill', 'evals', 'challenge-records.jsonl');
    writeFileSync(challengesPath, [
      JSON.stringify({
        challengePairId: 'pair-1',
        primaryModel: 'a',
        challengerModel: 'b',
        primaryPrUrl: 'https://github.com/org/repo/pull/1',
        challengerPrUrl: 'https://github.com/org/repo/pull/2',
        primaryEvalScore: 0.8,
        challengerEvalScore: 0.9,
        rationale: 'ok',
        dimensions: {},
        timestamp: '2026-08-21T00:00:00.000Z',
      }),
      JSON.stringify({
        challengePairId: 'pair-2',
        primaryModel: 'a',
        challengerModel: 'b',
        primaryPrUrl: 'https://github.com/org/repo/pull/3',
        challengerPrUrl: 'https://github.com/org/repo/pull/missing',
        primaryEvalScore: 0.8,
        challengerEvalScore: 0.9,
        rationale: 'ok',
        dimensions: {},
        timestamp: '2026-08-21T00:00:00.000Z',
      }),
      '',
    ].join('\n'), 'utf-8');

    const summary = backfillHarnessIds({ repoDir });
    assert.equal(summary.manifests.processed, 2);
    assert.equal(summary.manifests.changed, 1);
    assert.equal(summary.manifests.malformed, 1);
    assert.equal(summary.evals.changed, 1);
    assert.equal(summary.evals.unmapped, 1);
    assert.equal(summary.challenges.changed, 1);
    assert.equal(summary.challenges.unmapped, 2);
    assert.equal(summary.routeArtifacts.skipped, 1);

    const updatedManifest = readJson(resolveManifestPath('session-1', repoDir));
    assert.equal(updatedManifest.harnessId, harnessId);
    assert.equal(updatedManifest.digest, 'closed-digest');

    const evals = readJsonl(evalsPath);
    assert.equal(evals[0].harnessId, harnessId);
    const challenges = readJsonl(challengesPath);
    assert.equal(challenges[0].primaryHarnessId, harnessId);
    assert.equal(challenges[0].challengerHarnessId, 'b'.repeat(64));
    assert.equal(challenges[1].primaryHarnessId, undefined);
    assert.equal(challenges[1].challengerHarnessId, undefined);

    const second = backfillHarnessIds({ repoDir });
    assert.equal(second.manifests.changed, 0);
    assert.equal(second.evals.changed, 0);
    assert.equal(second.challenges.changed, 0);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('backfillHarnessIds dry-run does not write files', () => {
  const repoDir = makeRepo();
  try {
    const ref = { id: 'prompt:dry@sha256:dry', version: 'sha256:dry' };
    const manifestPath = resolveManifestPath('dry-session', repoDir);
    writeFileSync(manifestPath, `${JSON.stringify({
      manifestSchemaVersion: '1.0.0',
      sessionId: 'dry-session',
      workflowType: 'feature',
      createdAt: '2026-08-21T00:00:00.000Z',
      phases: { coding: [ref] },
      resources: [ref],
      digest: '',
    })}\n`, 'utf-8');
    const before = readFileSync(manifestPath, 'utf-8');
    const summary = backfillHarnessIds({ repoDir, dryRun: true });
    assert.equal(summary.manifests.changed, 1);
    assert.equal(readFileSync(manifestPath, 'utf-8'), before);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});
