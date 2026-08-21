import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { SCHEMA_VERSION } from '../shared/lib/eval-schema.ts';
import { computeHarnessId } from '../shared/lib/resource-manifest.ts';

function runBackfill(repoDir: string, dryRun = false): Record<string, unknown> {
  const result = spawnSync('npx', ['tsx', 'tools/backfill-harness-ids.ts', '--repo-dir', repoDir, ...(dryRun ? ['--dry-run'] : [])], {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(`backfill-harness-ids failed: ${result.stderr}\n${result.stdout}`);
  }
  const stdout = result.stdout.trim();
  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object' && 'manifests' in parsed) {
      return parsed;
    }
  } catch {
    // fall back to line-by-line scan
  }
  const candidates = stdout.split('\n').map((line) => {
    try {
      return JSON.parse(line) as Record<string, unknown>;
    } catch {
      return null;
    }
  }).filter((c): c is Record<string, unknown> => c !== null && typeof c === 'object' && 'manifests' in c);
  if (candidates.length === 0) {
    throw new Error(`No JSON summary in backfill output: ${stdout}`);
  }
  return candidates[candidates.length - 1];
}

test('backfill stamps manifests, evals, and challenge records idempotently', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'harness-backfill-'));
  try {
    const manifestsDir = resolve(tempDir, '.wavemill', 'manifests');
    const evalsDir = resolve(tempDir, '.wavemill', 'evals');
    const artifactsDir = resolve(evalsDir, 'artifacts');
    mkdirSync(manifestsDir, { recursive: true });
    mkdirSync(evalsDir, { recursive: true });
    mkdirSync(resolve(artifactsDir, 'HOK-9999'), { recursive: true });
    writeFileSync(resolve(artifactsDir, 'HOK-9999', 'initial-route.json'), '{}\n');

    const sessionId = 'backfill-session';
    const harnessId = computeHarnessId([{ id: 'prompt:test@sha256:v1', version: 'sha256:v1' }]);
    const manifest = {
      manifestSchemaVersion: '1.0.0',
      sessionId,
      workflowType: 'feature',
      createdAt: new Date().toISOString(),
      phases: {},
      resources: [{ id: 'prompt:test@sha256:v1', version: 'sha256:v1' }],
      digest: 'legacy-digest-0000',
    };
    writeFileSync(resolve(manifestsDir, `${sessionId}.json`), `${JSON.stringify(manifest, null, 2)}\n`);

    const mappedEval = {
      id: 'eval-mapped',
      schemaVersion: SCHEMA_VERSION,
      score: 0.8,
      scoreBand: 'good',
      timestamp: new Date().toISOString(),
      challengePairId: 'pair-1',
      prUrl: 'https://github.com/org/repo/pull/10',
      manifestRef: { sessionId, manifestDigest: 'legacy-digest-0000' },
    };

    const unmappedEval = {
      id: 'eval-unmapped',
      schemaVersion: SCHEMA_VERSION,
      score: 0.7,
      scoreBand: 'good',
      timestamp: new Date().toISOString(),
    };

    const primaryEval = {
      id: 'eval-primary',
      schemaVersion: SCHEMA_VERSION,
      score: 0.9,
      scoreBand: 'good',
      timestamp: new Date().toISOString(),
      challengePairId: 'pair-1',
      prUrl: 'https://github.com/org/repo/pull/10',
      harnessId,
    };

    const challengerEval = {
      id: 'eval-challenger',
      schemaVersion: SCHEMA_VERSION,
      score: 0.6,
      scoreBand: 'partial',
      timestamp: new Date().toISOString(),
      challengePairId: 'pair-1',
      prUrl: 'https://github.com/org/repo/pull/11',
      harnessId,
    };

    const challengeRecord = {
      challengePairId: 'pair-1',
      primaryModel: 'claude-sonnet-4-5',
      challengerModel: 'claude-opus-4-6',
      primaryPrUrl: primaryEval.prUrl,
      challengerPrUrl: challengerEval.prUrl,
      primaryEvalScore: primaryEval.score,
      challengerEvalScore: challengerEval.score,
      rationale: 'test record',
      dimensions: {
        completeness: { primary: 7, challenger: 8 },
        correctness: { primary: 7, challenger: 8 },
        code_quality: { primary: 7, challenger: 8 },
        intervention_impact: { primary: 7, challenger: 8 },
        autonomy: { primary: 7, challenger: 8 },
      },
      timestamp: new Date().toISOString(),
    };

    writeFileSync(resolve(evalsDir, 'evals.jsonl'), [
      JSON.stringify(mappedEval),
      JSON.stringify(unmappedEval),
      JSON.stringify(primaryEval),
      JSON.stringify(challengerEval),
    ].join('\n') + '\n');
    writeFileSync(resolve(evalsDir, 'challenge-records.jsonl'), JSON.stringify(challengeRecord) + '\n');

    const primaryBytes = readFileSync(resolve(evalsDir, 'evals.jsonl'), 'utf-8');

    const summary = runBackfill(tempDir);
    const manifestSummary = summary.manifests as Record<string, number>;
    const evalSummary = summary.evals as Record<string, number>;
    const challengeSummary = summary.challenges as Record<string, number>;
    assert.equal(manifestSummary.scanned, 1);
    assert.equal(manifestSummary.updated, 1);
    assert.equal(evalSummary.scanned, 4);
    assert.equal(evalSummary.updated, 1);
    assert.equal(evalSummary.unmapped, 1);
    assert.equal(challengeSummary.scanned, 1);
    assert.equal(challengeSummary.updated, 1);

    const updatedManifest = JSON.parse(readFileSync(resolve(manifestsDir, `${sessionId}.json`), 'utf-8')) as Record<string, unknown>;
    assert.equal(updatedManifest.harnessId, harnessId);
    assert.equal(updatedManifest.digest, 'legacy-digest-0000');

    const evalRecords = readFileSync(resolve(evalsDir, 'evals.jsonl'), 'utf-8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const mapped = evalRecords.find((r) => r.id === 'eval-mapped');
    assert.equal(mapped.harnessId, harnessId);
    const unmapped = evalRecords.find((r) => r.id === 'eval-unmapped');
    assert.equal(unmapped.harnessId, undefined);

    const challenges = readFileSync(resolve(evalsDir, 'challenge-records.jsonl'), 'utf-8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(challenges.length, 1);
    assert.equal(challenges[0].primaryHarnessId, harnessId);
    assert.equal(challenges[0].challengerHarnessId, harnessId);
    assert.equal(challenges[0].harnessId, harnessId);

    const second = runBackfill(tempDir);
    const secondManifestSummary = second.manifests as Record<string, number>;
    assert.equal(secondManifestSummary.updated, 0);
    assert.equal((second.evals as Record<string, number>).updated, 0);
    assert.equal((second.challenges as Record<string, number>).updated, 0);

    const dryRunDir = mkdtempSync(join(tmpdir(), 'harness-backfill-dry-'));
    try {
      mkdirSync(resolve(dryRunDir, '.wavemill', 'manifests'), { recursive: true });
      writeFileSync(resolve(dryRunDir, '.wavemill', 'manifests', `${sessionId}.json`), `${JSON.stringify(manifest, null, 2)}\n`);
      const drySummary = runBackfill(dryRunDir, true);
      assert.equal((drySummary.manifests as Record<string, number>).updated, 1);
      assert.equal(readFileSync(resolve(dryRunDir, '.wavemill', 'manifests', `${sessionId}.json`), 'utf-8'), `${JSON.stringify(manifest, null, 2)}\n`);
    } finally {
      rmSync(dryRunDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
