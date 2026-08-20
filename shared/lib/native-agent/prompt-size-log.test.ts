import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { clearConfigCache } from '../config.ts';
import {
  appendPromptSizeSample,
  readPromptSizeSamples,
  resolvePromptSizeLogPath,
  type PromptSizeSample,
} from './prompt-size-log.ts';

function makeSample(overrides: Partial<PromptSizeSample> = {}): PromptSizeSample {
  return {
    recordedAt: '2026-08-20T00:00:00.000Z',
    stage: 'coding',
    model: 'kimi-k2',
    provider: 'openrouter',
    source: 'preflight-estimate',
    promptTokens: 12_000,
    contextWindowLimit: 131_072,
    session: 'sess-1',
    issue: 'HOK-2782',
    ...overrides,
  };
}

describe('prompt-size-log', () => {
  it('append + read round-trip: samples come back in order', async () => {
    const tmpRepo = mkdtempSync(join(tmpdir(), 'wm-psl-'));
    try {
      clearConfigCache(tmpRepo);
      await appendPromptSizeSample(tmpRepo, makeSample({ promptTokens: 100 }));
      await appendPromptSizeSample(tmpRepo, makeSample({ promptTokens: 200, source: 'run-peak' }));
      const samples = readPromptSizeSamples(tmpRepo);
      assert.equal(samples.length, 2);
      assert.equal(samples[0].promptTokens, 100);
      assert.equal(samples[1].promptTokens, 200);
      assert.equal(samples[1].source, 'run-peak');
    } finally {
      clearConfigCache(tmpRepo);
      rmSync(tmpRepo, { recursive: true, force: true });
    }
  });

  it('read returns [] when the log file does not exist', () => {
    const tmpRepo = mkdtempSync(join(tmpdir(), 'wm-psl-'));
    try {
      clearConfigCache(tmpRepo);
      assert.deepEqual(readPromptSizeSamples(tmpRepo), []);
    } finally {
      clearConfigCache(tmpRepo);
      rmSync(tmpRepo, { recursive: true, force: true });
    }
  });

  it('read tolerates malformed lines and returns the parseable ones', async () => {
    const tmpRepo = mkdtempSync(join(tmpdir(), 'wm-psl-'));
    try {
      clearConfigCache(tmpRepo);
      const path = resolvePromptSizeLogPath(tmpRepo);
      mkdirSync(join(path, '..'), { recursive: true });
      appendFileSync(
        path,
        `${JSON.stringify(makeSample({ promptTokens: 1 }))}\nnot json\n${JSON.stringify(makeSample({ promptTokens: 2 }))}\n`,
        'utf-8',
      );
      const samples = readPromptSizeSamples(tmpRepo);
      assert.equal(samples.length, 2);
      assert.equal(samples[0].promptTokens, 1);
      assert.equal(samples[1].promptTokens, 2);
    } finally {
      clearConfigCache(tmpRepo);
      rmSync(tmpRepo, { recursive: true, force: true });
    }
  });

  it('append is fail-open: no throw when the target path cannot be written', async () => {
    // Point the resolver at a path we cannot create by using a path that
    // collides with an existing non-directory. We create a file at where the
    // evals dir would go, so mkdirSync would fail.
    const tmpRepo = mkdtempSync(join(tmpdir(), 'wm-psl-'));
    try {
      clearConfigCache(tmpRepo);
      // Create a file at the .wavemill path so that mkdirSync inside append
      // sees a non-directory in its way.
      const collidingFile = join(tmpRepo, '.wavemill');
      appendFileSync(collidingFile, 'blocking file', 'utf-8');
      // Should resolve without throwing.
      await appendPromptSizeSample(tmpRepo, makeSample());
      // And the log file should not exist because the write was swallowed.
      assert.equal(existsSync(resolvePromptSizeLogPath(tmpRepo)), false);
    } finally {
      clearConfigCache(tmpRepo);
      rmSync(tmpRepo, { recursive: true, force: true });
    }
  });

  it('resolvePromptSizeLogPath returns a path under the evals dir', () => {
    const tmpRepo = mkdtempSync(join(tmpdir(), 'wm-psl-'));
    try {
      clearConfigCache(tmpRepo);
      const path = resolvePromptSizeLogPath(tmpRepo);
      assert.ok(path.endsWith('stage-prompt-sizes.jsonl'), `expected stage-prompt-sizes.jsonl in ${path}`);
    } finally {
      clearConfigCache(tmpRepo);
      rmSync(tmpRepo, { recursive: true, force: true });
    }
  });
});
