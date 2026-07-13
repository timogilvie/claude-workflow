import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import type { EvalRecord } from '../shared/lib/eval-schema.ts';
import { auditLaunchPriorityCoverage } from '../shared/lib/launch-priority-audit.ts';
import {
  buildFixtureCatalogSnapshot,
  buildLaunchValidationArtifact,
} from '../shared/lib/launch-validation.ts';
import type { LaunchPriorityFixture, OpenRouterModel } from '../shared/lib/openrouter-catalog.ts';
import { runOpenRouterSmoke } from '../shared/lib/openrouter-smoke.ts';
import { runLaunchValidationCli, runLaunchValidationCommand, type LaunchValidationToolDeps } from './launch-validation.ts';

const tempDirs: string[] = [];

function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'launch-validation-cli-'));
  tempDirs.push(dir);
  writeFileSync(join(dir, '.wavemill-config.json'), '{}\n', 'utf-8');
  return dir;
}

function makeFixture(): LaunchPriorityFixture {
  return {
    schemaVersion: 'fixture-test-v1',
    models: [
      {
        wavemillAlias: 'qwen-3-coder',
        openrouterId: 'qwen/qwen3-coder',
        family: 'qwen',
        status: 'active',
        priorityTier: 1,
        roleEligibility: ['coding', 'review'],
      },
      {
        wavemillAlias: 'deepseek-v3',
        openrouterId: 'deepseek/deepseek-chat-v3',
        family: 'deepseek',
        status: 'active',
        priorityTier: 1,
        roleEligibility: ['coding', 'review'],
      },
      {
        wavemillAlias: 'kimi-k2',
        openrouterId: 'moonshotai/kimi-k2',
        family: 'kimi',
        status: 'active',
        priorityTier: 1,
        roleEligibility: ['planning', 'coding', 'review'],
      },
    ],
  };
}

function makeRecord(modelId: string): EvalRecord {
  return {
    id: `${modelId}-fixture`,
    schemaVersion: '1.32.0',
    originalPrompt: 'launch validation',
    modelId,
    modelVersion: modelId,
    score: 0.9,
    scoreBand: 'Minor Feedback',
    timeSeconds: 20,
    timestamp: '2026-07-13T12:00:00.000Z',
    interventionRequired: false,
    interventionCount: 0,
    interventionDetails: [],
    rationale: 'fixture',
    outcomes: { success: true },
  } as EvalRecord;
}

function makeLiveModels(): Map<string, OpenRouterModel> {
  return new Map<string, OpenRouterModel>([
    ['qwen/qwen3-coder', { id: 'qwen/qwen3-coder', pricing: { prompt: '0.0000006', completion: '0.0000018' }, context_length: 262_144 }],
    ['deepseek/deepseek-chat-v3', { id: 'deepseek/deepseek-chat-v3', pricing: { prompt: '0.0000008', completion: '0.000002' }, context_length: 200_000 }],
    ['moonshotai/kimi-k2', { id: 'moonshotai/kimi-k2', pricing: { prompt: '0.0000009', completion: '0.0000022' }, context_length: 262_144 }],
  ]);
}

function makeDeps(records: EvalRecord[]): LaunchValidationToolDeps {
  const fixture = makeFixture();
  return {
    loadFixture: () => fixture,
    hashFixture: () => 'f'.repeat(64),
    fetchOpenRouterModels: async () => makeLiveModels(),
    buildFixtureCatalogSnapshot,
    runSmoke: runOpenRouterSmoke,
    auditCoverage: (options) => auditLaunchPriorityCoverage({
      ...options,
      evalRecords: records,
      checkNativeCertification: () => ({ eligible: true }),
    }),
    buildArtifact: buildLaunchValidationArtifact,
  };
}

function captureOutput() {
  const originalLog = console.log;
  const originalError = console.error;
  const stdout: string[] = [];
  const stderr: string[] = [];

  console.log = (...args: unknown[]) => stdout.push(args.join(' '));
  console.error = (...args: unknown[]) => stderr.push(args.join(' '));

  return {
    stdout,
    stderr,
    restore() {
      console.log = originalLog;
      console.error = originalError;
    },
  };
}

async function captureExit(fn: () => Promise<void>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const originalExit = process.exit;
  const output = captureOutput();
  let code: number | null = null;

  // @ts-expect-error test stub
  process.exit = (nextCode?: number) => {
    code = nextCode ?? 0;
    throw new Error(`EXIT:${code}`);
  };

  try {
    await fn();
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith('EXIT:')) {
      throw error;
    }
  } finally {
    process.exit = originalExit;
    output.restore();
  }

  return {
    code,
    stdout: output.stdout.join('\n'),
    stderr: output.stderr.join('\n'),
  };
}

after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('launch-validation cli', () => {
  it('writes the grouped launch-validation artifact in fixture mode', async () => {
    const repoDir = makeTempRepo();
    const outPath = join(repoDir, 'reports', 'launch-validation.json');

    const artifact = await runLaunchValidationCommand({
      out: outPath,
      'repo-dir': repoDir,
      target: '3',
      'max-attempts': '10',
      prompt: 'ping',
      live: false,
      json: false,
    }, makeDeps([
      makeRecord('qwen-3-coder'),
      makeRecord('deepseek-v3'),
      makeRecord('kimi-k2'),
    ]));

    assert.equal(existsSync(outPath), true);
    assert.equal(artifact.status, 'ok');
    const written = JSON.parse(readFileSync(outPath, 'utf-8')) as { provenance: { smoke: { mode: string } } };
    assert.equal(written.provenance.smoke.mode, 'fixture');
  });

  it('prints JSON with --json and still writes the artifact', async () => {
    const repoDir = makeTempRepo();
    const outPath = join(repoDir, 'reports', 'launch-validation.json');
    const output = captureOutput();

    try {
      await runLaunchValidationCommand({
        out: outPath,
        'repo-dir': repoDir,
        target: '3',
        'max-attempts': '10',
        prompt: 'ping',
        live: false,
        json: true,
      }, makeDeps([
        makeRecord('qwen-3-coder'),
        makeRecord('deepseek-v3'),
        makeRecord('kimi-k2'),
      ]));
    } finally {
      output.restore();
    }

    assert.equal(existsSync(outPath), true);
    assert.ok(output.stdout.join('\n').includes('"families"'));
  });

  it('treats missing live credentials as documented blockers instead of a hard failure', async () => {
    const repoDir = makeTempRepo();
    const originalApiKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = '';

    let result: Awaited<ReturnType<typeof captureExit>>;
    try {
      result = await captureExit(() =>
        runLaunchValidationCli([
          '--repo-dir', repoDir,
          '--live',
        ], makeDeps([])),
      );
    } finally {
      if (originalApiKey === undefined) {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = originalApiKey;
      }
    }

    assert.equal(result.code, null);
    assert.match(result.stdout, /status=blocked/);
    assert.equal(result.stderr, '');
  });

  it('exits with code 1 when silent gaps remain', async () => {
    const repoDir = makeTempRepo();
    const result = await captureExit(() =>
      runLaunchValidationCli([
        '--repo-dir', repoDir,
      ], makeDeps([])),
    );

    assert.equal(result.code, 1);
    assert.match(result.stderr, /silent coverage gaps or unmet family evidence/i);
  });
});
