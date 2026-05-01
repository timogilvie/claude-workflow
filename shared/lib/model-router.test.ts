import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveAgent, recommendModelHeuristic } from './model-router.ts';
import { clearConfigCache } from './config.ts';

describe('model-router resolveAgent', () => {
  it('routes known DeepSeek models to claude', () => {
    assert.equal(resolveAgent('deepseek-v4-pro', {}, 'codex'), 'claude');
    assert.equal(resolveAgent('deepseek-v4-pro[1m]', {}, 'codex'), 'claude');
    assert.equal(resolveAgent('deepseek-v4-flash', {}, 'codex'), 'claude');
  });

  it('throws for unknown DeepSeek-like models instead of falling back', () => {
    assert.throws(
      () => resolveAgent('deepseek-v4-ultra', {}, 'claude'),
      /Unknown DeepSeek model "deepseek-v4-ultra"/,
    );
  });

  it('preserves existing claude and gpt resolution heuristics', () => {
    assert.equal(resolveAgent('claude-sonnet-4-6', {}, 'codex'), 'claude');
    assert.equal(resolveAgent('gpt-5.4', {}, 'claude'), 'codex');
  });
});

describe('model-router unattended DeepSeek filtering', () => {
  function makeTempRepo(): string {
    return mkdtempSync(join(tmpdir(), 'router-test-'));
  }

  function cleanUp(dir: string) {
    rmSync(dir, { recursive: true, force: true });
  }

  function writeConfig(repoDir: string, content: string) {
    writeFileSync(join(repoDir, '.wavemill-config.json'), content, 'utf-8');
  }

  it('filters DeepSeek models from candidates when unattendedEnabled is absent', () => {
    const tmp = makeTempRepo();
    try {
      clearConfigCache();
      writeConfig(tmp, JSON.stringify({}));

      const result = recommendModelHeuristic(
        'implement a feature',
        { complexity: 5, hasCode: true, wordCount: 10, hasSchema: false, hasMigration: false },
        {
          repoDir: tmp,
          defaultModel: 'claude-sonnet-4-6',
          models: ['deepseek-v4-pro', 'claude-sonnet-4-6'],
          minRecords: 0,
          minModels: 0,
          agentMap: {},
          defaultAgent: 'claude',
        },
      );

      // DeepSeek should be filtered out, leaving only claude-sonnet-4-6
      assert.ok(!result.candidates.some((c) => c.modelId.startsWith('deepseek-')));
    } finally {
      cleanUp(tmp);
    }
  });

  it('filters DeepSeek models when unattendedEnabled is false', () => {
    const tmp = makeTempRepo();
    try {
      clearConfigCache();
      writeConfig(tmp, JSON.stringify({
        deepseek: { unattendedEnabled: false },
      }));

      const result = recommendModelHeuristic(
        'implement a feature',
        { complexity: 5, hasCode: true, wordCount: 10, hasSchema: false, hasMigration: false },
        {
          repoDir: tmp,
          defaultModel: 'claude-sonnet-4-6',
          models: ['deepseek-v4-pro', 'claude-sonnet-4-6'],
          minRecords: 0,
          minModels: 0,
          agentMap: {},
          defaultAgent: 'claude',
        },
      );

      // DeepSeek should be filtered out
      assert.ok(!result.candidates.some((c) => c.modelId.startsWith('deepseek-')));
    } finally {
      cleanUp(tmp);
    }
  });
});
