import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { clearConfigCache } from '../config.ts';
import { writeOpenRouterCredits } from '../quota-state.ts';
import {
  InsufficientOpenRouterCreditsError,
  assertOpenRouterBalanceSufficient,
  capOpenRouterMaxTokensForBalance,
  evaluateOpenRouterBalance,
} from './openrouter-credits-guard.ts';

let tempRoot: string;
let repoDir: string;

function git(command: string): string {
  return execSync(`git ${command}`, {
    cwd: repoDir,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'ignore'],
  }).trim();
}

function writeConfig(value: Record<string, unknown>): void {
  writeFileSync(join(repoDir, '.wavemill-config.json'), `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
  clearConfigCache(repoDir);
}

function writeCredits(balanceUsd: number, updatedAt = '2026-08-19T12:00:00.000Z'): void {
  writeOpenRouterCredits(repoDir, {
    totalCredits: 10,
    totalUsage: 10 - balanceUsd,
    balanceUsd,
    usageDaily: 1,
    updatedAt,
    lastFetchError: null,
  });
}

describe('openrouter-credits-guard', () => {
  beforeEach(() => {
    tempRoot = join(tmpdir(), `openrouter-credits-guard-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    repoDir = join(tempRoot, 'repo');
    mkdirSync(repoDir, { recursive: true });
    git('init');
    git('config user.name "Test User"');
    git('config user.email "test@example.com"');
    writeFileSync(join(repoDir, 'README.md'), 'seed\n', 'utf-8');
    git('add README.md');
    git('commit -m "init"');
    delete process.env.OPENROUTER_API_KEY;
    clearConfigCache(repoDir);
  });

  afterEach(() => {
    clearConfigCache(repoDir);
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('fails open when no cached credit data exists', () => {
    const result = evaluateOpenRouterBalance({ repoDir });
    assert.equal(result.status, 'ok');
    assert.equal(result.balanceUsd, null);
  });

  it('returns ok above the warning threshold', () => {
    writeConfig({
      nativeAgent: {
        providers: {
          openrouter: { warnCreditsUsd: 2, minCreditsUsd: 0.02 },
        },
      },
    });
    writeCredits(3);
    assert.equal(evaluateOpenRouterBalance({ repoDir }).status, 'ok');
  });

  it('warns between warn and minimum thresholds', () => {
    writeConfig({
      nativeAgent: {
        providers: {
          openrouter: { warnCreditsUsd: 2, minCreditsUsd: 0.02 },
        },
      },
    });
    writeCredits(1);
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown) => warnings.push(String(message));
    try {
      const result = assertOpenRouterBalanceSufficient({ repoDir });
      assert.equal(result.status, 'warn');
    } finally {
      console.warn = originalWarn;
    }
    assert.match(warnings.join('\n'), /credit balance is low/i);
  });

  it('refuses below minimum or negative balance', () => {
    writeCredits(0.001);
    assert.throws(
      () => assertOpenRouterBalanceSufficient({ repoDir, model: 'glm-5.2' }),
      InsufficientOpenRouterCreditsError,
    );

    writeCredits(-0.16);
    assert.equal(evaluateOpenRouterBalance({ repoDir }).status, 'refuse');
  });

  it('uses model pricing as a meaningful-call floor', () => {
    writeCredits(0.01);
    const result = evaluateOpenRouterBalance({
      repoDir,
      pricing: { inputPerMTok: 1, outputPerMTok: 10 },
    });
    assert.equal(result.status, 'refuse');
    assert.ok(result.minCreditsUsd > 0.02);
  });

  it('caps max tokens against affordable cached balance', () => {
    writeCredits(0.01);
    assert.equal(
      capOpenRouterMaxTokensForBalance({
        requestedMaxTokens: 32768,
        pricing: { inputPerMTok: 1, outputPerMTok: 10 },
        repoDir,
      }),
      1024,
    );

    writeCredits(1);
    assert.equal(
      capOpenRouterMaxTokensForBalance({
        requestedMaxTokens: 32768,
        pricing: { inputPerMTok: 1, outputPerMTok: 10 },
        repoDir,
      }),
      32768,
    );
  });
});
