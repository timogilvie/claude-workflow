import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const routeTaskTool = resolve(__dirname, 'route-task.ts');
const routeTasksTool = resolve(__dirname, 'route-tasks.ts');

function makeRepo() {
  const repoDir = mkdtempSync(join(tmpdir(), 'route-tasks-cli-test-'));
  mkdirSync(join(repoDir, '.wavemill', 'evals'), { recursive: true });
  writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify({
    router: {
      enabled: true,
      mode: 'stage-aware',
      minRecords: 1,
      minModels: 1,
      kNeighbors: 5,
      stageBlendWeight: 0.3,
      defaultAgent: 'claude',
      agentMap: {
        'claude-sonnet-4-6': 'claude',
        'gpt-5.3-codex': 'codex',
      },
    },
    eval: {
      pricing: {
        'claude-sonnet-4-6': { inputCostPerMTok: 3, outputCostPerMTok: 15, cacheWriteCostPerMTok: 3.75, cacheReadCostPerMTok: 0.3 },
        'gpt-5.3-codex': { inputCostPerMTok: 1.75, outputCostPerMTok: 14, cacheWriteCostPerMTok: 2.1875, cacheReadCostPerMTok: 0.44 },
      },
    },
  }));
  writeFileSync(join(repoDir, '.wavemill', 'evals', 'evals.jsonl'), [
    JSON.stringify({
      id: '1',
      schemaVersion: '1.0.0',
      originalPrompt: 'Build routing flow with tests',
      modelId: 'gpt-5.3-codex',
      modelVersion: 'gpt-5.3-codex',
      score: 0.92,
      scoreBand: 'good',
      timeSeconds: 100,
      timestamp: '2026-04-20T00:00:00.000Z',
      interventionRequired: false,
      interventionCount: 0,
      interventionDetails: [],
      rationale: 'good',
      metadata: {
        stageScores: {
          plan: { score: 0.9, rationale: 'ok' },
          implementation: { score: 0.93, rationale: 'ok' },
          review: { score: 0.91, rationale: 'ok' },
        },
      },
      taskDescriptor: {
        schema_version: '1.0',
        signals: {
          heuristic: {
            task_type: 'feature',
            languages: ['typescript'],
            framework_tags: [],
            files_touched: 4,
            repo_size_loc: 8000,
            description_tokens: 150,
            is_greenfield: false,
            has_migration: false,
            has_ui: false,
            has_tests: true,
            cross_service: false,
          },
          learned: {
            complexity: 3,
            domain: 'backend',
            risk_flags: ['workflow'],
          },
        },
        constraints: {
          models_available: [],
          objective: 'balanced',
        },
        stages: {
          planner: { model: 'claude-sonnet-4-6', cost_usd: 0.7 },
          coder: { model: 'gpt-5.3-codex', cost_usd: 2.8 },
          reviewer: { model: 'claude-sonnet-4-6', cost_usd: 0.6 },
        },
      },
    }),
  ].join('\n') + '\n');
  return repoDir;
}

describe('route-tasks CLI', () => {
  it('emits compact JSONL output and matches single-task JSON shape', () => {
    const repoDir = makeRepo();
    try {
      const packetA = join(repoDir, 'task-a.md');
      const packetB = join(repoDir, 'task-b.md');
      const inputFile = join(repoDir, 'route-input.jsonl');
      writeFileSync(packetA, 'Build startup batch routing with tests\n');
      writeFileSync(packetB, 'Use cached routing for selected tasks\n');
      writeFileSync(inputFile, [
        JSON.stringify({ issueId: 'HOK-100', file: packetA }),
        JSON.stringify({ issueId: 'HOK-101', file: packetB }),
      ].join('\n') + '\n');

      const stdout = execFileSync('npx', ['tsx', routeTasksTool, '--jsonl', inputFile, '--repo-dir', repoDir], {
        encoding: 'utf-8',
        cwd: resolve(__dirname, '..'),
        env: { ...process.env },
      });

      const lines = stdout.trim().split('\n');
      assert.equal(lines.length, 2);

      const parsed = lines.map((line) => JSON.parse(line));
      for (const item of parsed) {
        assert.ok(item.issueId);
        assert.ok(item.planner);
        assert.ok(item.coder);
        assert.ok(item.reviewer);
        assert.ok(item.routingMode);
      }

      const single = JSON.parse(execFileSync('npx', ['tsx', routeTaskTool, '--json', '--file', packetA, '--repo-dir', repoDir], {
        encoding: 'utf-8',
        cwd: resolve(__dirname, '..'),
        env: { ...process.env },
      }));

      const { issueId, ...batchDecision } = parsed[0];
      assert.equal(issueId, 'HOK-100');
      assert.equal(batchDecision.provenance.inputHash, single.provenance.inputHash);
      assert.equal(batchDecision.provenance.inputPath, single.provenance.inputPath);
      assert.equal(batchDecision.provenance.source, single.provenance.source);
      assert.equal(batchDecision.provenance.inputKind, single.provenance.inputKind);
      const { routedAt: _batchRoutedAt, ...batchProvenanceRest } = batchDecision.provenance;
      const { routedAt: _singleRoutedAt, ...singleProvenanceRest } = single.provenance;
      assert.deepEqual({ ...batchDecision, provenance: batchProvenanceRest }, { ...single, provenance: singleProvenanceRest });
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('keeps route-task --json stdout strict JSON and sends diagnostics to stderr', () => {
    const repoDir = makeRepo();
    try {
      const packet = join(repoDir, 'budget-task.md');
      writeFileSync(packet, 'Build routing flow with tests\n');
      const stdoutFile = join(repoDir, 'route.stdout.json');
      const stderrFile = join(repoDir, 'route.stderr.log');

      execFileSync('bash', ['-lc', `npx tsx "${routeTaskTool}" --json --file "${packet}" --repo-dir "${repoDir}" > "${stdoutFile}" 2> "${stderrFile}"`], {
        cwd: resolve(__dirname, '..'),
        env: { ...process.env },
      });

      const stdout = readFileSync(stdoutFile, 'utf-8');
      const stderr = readFileSync(stderrFile, 'utf-8');
      assert.doesNotThrow(() => JSON.parse(stdout));
      assert.equal(stdout.startsWith('Router:'), false);
      assert.equal(stdout.startsWith('Auto-aggregated'), false);
      assert.equal(stdout.includes('Router:'), false);
      assert.equal(stdout.includes('Auto-aggregated'), false);
      assert.equal(stderr.includes('{\n  "planner"'), false);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
