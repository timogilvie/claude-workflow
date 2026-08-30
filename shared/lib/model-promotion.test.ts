import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  applyModelPromotion,
  planModelPromotion,
  rollbackModelPromotion,
  applyModelActivation,
  planModelActivation,
  type ModelTransitionSpec,
  type ActivationManifest,
} from './model-promotion.ts';
import { assertRegistryConsistency, computeIdentityFingerprint } from './model-registry.ts';
import { projectModelRegistryCatalog } from './model-registry-loader.ts';

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
    openrouterMappings: [
      {
        wavemillAlias: 'ox-alpha',
        openrouterId: 'stealth/ox-alpha',
        family: 'unknown',
        status: 'provisional',
        priorityTier: 3,
        roleEligibility: ['planning', 'coding', 'review'],
      },
    ],
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

      const catalog = JSON.parse(readFileSync(join(repoDir, 'shared', 'fixtures', 'model-registry.v1.json'), 'utf-8'));
      const mappingByAlias = Object.fromEntries(
        catalog.openrouterMappings.map((row: { wavemillAlias: string }) => [row.wavemillAlias, row]),
      );
      // The historical row stays resolvable but terminal; the final row is active.
      assert.equal(mappingByAlias['ox-alpha'].status, 'deprecated');
      assert.equal(mappingByAlias['ox-alpha'].openrouterId, 'stealth/ox-alpha');
      assert.equal(mappingByAlias['gpt-9-test'].status, 'active');
      assert.equal(mappingByAlias['gpt-9-test'].openrouterId, 'openai/gpt-9-test');

      // The historical entry is disclosed: verified member of the final
      // family with successor lineage, evidence still held, and the whole
      // catalog passes the effective-registry consistency gate.
      const oxEntry = catalog.models.find((entry: { id: string }) => entry.id === 'ox-alpha');
      assert.equal(oxEntry.capabilities.identity.status, 'verified');
      assert.equal(oxEntry.capabilities.identity.family, 'gpt');
      assert.equal(oxEntry.capabilities.identity.evidencePolicy, 'held');
      assert.equal(oxEntry.capabilities.identity.lineage.successor, 'gpt-9-test');
      assert.equal(oxEntry.capabilities.supportedModel.lifecycle, 'deprecated');
      assert.doesNotThrow(() => assertRegistryConsistency(projectModelRegistryCatalog(catalog)));

      const second = applyModelPromotion({ spec: spec(), repoDir, now: '2026-08-24T02:00:00.000Z' });
      assert.equal(second.status, 'already_applied');
    } finally {
      cleanup(repoDir);
    }
  });

  it('rewrites provider ids in launch-priority-style mapping rows (openrouterId)', () => {
    const repoDir = makeRepo();
    try {
      const mappingPath = join(repoDir, 'shared', 'fixtures', 'launch-priority.json');
      writeFileSync(mappingPath, `${JSON.stringify({
        schemaVersion: '1',
        models: [
          {
            wavemillAlias: 'ox-alpha',
            openrouterId: 'stealth/ox-alpha',
            family: 'unknown',
            status: 'provisional',
            priorityTier: 3,
          },
          {
            wavemillAlias: 'other-model',
            openrouterId: 'other/model',
            family: 'gpt',
            status: 'active',
            priorityTier: 1,
          },
        ],
      }, null, 2)}\n`);

      const plan = planModelPromotion({ spec: spec(), repoDir, now: '2026-08-24T01:00:00.000Z' });
      const mappingManifest = plan.files.find((file) => file.relativePath.endsWith('launch-priority.json'));
      assert.ok(mappingManifest);
      // Both the alias and the provider id count as old references and both are rewritten.
      assert.equal(mappingManifest.oldReferencesBefore, 2);
      assert.ok(mappingManifest.fieldChanges >= 2);

      const applied = applyModelPromotion({ spec: spec(), repoDir, now: '2026-08-24T01:00:00.000Z' });
      assert.equal(applied.status, 'applied');
      const rewritten = JSON.parse(readFileSync(mappingPath, 'utf-8'));
      assert.deepEqual(
        rewritten.models.map((row: { wavemillAlias: string; openrouterId: string }) => [row.wavemillAlias, row.openrouterId]),
        [
          ['gpt-9-test', 'openai/gpt-9-test'],
          ['other-model', 'other/model'],
        ],
      );
    } finally {
      cleanup(repoDir);
    }
  });

  it('skips checked-in transition spec files instead of treating them as corpora', () => {
    const repoDir = makeRepo();
    try {
      mkdirSync(join(repoDir, 'transitions'), { recursive: true });
      const specPath = join(repoDir, 'transitions', 'ox-to-gpt-9-test.json');
      const specContent = `${JSON.stringify(spec(), null, 2)}\n`;
      writeFileSync(specPath, specContent);

      // Without the skip this refuses: the spec holds the provisional identity in
      // `alias`/`providerNativeId` keys and the final identity in the same keys.
      const plan = planModelPromotion({ spec: spec(), repoDir, now: '2026-08-24T01:00:00.000Z' });
      assert.equal(plan.status, 'planned');
      assert.equal(plan.files.some((file) => file.relativePath.endsWith('ox-to-gpt-9-test.json')), false);
      assert.ok(plan.diagnostics.some((line) => line.includes('transition spec')));

      const applied = applyModelPromotion({ spec: spec(), repoDir, now: '2026-08-24T01:00:00.000Z' });
      assert.equal(applied.status, 'applied');
      assert.equal(readFileSync(specPath, 'utf-8'), specContent);
    } finally {
      cleanup(repoDir);
    }
  });

  it('skips unparseable files that mention neither identity, refuses ones that do', () => {
    const repoDir = makeRepo();
    try {
      mkdirSync(join(repoDir, 'tests', 'fixtures'), { recursive: true });
      const brokenUnrelated = join(repoDir, 'tests', 'fixtures', 'broken-unrelated.json');
      writeFileSync(brokenUnrelated, '{"planner":"broken"\n');

      const plan = planModelPromotion({ spec: spec(), repoDir, now: '2026-08-24T01:00:00.000Z' });
      assert.equal(plan.status, 'planned');
      assert.ok(plan.diagnostics.some((line) => line.includes('broken-unrelated.json')));

      writeFileSync(join(repoDir, 'tests', 'fixtures', 'broken-related.json'), '{"planner":"ox-alpha"\n');
      assert.throws(
        () => planModelPromotion({ spec: spec(), repoDir }),
        /Malformed JSON/,
      );
    } finally {
      cleanup(repoDir);
    }
  });

  it('parses pretty-printed JSON stream .jsonl trace files without refusing', () => {
    const repoDir = makeRepo();
    try {
      mkdirSync(join(repoDir, '.wavemill', 'evals', 'artifacts', 'HOK-1'), { recursive: true });
      const tracePath = join(repoDir, '.wavemill', 'evals', 'artifacts', 'HOK-1', 'trace.jsonl');
      // Two pretty-printed documents back to back; free-text mention only.
      writeFileSync(tracePath, [
        '{',
        '  "schemaVersion": "1.0",',
        '  "slug": "onboard-ox-alpha-for-routing",',
        '  "event": "task_launched"',
        '}',
        '{',
        '  "schemaVersion": "1.0",',
        '  "planner": "ox-alpha",',
        '  "event": "routing_complete"',
        '}',
        '',
      ].join('\n'));

      const plan = planModelPromotion({ spec: spec(), repoDir, now: '2026-08-24T01:00:00.000Z' });
      assert.equal(plan.status, 'planned');
      const traceManifest = plan.files.find((file) => file.relativePath.endsWith('trace.jsonl'));
      assert.ok(traceManifest);
      assert.equal(traceManifest.recordCount, 2);
      // The structured planner reference counts and is rewritten; the slug stays free text.
      assert.equal(traceManifest.oldReferencesBefore, 1);

      const applied = applyModelPromotion({ spec: spec(), repoDir, now: '2026-08-24T01:00:00.000Z' });
      assert.equal(applied.status, 'applied');
      const rewritten = readFileSync(tracePath, 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
      assert.equal(rewritten[0].slug, 'onboard-ox-alpha-for-routing');
      assert.equal(rewritten[1].planner, 'gpt-9-test');
    } finally {
      cleanup(repoDir);
    }
  });

  it('does not cross into nested repositories (worktrees under the repo dir)', () => {
    const repoDir = makeRepo();
    try {
      const nested = join(repoDir, 'worktrees', 'some-branch');
      mkdirSync(join(nested, '.git'), { recursive: true });
      const nestedFixture = join(nested, 'routing.json');
      const nestedContent = `${JSON.stringify({ planner: 'ox-alpha' }, null, 2)}\n`;
      writeFileSync(nestedFixture, nestedContent);

      const plan = planModelPromotion({ spec: spec(), repoDir, now: '2026-08-24T01:00:00.000Z' });
      assert.equal(plan.files.some((file) => file.relativePath.includes('worktrees')), false);

      const applied = applyModelPromotion({ spec: spec(), repoDir, now: '2026-08-24T01:00:00.000Z' });
      assert.equal(applied.status, 'applied');
      assert.equal(readFileSync(nestedFixture, 'utf-8'), nestedContent);
    } finally {
      cleanup(repoDir);
    }
  });

  it('never treats certification artifacts as corpora (no re-keying, no refusal)', () => {
    const repoDir = makeRepo();
    try {
      const certDir = join(repoDir, '.wavemill', 'native-agent-certifications', 'stealth', 'ox-alpha');
      mkdirSync(certDir, { recursive: true });
      const oldCertPath = join(certDir, 'v3.json');
      const oldCert = `${JSON.stringify({
        schemaVersion: 3,
        suiteVersion: 'v3',
        phase: 'workflow',
        subject: { registryKey: 'ox-alpha', providerNativeId: 'stealth/ox-alpha' },
      }, null, 2)}\n`;
      writeFileSync(oldCertPath, oldCert);
      // A final-subject artifact can legitimately pre-exist an apply (e.g. a
      // re-apply after rollback); it must not count as a final reference.
      const finalCertDir = join(repoDir, '.wavemill', 'native-agent-certifications', 'openai', 'gpt-9-test');
      mkdirSync(finalCertDir, { recursive: true });
      const finalCertPath = join(finalCertDir, 'v3.json');
      const finalCert = `${JSON.stringify({
        schemaVersion: 3,
        suiteVersion: 'v3',
        phase: 'workflow',
        subject: { registryKey: 'gpt-9-test', providerNativeId: 'openai/gpt-9-test' },
      }, null, 2)}\n`;
      writeFileSync(finalCertPath, finalCert);

      const applied = applyModelPromotion({ spec: spec(), repoDir, now: '2026-08-24T01:00:00.000Z' });
      assert.equal(applied.status, 'applied');
      assert.equal(readFileSync(oldCertPath, 'utf-8'), oldCert);
      assert.equal(readFileSync(finalCertPath, 'utf-8'), finalCert);
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

  // ===========================================================================
  // ACTIVATION TESTS (REQ-F6)
  // ===========================================================================

  describe('model activation', () => {
    it('refuses activation when no certification artifact exists (before certification)', () => {
      const repoDir = makeActivatableRepo();
      try {
        const manifest = planModelActivation({ spec: spec(), repoDir, now: '2026-08-24T02:00:00.000Z' });
        assert.equal(manifest.status, 'refused');
        assert.equal(manifest.outcome, 'refused');
        assert.equal(manifest.fieldChanges, 0);
        assert.ok(
          manifest.diagnostics.some((line) => /not certified for the required phase/i.test(line)),
          `expected refusal diagnostic, got: ${JSON.stringify(manifest.diagnostics)}`,
        );
      } finally {
        cleanup(repoDir);
      }
    });

    it('applyModelActivation on an uncertified model writes a refusal manifest and does not mutate the catalog', () => {
      const repoDir = makeActivatableRepo();
      try {
        const catalogPath = join(repoDir, 'shared', 'fixtures', 'model-registry.v1.json');
        const before = readFileSync(catalogPath, 'utf-8');
        const manifest = applyModelActivation({ spec: spec(), repoDir, now: '2026-08-24T02:00:00.000Z' });
        assert.equal(manifest.status, 'refused');
        assert.equal(readFileSync(catalogPath, 'utf-8'), before, 'catalog must be unchanged after refusal');
        assert.ok(existsSync(manifest.manifestPath!), 'refusal manifest must be written for audit');
      } finally {
        cleanup(repoDir);
      }
    });

    it('activates after certification and flips all five target fields, then is idempotent on re-run', () => {
      const repoDir = makeActivatableRepo();
      try {
        writeCertArtifact(repoDir);
        const catalogPath = join(repoDir, 'shared', 'fixtures', 'model-registry.v1.json');

        const first = applyModelActivation({ spec: spec(), repoDir, now: '2026-08-24T02:00:00.000Z' });
        assert.equal(first.status, 'activated', `first-run diagnostics: ${JSON.stringify(first.diagnostics)}`);
        assert.equal(first.outcome, 'activated');
        assert.equal(first.fieldChanges, 5);
        assert.deepEqual(
          [...first.changedFields].sort(),
          [
            'identity.evidencePolicy',
            'nativeCapability.certification.certifiedAt',
            'nativeCapability.readOnlyNative',
            'supportedModel.launchEligible',
            'supportedModel.routingEligible',
          ],
        );

        const activatedCatalog = JSON.parse(readFileSync(catalogPath, 'utf-8'));
        const entry = activatedCatalog.models.find((m: { id: string }) => m.id === 'gpt-9-test');
        assert.equal(entry.capabilities.nativeCapability.readOnlyNative, 'certified');
        assert.equal(entry.capabilities.nativeCapability.certification.certifiedAt, CERT_CERTIFIED_AT);
        assert.equal(entry.capabilities.supportedModel.launchEligible, true);
        assert.equal(entry.capabilities.supportedModel.routingEligible, true);
        assert.equal(entry.capabilities.identity.evidencePolicy, 'eligible');

        // Re-run: idempotent, no writes, already_activated status. A fresh
        // planModelActivation against the activated catalog reports zero
        // remaining changes; applyModelActivation short-circuits without
        // rewriting the catalog.
        const contentAfterFirst = readFileSync(catalogPath, 'utf-8');
        const replan = planModelActivation({ spec: spec(), repoDir, now: '2026-08-24T03:00:00.000Z' });
        assert.equal(replan.status, 'already_activated');
        assert.equal(replan.fieldChanges, 0);
        assert.deepEqual(replan.changedFields, []);
        const second = applyModelActivation({ spec: spec(), repoDir, now: '2026-08-24T03:00:00.000Z' });
        assert.equal(second.status, 'already_activated');
        assert.equal(readFileSync(catalogPath, 'utf-8'), contentAfterFirst, 'idempotent re-run must not rewrite catalog');
      } finally {
        cleanup(repoDir);
      }
    });

    it('planModelActivation dry-run does not mutate the catalog when certification is present', () => {
      const repoDir = makeActivatableRepo();
      try {
        writeCertArtifact(repoDir);
        const catalogPath = join(repoDir, 'shared', 'fixtures', 'model-registry.v1.json');
        const before = readFileSync(catalogPath, 'utf-8');
        const plan = planModelActivation({ spec: spec(), repoDir, now: '2026-08-24T02:00:00.000Z' });
        assert.equal(plan.status, 'activated');
        assert.equal(plan.mode, 'dry-run');
        assert.equal(plan.fieldChanges, 5);
        assert.equal(readFileSync(catalogPath, 'utf-8'), before, 'dry-run must not write');
      } finally {
        cleanup(repoDir);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Activation-test fixtures
// ---------------------------------------------------------------------------

const CERT_SUITE_VERSION = 'v3';
const CERT_CERTIFIED_AT = '2026-08-24T00:30:00.000Z';
const CERT_CATALOG_HASH = 'test-catalog-hash';
const CERT_IDENTITY_REVISION = 2;

function finalFingerprint(): string {
  return computeIdentityFingerprint({
    alias: 'gpt-9-test',
    providerNativeId: 'openai/gpt-9-test',
    provider: 'openrouter',
    revision: CERT_IDENTITY_REVISION,
  });
}

function makeActivatableCatalog() {
  return {
    schemaVersion: '1',
    models: [
      {
        id: 'gpt-9-test',
        capabilities: {
          vendor: 'openai',
          class: 'strong_generalist',
          strengths: ['test'],
          weaknesses: [],
          qualityScores: { routing: 10, planning: 10, coding: 10, review: 10, classify: 10 },
          pricing: {
            inputCostPerMTok: 2,
            outputCostPerMTok: 10,
            cacheWriteCostPerMTok: 3,
            cacheReadCostPerMTok: 0.5,
          },
          defaultLadderEligible: false,
          contextWindowTokens: 128000,
          toolSupport: 'full',
          multimodal: { text: true, image: false },
          latencyTier: 'standard',
          reasoningTier: 'advanced',
          costPerMillionInputTokensUsd: 2,
          costPerMillionOutputTokensUsd: 10,
          nativeCapability: {
            nativeProvider: 'openrouter',
            piTransportKind: 'openai-completions',
            readOnlyNative: 'partial',
            certification: {
              certificationSuiteVersion: CERT_SUITE_VERSION,
              maxCertifiedPhase: 'read-only',
            },
          },
          supportedModel: {
            wavemillAlias: 'gpt-9-test',
            providerNativeId: 'openai/gpt-9-test',
            provider: 'openrouter',
            certificationSuiteVersion: CERT_SUITE_VERSION,
            launchEligible: false,
            routingEligible: false,
          },
          identity: {
            status: 'verified',
            revision: CERT_IDENTITY_REVISION,
            fingerprint: finalFingerprint(),
            displayName: 'GPT 9 Test',
            family: 'gpt',
            evidencePolicy: 'held',
            verification: {
              source: 'fixture',
              observedAt: '2026-08-24T00:00:00.000Z',
              catalogHash: CERT_CATALOG_HASH,
            },
          },
        },
      },
    ],
    ladders: {
      routing: [],
      planning: [],
      coding: [],
      review: [],
      classify: [],
    },
    openrouterMappings: [
      {
        wavemillAlias: 'gpt-9-test',
        openrouterId: 'openai/gpt-9-test',
        family: 'gpt',
        status: 'active',
        priorityTier: 3,
        roleEligibility: ['planning', 'coding', 'review'],
      },
    ],
  };
}

function makeActivatableRepo(): string {
  const repoDir = mkdtempSync(join(tmpdir(), 'model-activation-test-'));
  mkdirSync(join(repoDir, 'shared', 'fixtures'), { recursive: true });
  writeFileSync(
    join(repoDir, 'shared', 'fixtures', 'model-registry.v1.json'),
    `${JSON.stringify(makeActivatableCatalog(), null, 2)}\n`,
  );
  return repoDir;
}

function writeCertArtifact(repoDir: string): string {
  const certDir = join(repoDir, '.wavemill', 'native-agent-certifications', 'openai', 'gpt-9-test');
  mkdirSync(certDir, { recursive: true });
  const certPath = join(certDir, `${CERT_SUITE_VERSION}.json`);
  const artifact = {
    schemaVersion: 3,
    subject: {
      registryKey: 'gpt-9-test',
      nativeProvider: 'openrouter',
      providerId: 'openai',
      providerModelId: 'gpt-9-test',
      providerNativeId: 'openai/gpt-9-test',
      identityRevision: CERT_IDENTITY_REVISION,
      identityFingerprint: finalFingerprint(),
      catalogHash: CERT_CATALOG_HASH,
    },
    provider: 'openai',
    model: 'gpt-9-test',
    phase: 'read-only',
    suiteVersion: CERT_SUITE_VERSION,
    certifiedAt: CERT_CERTIFIED_AT,
    scenarios: [{ scenarioId: 'smoke', passed: true }],
  };
  writeFileSync(certPath, `${JSON.stringify(artifact, null, 2)}\n`);
  return certPath;
}
