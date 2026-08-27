import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  applyModelPromotion,
  planModelPromotion,
  rollbackModelPromotion,
  type ModelTransitionSpec,
} from './model-promotion.ts';
import { computeIdentityFingerprint } from './model-registry.ts';

function makeRepo(): string {
  const repoDir = mkdtempSync(join(tmpdir(), 'model-promotion-test-'));
  mkdirSync(join(repoDir, 'shared', 'fixtures'), { recursive: true });
  mkdirSync(join(repoDir, '.wavemill', 'evals'), { recursive: true });
  writeFileSync(join(repoDir, 'shared', 'fixtures', 'model-registry.v1.json'), `${JSON.stringify(makeCatalog(), null, 2)}\n`);
  writeFileSync(join(repoDir, '.wavemill', 'evals', 'evals.jsonl'), `${JSON.stringify(makeEvalRecord())}\n`);
  writeFileSync(join(repoDir, '.wavemill', 'routing.json'), `${JSON.stringify({
    planner: 'ox-alpha',
    coder: 'ox-alpha',
    reviewer: 'other-model',
    note: 'free text ox-alpha must remain untouched',
  }, null, 2)}\n`);
  return repoDir;
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

function spec(): ModelTransitionSpec {
  return {
    schemaVersion: '1',
    promotionId: 'hok-2863-test',
    provisional: {
      alias: 'ox-alpha',
      providerNativeId: 'stealth/ox-alpha',
      identityRevision: 1,
    },
    final: {
      alias: 'gpt-9-test',
      provider: 'openrouter',
      providerNativeId: 'openai/gpt-9-test',
      identityRevision: 2,
      displayName: 'GPT 9 Test',
      family: 'gpt',
      pricingRevision: 'catalog-2026-08-24',
      pricing: {
        inputCostPerMTok: 2,
        outputCostPerMTok: 10,
        cacheWriteCostPerMTok: 3,
        cacheReadCostPerMTok: 0.5,
      },
      verification: {
        source: 'fixture',
        observedAt: '2026-08-24T00:00:00.000Z',
        catalogHash: 'fixture-hash',
      },
      capabilities: {
        qualityScores: {
          routing: 10,
          planning: 10,
          coding: 10,
          review: 10,
          classify: 10,
        },
      },
    },
    disclosure: {
      disclosedAt: '2026-08-24T00:00:00.000Z',
      source: 'fixture',
    },
  };
}

function makeCapabilities(alias: string, status: 'provisional' | 'verified') {
  return {
    vendor: status === 'provisional' ? 'unknown' : 'openai',
    class: 'strong_generalist',
    strengths: ['test'],
    weaknesses: status === 'provisional' ? ['provisional stealth identity'] : [],
    qualityScores: {
      routing: 0,
      planning: 0,
      coding: 0,
      review: 0,
      classify: 0,
    },
    pricing: {
      inputCostPerMTok: 0,
      outputCostPerMTok: 0,
    },
    defaultLadderEligible: false,
    contextWindowTokens: 128000,
    toolSupport: 'full',
    multimodal: {
      text: true,
      image: false,
    },
    latencyTier: 'standard',
    reasoningTier: 'advanced',
    costPerMillionInputTokensUsd: 0,
    costPerMillionOutputTokensUsd: 0,
    supportedModel: {
      wavemillAlias: alias,
      providerNativeId: 'stealth/ox-alpha',
      provider: 'openrouter',
      routingEligible: false,
      launchEligible: true,
    },
    identity: {
      status,
      revision: 1,
      fingerprint: computeIdentityFingerprint({
        alias,
        providerNativeId: 'stealth/ox-alpha',
        provider: 'openrouter',
        revision: 1,
      }),
      displayName: 'Ox Alpha',
      family: status === 'provisional' ? 'unknown' : 'gpt',
      evidencePolicy: 'held',
    },
  };
}

function makeCatalog() {
  return {
    schemaVersion: '1',
    models: [
      {
        id: 'ox-alpha',
        capabilities: makeCapabilities('ox-alpha', 'provisional'),
      },
      {
        id: 'other-model',
        capabilities: {
          ...makeCapabilities('other-model', 'verified'),
          supportedModel: {
            wavemillAlias: 'other-model',
            providerNativeId: 'other/model',
          },
          identity: {
            ...makeCapabilities('other-model', 'verified').identity,
            fingerprint: computeIdentityFingerprint({
              alias: 'other-model',
              providerNativeId: 'other/model',
              revision: 1,
            }),
          },
        },
      },
    ],
    ladders: {
      routing: ['other-model'],
      planning: ['other-model'],
      coding: ['other-model'],
      review: ['other-model'],
      classify: ['other-model'],
    },
  };
}

function makeEvalRecord() {
  return {
    id: 'eval-1',
    schemaVersion: '1.43.0',
    originalPrompt: 'Run ox-alpha in a prompt; this free text should stay.',
    modelId: 'ox-alpha',
    modelVersion: 'v',
    attempted_model: 'ox-alpha',
    model_alias: 'ox-alpha',
    score: 0.5,
    scoreBand: 'acceptable',
    timeSeconds: 1,
    timestamp: '2026-08-24T00:00:00.000Z',
    interventionRequired: false,
    interventionCount: 0,
    interventionDetails: [],
    rationale: 'The old name ox-alpha appears in free text.',
    workflowCost: 0,
    workflowTokenUsage: {
      'ox-alpha': {
        inputTokens: 1_000_000,
        cacheCreationTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
        outputTokens: 1_000_000,
        costUsd: 0,
      },
    },
    modelIdentityAttribution: {
      observedAt: '2026-08-23T00:00:00.000Z',
      roles: {
        coder: {
          alias: 'ox-alpha',
          providerId: 'stealth/ox-alpha',
          identityStatus: 'provisional',
          identityRevision: 1,
          fingerprint: computeIdentityFingerprint({
            alias: 'ox-alpha',
            providerNativeId: 'stealth/ox-alpha',
            provider: 'openrouter',
            revision: 1,
          }),
          evidencePolicy: 'held',
        },
      },
      provisionalRoles: ['coder'],
      candidateOnlyProvisional: ['ox-alpha'],
    },
  };
}

describe('model promotion', () => {
  it('dry-runs without writing and reports a complete manifest', () => {
    const repoDir = makeRepo();
    try {
      const evalPath = join(repoDir, '.wavemill', 'evals', 'evals.jsonl');
      const before = readFileSync(evalPath, 'utf-8');
      const manifest = planModelPromotion({ spec: spec(), repoDir, now: '2026-08-24T01:00:00.000Z' });
      assert.equal(readFileSync(evalPath, 'utf-8'), before);
      assert.equal(manifest.status, 'planned');
      assert.ok(manifest.conservation.totalFieldChanges >= 5);
      assert.equal(manifest.conservation.evalIdsConserved, true);
      assert.equal(manifest.normalizedCost.complete, 1);
    } finally {
      cleanup(repoDir);
    }
  });

  it('applies, preserves free text and observed cost, then is idempotent', () => {
    const repoDir = makeRepo();
    try {
      const applied = applyModelPromotion({ spec: spec(), repoDir, now: '2026-08-24T01:00:00.000Z' });
      assert.equal(applied.status, 'applied');
      assert.ok(existsSync(applied.manifestPath!));
      const [evalRecord] = readFileSync(join(repoDir, '.wavemill', 'evals', 'evals.jsonl'), 'utf-8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      assert.equal(evalRecord.id, 'eval-1');
      assert.equal(evalRecord.modelId, 'gpt-9-test');
      assert.equal(evalRecord.rationale, 'The old name ox-alpha appears in free text.');
      assert.equal(evalRecord.workflowCost, 0);
      assert.equal(evalRecord.normalizedEvaluationCost.coverage, 'complete');
      assert.equal(evalRecord.trainingEligible, false);
      assert.equal(evalRecord.modelIdentityAttribution.finalization.finalAlias, 'gpt-9-test');

      const second = applyModelPromotion({ spec: spec(), repoDir, now: '2026-08-24T02:00:00.000Z' });
      assert.equal(second.status, 'already_applied');
    } finally {
      cleanup(repoDir);
    }
  });

  it('refuses malformed JSONL before creating backups', () => {
    const repoDir = makeRepo();
    try {
      writeFileSync(join(repoDir, '.wavemill', 'evals', 'evals.jsonl'), '{"id":"eval-1","schemaVersion":"1","modelId":"ox-alpha"}\n{bad\n');
      assert.throws(
        () => applyModelPromotion({ spec: spec(), repoDir }),
        /Malformed JSONL/,
      );
      assert.equal(existsSync(join(repoDir, '.wavemill', 'model-promotions')), false);
    } finally {
      cleanup(repoDir);
    }
  });

  it('rolls back exact backups from the manifest', () => {
    const repoDir = makeRepo();
    try {
      const before = readFileSync(join(repoDir, '.wavemill', 'evals', 'evals.jsonl'), 'utf-8');
      const applied = applyModelPromotion({ spec: spec(), repoDir });
      const rolledBack = rollbackModelPromotion(applied.manifestPath!);
      assert.equal(rolledBack.status, 'rolled_back');
      assert.equal(readFileSync(join(repoDir, '.wavemill', 'evals', 'evals.jsonl'), 'utf-8'), before);
    } finally {
      cleanup(repoDir);
    }
  });

  it('ignores fixture directories: malformed test fixtures cannot refuse the run', () => {
    const repoDir = makeRepo();
    try {
      mkdirSync(join(repoDir, 'tests', 'fixtures', 'artifacts'), { recursive: true });
      writeFileSync(join(repoDir, 'tests', 'fixtures', 'artifacts', 'routing-complete.json'), '{deliberately malformed\n');
      const manifest = planModelPromotion({ spec: spec(), repoDir, now: '2026-08-24T01:00:00.000Z' });
      assert.equal(manifest.status, 'planned');
      assert.equal(
        manifest.files.some((file) => file.relativePath.includes('routing-complete.json')),
        false,
      );
    } finally {
      cleanup(repoDir);
    }
  });

  it('ignores fixture directories: structured fixture references are not transformed or counted', () => {
    const repoDir = makeRepo();
    try {
      mkdirSync(join(repoDir, 'tests', 'fixtures'), { recursive: true });
      const fixturePath = join(repoDir, 'tests', 'fixtures', 'launch-priority.json');
      const fixtureContent = `${JSON.stringify({ models: [{ wavemillAlias: 'ox-alpha', openrouterId: 'stealth/ox-alpha' }] }, null, 2)}\n`;
      writeFileSync(fixturePath, fixtureContent);
      const applied = applyModelPromotion({ spec: spec(), repoDir, now: '2026-08-24T01:00:00.000Z' });
      assert.equal(applied.status, 'applied');
      assert.equal(
        applied.files.some((file) => file.relativePath.includes('launch-priority.json')),
        false,
      );
      assert.equal(readFileSync(fixturePath, 'utf-8'), fixtureContent);
    } finally {
      cleanup(repoDir);
    }
  });

  it('skips a checked-in transition spec instead of counting or rewriting it', () => {
    const repoDir = makeRepo();
    try {
      mkdirSync(join(repoDir, 'transitions'), { recursive: true });
      const specPath = join(repoDir, 'transitions', 'ox-alpha-to-gpt-9-test.json');
      const specContent = `${JSON.stringify(spec(), null, 2)}\n`;
      writeFileSync(specPath, specContent);
      const manifest = planModelPromotion({ spec: spec(), repoDir, now: '2026-08-24T01:00:00.000Z' });
      assert.equal(manifest.status, 'planned');
      assert.equal(
        manifest.files.some((file) => file.relativePath.includes('ox-alpha-to-gpt-9-test.json')),
        false,
      );
      assert.ok(manifest.diagnostics.some((line) => line.includes('skipped model transition spec input')));

      const applied = applyModelPromotion({ spec: spec(), repoDir, now: '2026-08-24T01:00:00.000Z' });
      assert.equal(applied.status, 'applied');
      assert.equal(readFileSync(specPath, 'utf-8'), specContent);
    } finally {
      cleanup(repoDir);
    }
  });

  it('still discovers and transforms the declarative catalog despite the fixtures skip', () => {
    const repoDir = makeRepo();
    try {
      const manifest = planModelPromotion({ spec: spec(), repoDir, now: '2026-08-24T01:00:00.000Z' });
      const catalog = manifest.files.find((file) => file.relativePath.endsWith(join('shared', 'fixtures', 'model-registry.v1.json')));
      assert.ok(catalog, 'catalog must be discovered via explicit catalogPath re-add');
      assert.ok(catalog.fieldChanges > 0, 'catalog must be transformed');
    } finally {
      cleanup(repoDir);
    }
  });

  it('rebuilds derived aggregated corpora from re-keyed raw evals and rolls them back on rollback', () => {
    const repoDir = makeRepo();
    try {
      const aggregatedPath = join(repoDir, '.wavemill', 'evals', 'aggregated-evals.jsonl');
      const backfilledPath = join(repoDir, '.wavemill', 'evals', 'aggregated-evals.backfilled.jsonl');
      const staleRecord = JSON.stringify(makeEvalRecord());
      writeFileSync(aggregatedPath, `${staleRecord}\n`);
      writeFileSync(backfilledPath, `${staleRecord}\n`);
      const staleAggregatedBefore = readFileSync(aggregatedPath, 'utf-8');
      const staleBackfilledBefore = readFileSync(backfilledPath, 'utf-8');

      const plan = planModelPromotion({ spec: spec(), repoDir, now: '2026-08-24T01:00:00.000Z' });
      assert.equal(plan.derivedCorpora.length, 2);
      const aggregatedManifest = plan.derivedCorpora.find((entry) => entry.relativePath.endsWith('aggregated-evals.jsonl') && !entry.relativePath.includes('backfilled'));
      assert.ok(aggregatedManifest);
      assert.equal(aggregatedManifest.sourceRawRecordCount, 1);
      assert.equal(aggregatedManifest.afterRecordCount + aggregatedManifest.duplicatesRemoved, 1);
      assert.notEqual(aggregatedManifest.beforeHash, aggregatedManifest.afterHash);
      // Dry-run must not touch derived files.
      assert.equal(readFileSync(aggregatedPath, 'utf-8'), staleAggregatedBefore);
      assert.equal(readFileSync(backfilledPath, 'utf-8'), staleBackfilledBefore);

      const applied = applyModelPromotion({ spec: spec(), repoDir, now: '2026-08-24T01:00:00.000Z' });
      assert.equal(applied.status, 'applied');
      assert.equal(applied.derivedCorpora.length, 2);
      const [aggregatedRecord] = readFileSync(aggregatedPath, 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
      assert.equal(aggregatedRecord.modelId, 'gpt-9-test');
      const [backfilledRecord] = readFileSync(backfilledPath, 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
      assert.equal(backfilledRecord.modelId, 'gpt-9-test');

      const second = applyModelPromotion({ spec: spec(), repoDir, now: '2026-08-24T02:00:00.000Z' });
      assert.equal(second.status, 'already_applied');

      const rolledBack = rollbackModelPromotion(applied.manifestPath!);
      assert.equal(rolledBack.status, 'rolled_back');
      assert.equal(readFileSync(aggregatedPath, 'utf-8'), staleAggregatedBefore);
      assert.equal(readFileSync(backfilledPath, 'utf-8'), staleBackfilledBefore);
    } finally {
      cleanup(repoDir);
    }
  });
});
