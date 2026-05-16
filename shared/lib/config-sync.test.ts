import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { clearConfigCache, CURRENT_CONFIG_VERSION } from './config.ts';
import {
  CANONICAL_CONFIG_TEMPLATE,
  classifyLocalOverridePaths,
  deepMergeConfig,
  identifyConfigAdditions,
  prepareConfigSync,
} from './config-sync.ts';

const tempRepos = new Set<string>();

function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'config-sync-'));
  tempRepos.add(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempRepos) {
    clearConfigCache(dir);
    rmSync(dir, { recursive: true, force: true });
  }
  tempRepos.clear();
});

function writeLocalConfig(repoDir: string, config: Record<string, unknown>) {
  writeFileSync(join(repoDir, '.wavemill-config.local.json'), JSON.stringify(config), 'utf-8');
}

describe('config-sync', () => {
  it('deepMergeConfig preserves user values while adding missing defaults', () => {
    const merged = deepMergeConfig(
      { a: 1, nested: { keep: true, missing: 'x' }, arr: [1, 2] },
      { nested: { keep: false }, arr: [9], extra: 'y' },
    );

    assert.deepEqual(merged, {
      a: 1,
      nested: { keep: false, missing: 'x' },
      arr: [9],
      extra: 'y',
    });
  });

  it('identifyConfigAdditions reports new nested paths', () => {
    const additions = identifyConfigAdditions({ a: { b: 1 } }, { a: { b: 1, c: 2 }, d: 3 });
    assert.deepEqual(additions.sort(), ['a.c', 'd']);
  });

  it('prepareConfigSync merges current config with canonical template', () => {
    const repoDir = makeTempRepo();
    writeFileSync(
      join(repoDir, '.wavemill-config.json'),
      JSON.stringify({
        configVersion: '1.0.0',
        mill: { maxParallel: 7 },
      }),
      'utf-8',
    );

    const prepared = prepareConfigSync(repoDir);
    assert.equal(prepared.configExists, true);
    assert.equal(prepared.mergedConfig.mill?.maxParallel, 7);
    assert.equal(prepared.mergedConfig.linear?.project, CANONICAL_CONFIG_TEMPLATE.linear?.project);
    assert.ok(prepared.additions.includes('linear'));
  });

  it('ignores local overrides when determining whether repo config is already current', () => {
    const repoDir = makeTempRepo();
    writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify(CANONICAL_CONFIG_TEMPLATE), 'utf-8');
    writeFileSync(
      join(repoDir, '.wavemill-config.local.json'),
      JSON.stringify({
        router: { defaultModel: 'gpt-5.5' },
      }),
      'utf-8',
    );

    const prepared = prepareConfigSync(repoDir);
    assert.equal(prepared.alreadyCurrent, true);
    assert.equal(prepared.localConfigExists, true);
  });

  it('reports additions from base even when local overlay has them', () => {
    const repoDir = makeTempRepo();
    writeFileSync(
      join(repoDir, '.wavemill-config.json'),
      JSON.stringify({
        configVersion: '1.3.0',
        mill: { maxParallel: 7 },
      }),
      'utf-8',
    );
    writeLocalConfig(repoDir, {
      configVersion: CURRENT_CONFIG_VERSION,
      router: {
        enabled: false,
      },
      hokusai: {
        dataSubmission: {
          enabled: true,
          consentVersion: 'local',
          endpoint: 'https://local.invalid/submit',
        },
      },
    });

    const prepared = prepareConfigSync(repoDir);

    assert.equal(prepared.alreadyCurrent, false);
    assert.ok(prepared.additions.includes('router'));
    assert.ok(prepared.additions.includes('hokusai'));
    assert.equal(prepared.mergedConfig.router?.enabled, CANONICAL_CONFIG_TEMPLATE.router?.enabled);
    assert.equal(
      prepared.mergedConfig.hokusai?.dataSubmission?.endpoint,
      CANONICAL_CONFIG_TEMPLATE.hokusai?.dataSubmission?.endpoint,
    );
  });

  it('output is stable whether local overlay is absent or empty', () => {
    const repoDir = makeTempRepo();
    writeFileSync(
      join(repoDir, '.wavemill-config.json'),
      JSON.stringify({
        configVersion: '1.3.0',
        mill: { maxParallel: 7 },
      }),
      'utf-8',
    );
    const withoutLocal = prepareConfigSync(repoDir);

    writeLocalConfig(repoDir, {});
    clearConfigCache(repoDir);
    const withEmptyLocal = prepareConfigSync(repoDir);

    assert.equal(withoutLocal.alreadyCurrent, withEmptyLocal.alreadyCurrent);
    assert.deepEqual(withoutLocal.additions, withEmptyLocal.additions);
    assert.deepEqual(withoutLocal.mergedConfig, withEmptyLocal.mergedConfig);
  });

  it('captures local config parse errors without blocking sync preparation', () => {
    const repoDir = makeTempRepo();
    writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify(CANONICAL_CONFIG_TEMPLATE), 'utf-8');
    writeFileSync(join(repoDir, '.wavemill-config.local.json'), '{"router":', 'utf-8');

    const prepared = prepareConfigSync(repoDir);
    assert.equal(prepared.localConfigExists, true);
    assert.equal(typeof prepared.localConfigParseError, 'string');
    assert.equal(prepared.localConfig, null);
    assert.equal(prepared.alreadyCurrent, true);
  });

  it('classifies canonical local-only fields as repo-default candidates', () => {
    const rows = classifyLocalOverridePaths(
      {},
      {
        router: { defaultModel: 'gpt-5.5' },
      },
    );

    assert.deepEqual(rows, [
      {
        path: 'router.defaultModel',
        label: 'will add to repo default',
        reason: 'router.defaultModel is a canonical config field missing from .wavemill-config.json.',
      },
    ]);
  });

  it('classifies unknown local-only fields as already local-only', () => {
    const rows = classifyLocalOverridePaths(
      {},
      {
        developer: { nickname: 'tim' },
      },
    );

    assert.deepEqual(rows, [
      {
        path: 'developer.nickname',
        label: 'already local-only',
        reason: 'developer.nickname does not need to be synced — it is either absent from .wavemill-config.json (and not a canonical field), or it matches the existing repo default.',
      },
    ]);
  });

  it('classifies sensitive local-only fields as requiring a decision', () => {
    const rows = classifyLocalOverridePaths(
      {},
      {
        hokusai: { apiToken: 'secret-123' },
      },
    );

    assert.deepEqual(rows, [
      {
        path: 'hokusai.apiToken',
        label: 'requires decision',
        reason: 'hokusai.apiToken looks sensitive, machine-local, or intentionally overridden.',
      },
    ]);
  });

  it('classifies machine-local absolute paths as requiring a decision', () => {
    const rows = classifyLocalOverridePaths(
      {},
      {
        mill: { worktreeRoot: '/Users/tester/worktrees' },
      },
    );

    assert.deepEqual(rows, [
      {
        path: 'mill.worktreeRoot',
        label: 'requires decision',
        reason: 'mill.worktreeRoot looks sensitive, machine-local, or intentionally overridden.',
      },
    ]);
  });

  it('classifies base-vs-local value conflicts as requiring a decision', () => {
    const rows = classifyLocalOverridePaths(
      {
        router: { defaultModel: 'claude-sonnet-4-6' },
      },
      {
        router: { defaultModel: 'gpt-5.5' },
      },
    );

    assert.deepEqual(rows, [
      {
        path: 'router.defaultModel',
        label: 'requires decision',
        reason: 'router.defaultModel looks sensitive, machine-local, or intentionally overridden.',
      },
    ]);
  });

  it('returns no classifications for empty or absent local overrides', () => {
    assert.deepEqual(classifyLocalOverridePaths({}, null), []);
    assert.deepEqual(classifyLocalOverridePaths({}, {}), []);
  });

  it('orders classification paths deterministically', () => {
    const rows = classifyLocalOverridePaths(
      {},
      {
        zeta: { field: 1 },
        alpha: { field: 2 },
        router: { defaultModel: 'gpt-5.5' },
      },
    );

    assert.deepEqual(rows.map(row => row.path), ['alpha.field', 'router.defaultModel', 'zeta.field']);
  });

  it('CANONICAL_CONFIG_TEMPLATE.configVersion matches CURRENT_CONFIG_VERSION', () => {
    assert.equal(CANONICAL_CONFIG_TEMPLATE.configVersion, CURRENT_CONFIG_VERSION);
  });

  it('wavemill init heredoc configVersion matches CURRENT_CONFIG_VERSION', () => {
    const script = readFileSync(join(import.meta.dirname, '..', '..', 'wavemill'), 'utf-8');
    const match = script.match(/"configVersion":\s*"([^"]+)"/);

    assert.ok(match, 'expected wavemill init template to contain configVersion');
    assert.equal(
      match[1],
      CURRENT_CONFIG_VERSION,
      `wavemill init heredoc configVersion (${match[1]}) has drifted from CURRENT_CONFIG_VERSION (${CURRENT_CONFIG_VERSION}). Update wavemill init template.`,
    );
  });
});
