/**
 * CLI smoke tests for the wavemill entry point.
 *
 * Verifies command routing, help/version output, and graceful failure
 * on missing dependencies or unknown commands.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WAVEMILL = resolve(__dirname, '..', 'wavemill');

function run(args: string[], env?: Record<string, string>): string {
  return execFileSync(WAVEMILL, args, {
    encoding: 'utf-8',
    timeout: 10_000,
    env: { ...process.env, ...env },
  });
}

function runExpectFail(args: string[], env?: Record<string, string>): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync(WAVEMILL, args, {
      encoding: 'utf-8',
      timeout: 10_000,
      env: { ...process.env, ...env },
    });
    return { stdout, stderr: '', status: 0 };
  } catch (err: any) {
    return {
      stdout: err.stdout?.toString() ?? '',
      stderr: err.stderr?.toString() ?? '',
      status: err.status ?? 1,
    };
  }
}

describe('wavemill CLI', () => {
  describe('help and version', () => {
    it('shows help with no arguments', () => {
      const out = run([]);
      assert.match(out, /Usage:/);
      assert.match(out, /Commands:/);
    });

    it('shows help with "help" command', () => {
      const out = run(['help']);
      assert.match(out, /Wavemill/);
      assert.match(out, /mill/);
      assert.match(out, /expand/);
      assert.match(out, /plan/);
      assert.match(out, /review/);
      assert.match(out, /eval/);
      assert.match(out, /route/);
      assert.match(out, /hokusai/);
    });

    it('shows help with --help flag', () => {
      const out = run(['--help']);
      assert.match(out, /Usage:/);
    });

    it('shows version with "version" command', () => {
      const out = run(['version']);
      assert.match(out, /Wavemill v\d+\.\d+\.\d+/);
    });

    it('shows version with --version flag', () => {
      const out = run(['--version']);
      assert.match(out, /Wavemill v\d+\.\d+\.\d+/);
    });
  });

  describe('unknown commands', () => {
    it('exits 1 for unknown command', () => {
      const result = runExpectFail(['nosuchcommand']);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Unknown command/);
    });
  });

  describe('dependency checks', () => {
    it('mill reports missing tmux when not on PATH', () => {
      // Use a minimal PATH that excludes tmux
      const result = runExpectFail(['mill'], {
        PATH: '/usr/bin:/bin',
        SKIP_CONTEXT_CHECK: 'true',
        HOME: process.env.HOME ?? '',
      });
      assert.notEqual(result.status, 0);
      const output = result.stdout + result.stderr;
      assert.match(output, /tmux|required|not found/i);
    });
  });

  describe('route command', () => {
    it('routes inline task text', () => {
      const out = run(['route', 'Create', 'a', 'route', 'CLI', 'command', 'with', 'JSON', 'output']);
      assert.match(out, /Starting Wavemill Route/);
      assert.match(out, /Planner:/);
      assert.match(out, /Coder:/);
      assert.match(out, /Reviewer:/);
      assert.match(out, /Success:/);
    });
  });

  describe('check-routing command', () => {
    it('prints routing health for an isolated repo', () => {
      const repoDir = mkdtempSync(join(tmpdir(), 'wavemill-routing-health-'));
      try {
        mkdirSync(join(repoDir, '.wavemill', 'evals'), { recursive: true });
        writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify({
          router: {
            enabled: true,
            mode: 'stage-aware',
            minRecords: 1,
            minModels: 1,
            defaultAgent: 'claude',
            agentMap: {
              'claude-sonnet-4-5-20250929': 'claude',
            },
          },
          eval: {
            pricing: {
              'claude-sonnet-4-5-20250929': { inputCostPerMTok: 3, outputCostPerMTok: 15, cacheWriteCostPerMTok: 3.75, cacheReadCostPerMTok: 0.3 },
            },
          },
        }));
        writeFileSync(join(repoDir, '.wavemill', 'evals', 'evals.jsonl'), `${JSON.stringify({
          id: '1',
          schemaVersion: '1.0.0',
          originalPrompt: 'Fix routing bug',
          modelId: 'claude-sonnet-4-5-20250929',
          modelVersion: 'claude-sonnet-4-5-20250929',
          score: 0.9,
          scoreBand: 'good',
          timeSeconds: 120,
          timestamp: '2026-04-10T00:00:00.000Z',
          interventionRequired: false,
          interventionCount: 0,
          interventionDetails: [],
          rationale: 'ok',
          metadata: {
            stageScores: {
              plan: { score: 0.9, rationale: 'ok' },
              implementation: { score: 0.9, rationale: 'ok' },
              review: { score: 0.9, rationale: 'ok' },
            },
          },
          taskDescriptor: {
            schema_version: '1.0',
            signals: {
              heuristic: {
                task_type: 'bugfix',
                languages: ['typescript'],
                framework_tags: [],
                files_touched: 3,
                repo_size_loc: 5000,
                description_tokens: 120,
                is_greenfield: false,
                has_migration: false,
                has_ui: false,
                has_tests: true,
                cross_service: false,
              },
              learned: {
                complexity: 2,
                domain: 'backend',
                risk_flags: ['workflow'],
              },
            },
            constraints: {
              models_available: [],
              objective: 'balanced',
            },
            stages: {
              planner: { model: 'claude-sonnet-4-5-20250929', cost_usd: 1 },
              coder: { model: 'claude-sonnet-4-5-20250929', cost_usd: 2 },
              reviewer: { model: 'claude-sonnet-4-5-20250929', cost_usd: 1 },
            },
          },
        })}\n`);
        mkdirSync(join(repoDir, 'tools'), { recursive: true });
        writeFileSync(join(repoDir, 'tools', 'route-task.ts'), '// stub\n');

        const out = execFileSync(WAVEMILL, ['check-routing', '--repo-dir', repoDir], {
          encoding: 'utf-8',
          timeout: 10_000,
          env: { ...process.env },
        });
        assert.match(out, /Starting Wavemill Routing Check/);
        assert.match(out, /Routing health:/);
        assert.match(out, /Sample route:/);
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    });
  });

  describe('hokusai command', () => {
    it('shows disabled status by default in an isolated HOME', () => {
      const fakeHome = mkdtempSync(join(tmpdir(), 'wavemill-hokusai-home-'));
      try {
        const out = run(['hokusai', 'status'], { HOME: fakeHome });
        assert.match(out, /Hokusai data submission: disabled/);
        assert.match(out, /Submission allowed: no/);
      } finally {
        rmSync(fakeHome, { recursive: true, force: true });
      }
    });
  });
});
