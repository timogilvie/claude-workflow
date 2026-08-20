import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  appendStagePromptObservation,
  stagePromptObservationsPath,
} from './stage-prompt-observations.ts';

describe('stage-prompt-observations', () => {
  it('appends JSONL and creates the observation directory', () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'stage-prompt-observations-'));
    try {
      appendStagePromptObservation({
        repoDir,
        stage: 'coding',
        model: 'test-model',
        provider: 'openrouter',
        peakRequestTokens: 321,
        totalInputTokens: 500,
        turns: 2,
        now: new Date('2026-08-19T00:00:00.000Z'),
      });

      const records = readFileSync(stagePromptObservationsPath(repoDir), 'utf-8').trim().split(/\r?\n/);
      assert.equal(records.length, 1);
      assert.deepEqual(JSON.parse(records[0] ?? '{}'), {
        ts: '2026-08-19T00:00:00.000Z',
        stage: 'coding',
        model: 'test-model',
        provider: 'openrouter',
        peakRequestTokens: 321,
        totalInputTokens: 500,
        turns: 2,
        source: 'native-agent-loop',
      });
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('does not throw when the repo path cannot be written', () => {
    assert.doesNotThrow(() => appendStagePromptObservation({
      repoDir: '/dev/null/not-a-directory',
      stage: 'review',
      model: 'test-model',
      provider: 'openai',
      peakRequestTokens: 123,
      totalInputTokens: 123,
      turns: 1,
    }));
  });
});
