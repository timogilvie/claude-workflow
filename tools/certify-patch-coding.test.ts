import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PatchCodingCertification } from '../shared/lib/native-agent/coding-certification.ts';
import type { RunNativeSmokeOptions } from '../shared/lib/native-agent/smoke.ts';
import {
  certifyPatchCoding,
  ensureDistinctMinimum,
  parseProviderModelPairs,
} from './certify-patch-coding.ts';

describe('certify-patch-coding helpers', () => {
  it('parses repeatable and comma-separated provider/model pairs', () => {
    assert.deepEqual(
      parseProviderModelPairs({
        provider: ['openai:gpt-4o'],
        providers: 'openrouter:openai/gpt-4o-mini, openai:gpt-4.1',
      }),
      [
        { provider: 'openai', model: 'gpt-4o' },
        { provider: 'openrouter', model: 'openai/gpt-4o-mini' },
        { provider: 'openai', model: 'gpt-4.1' },
      ],
    );
  });

  it('rejects invalid, duplicate, and insufficient provider/model pairs', () => {
    assert.throws(
      () => parseProviderModelPairs({ provider: ['unknown:model'] }),
      /Invalid provider\/model pair/,
    );
    assert.throws(
      () => ensureDistinctMinimum([{ provider: 'openai', model: 'gpt-4o' }]),
      /at least two distinct/,
    );
    assert.throws(
      () => ensureDistinctMinimum([
        { provider: 'openai', model: 'gpt-4o' },
        { provider: 'openai', model: 'gpt-4o' },
      ]),
      /Duplicate provider\/model pairs/,
    );
  });

  it('does not certify dry-run results or write an artifact', async () => {
    let writeCalls = 0;

    const report = await certifyPatchCoding({
      repoDir: '/repo',
      dryRun: true,
      pairs: [
        { provider: 'openai', model: 'gpt-4o' },
        { provider: 'openrouter', model: 'openai/gpt-4o-mini' },
      ],
      runDrySmoke: async (options: RunNativeSmokeOptions) => ({
        outcome: 'ok',
        provider: options.provider,
        modelId: options._modelIdOverride ?? 'missing-model',
        phase: options.phase,
        exposedTools: ['apply_patch'],
        transcriptPath: `/tmp/${options.provider}.jsonl`,
        apiKeyEnv: 'TEST_API_KEY',
      }),
      writeCertification: () => {
        writeCalls += 1;
        return '/repo/.wavemill/native-agent/patch-coding-certification.json';
      },
    });

    assert.equal(report.certified, false);
    assert.equal(report.artifactPath, undefined);
    assert.equal(writeCalls, 0);
    assert.deepEqual(
      report.providers.map((provider) => [provider.provider, provider.model, provider.passed]),
      [
        ['openai', 'gpt-4o', true],
        ['openrouter', 'openai/gpt-4o-mini', true],
      ],
    );
  });

  it('writes certification for successful live smoke results', async () => {
    let written: PatchCodingCertification | undefined;

    const report = await certifyPatchCoding({
      repoDir: '/repo',
      pairs: [
        { provider: 'openai', model: 'gpt-4o' },
        { provider: 'openrouter', model: 'openai/gpt-4o-mini' },
      ],
      now: () => new Date('2026-01-02T03:04:05.000Z'),
      runLiveSmoke: async (options: RunNativeSmokeOptions) => ({
        outcome: 'ok',
        provider: options.provider,
        modelId: options._modelIdOverride ?? 'missing-model',
        phase: options.phase,
        exposedTools: ['apply_patch'],
        transcriptPath: `/tmp/${options.provider}.jsonl`,
        apiKeyEnv: 'TEST_API_KEY',
      }),
      writeCertification: (_repoDir, certification) => {
        written = certification;
        return '/repo/.wavemill/native-agent/patch-coding-certification.json';
      },
    });

    assert.equal(report.certified, true);
    assert.equal(report.artifactPath, '/repo/.wavemill/native-agent/patch-coding-certification.json');
    assert.equal(written?.certified, true);
    assert.equal(written?.certifiedAt, '2026-01-02T03:04:05.000Z');
    assert.equal(written?.smokeSuiteRevision, report.smokeSuiteRevision);
    assert.deepEqual(written?.providers, report.providers);
  });
});
