import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  it('writes expanded route artifacts with cache metadata', () => {
    const repoDir = makeRepo();
    try {
      const featureA = join(repoDir, 'features', 'a');
      const featureB = join(repoDir, 'features', 'b');
      mkdirSync(featureA, { recursive: true });
      mkdirSync(featureB, { recursive: true });
      const packetA = join(featureA, 'task-packet.md');
      const packetB = join(featureB, 'task-packet.md');
      const inputFile = join(repoDir, 'expanded-route-input.jsonl');
      writeFileSync(packetA, 'Build startup batch routing with tests\n');
      writeFileSync(packetB, 'Use cached routing for selected tasks\n');
      writeFileSync(inputFile, [
        JSON.stringify({ issueId: 'HOK-200', featureDir: featureA, packetFile: packetA }),
        JSON.stringify({ issueId: 'HOK-201', featureDir: featureB, packetFile: packetB }),
      ].join('\n') + '\n');

      const stdout = execFileSync('npx', ['tsx', routeTasksTool, '--expanded-jsonl', inputFile, '--repo-dir', repoDir], {
        encoding: 'utf-8',
        cwd: resolve(__dirname, '..'),
        env: { ...process.env },
      });

      const lines = stdout.trim().split('\n').map((line) => JSON.parse(line));
      assert.equal(lines.length, 2);
      for (const item of lines) {
        assert.ok(item.outputFile.endsWith('.post-expansion-route.json'));
        assert.match(item.packet_hash, /^[a-f0-9]{64}$/);
        assert.equal(item.cache_hit, false);
        assert.match(item.route_source, /batch|single/);
      }

      const artifact = JSON.parse(readFileSync(join(featureA, '.post-expansion-route.json'), 'utf-8'));
      assert.match(artifact.packet_hash, /^[a-f0-9]{64}$/);
      assert.ok(typeof artifact.cache_hit === 'boolean');
      assert.match(artifact.route_source, /batch|single/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('supports empty expanded input successfully', () => {
    const repoDir = makeRepo();
    try {
      const inputFile = join(repoDir, 'empty-expanded-route-input.jsonl');
      writeFileSync(inputFile, '');
      const stdout = execFileSync('npx', ['tsx', routeTasksTool, '--expanded-jsonl', inputFile, '--repo-dir', repoDir], {
        encoding: 'utf-8',
        cwd: resolve(__dirname, '..'),
        env: { ...process.env },
      });
      assert.equal(stdout, '');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('fails expanded mode on missing packet path without writing artifacts', () => {
    const repoDir = makeRepo();
    try {
      const featureA = join(repoDir, 'features', 'a');
      mkdirSync(featureA, { recursive: true });
      const inputFile = join(repoDir, 'missing-expanded-route-input.jsonl');
      writeFileSync(inputFile, `${JSON.stringify({ issueId: 'HOK-300', featureDir: featureA, packetFile: join(featureA, 'missing-task-packet.md') })}\n`);

      assert.throws(() => {
        execFileSync('npx', ['tsx', routeTasksTool, '--expanded-jsonl', inputFile, '--repo-dir', repoDir], {
          encoding: 'utf-8',
          cwd: resolve(__dirname, '..'),
          env: { ...process.env },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      });
      assert.equal(existsSync(resolve(featureA, '.post-expansion-route.json')), false);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
