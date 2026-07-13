import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { runLaunchValidationCli, runLaunchValidationCommand } from './launch-validation.ts';

const tempDirs: string[] = [];

function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'launch-validation-cli-'));
  tempDirs.push(dir);
  writeFileSync(join(dir, '.wavemill-config.json'), '{}\n', 'utf-8');
  return dir;
}

const testReport = {
  schemaVersion: '1',
  generatedAt: '2026-07-13T15:00:00.000Z',
  mode: 'fixture',
  provenance: {
    launchPriorityList: {
      version: 'fixture',
      schemaVersion: '1',
      sourceHash: 'hash',
      modelCount: 2,
    },
    catalogSnapshot: {
      schemaVersion: '1',
      generatedAt: '2026-07-13T15:00:00.000Z',
      sourceHash: 'hash',
      entries: 2,
      blockers: 0,
    },
  },
  smoke: {
    prompt: 'ping',
    summary: { total: 2, ok: 2, blocker: 0, byCode: {} },
    models: [],
  },
  groupedAudit: {
    coverageTargetPerRole: 3,
    zeroEvidence: ['deepseek-v3'],
    belowTarget: [],
    samplingPlan: [{ wavemillAlias: 'deepseek-v3', openrouterId: 'deepseek/deepseek-chat-v3', role: 'coding', tier: 'zero-evidence-active', reason: 'gap', gap: 3, cost: 0.1 }],
    models: [
      { wavemillAlias: 'qwen-3-coder', roles: [], combinedBlockers: [] },
      { wavemillAlias: 'deepseek-v3', roles: [], combinedBlockers: [] },
    ],
  },
  familyChecks: [
    { family: 'qwen', status: 'satisfied', challengerAlias: 'qwen-3-coder', evalSuccesses: 1, reason: 'ok' },
  ],
  coverageDiagnostics: {
    anchorShareThreshold: 0.45,
    overrepresentedAnchors: [],
    underSampledLaunchTargets: [],
  },
  hokusai: {
    status: 'ok',
    eligibleEvalRecords: 1,
    skippedNotEligible: 0,
    validRows: 1,
    invalidRows: 0,
    rowsMissingLaunchAlias: 0,
    provenancePreview: {},
    coverage: { cells: [], overrepresentedAnchors: [], underSampledLaunchTargets: [] },
    issues: [],
  },
} as const;

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
  it('writes the launch validation artifact and prints a summary', async () => {
    const repoDir = makeTempRepo();
    const outPath = join(repoDir, 'reports', 'launch-validation.json');
    const output = captureOutput();

    try {
      await runLaunchValidationCommand({
        out: outPath,
        'repo-dir': repoDir,
        live: false,
        prompt: 'ping',
        target: '3',
        'max-attempts': '10',
        'anchor-share': '0.45',
        json: true,
      }, {
        generateReport: async () => testReport as never,
      });
    } finally {
      output.restore();
    }

    assert.equal(existsSync(outPath), true);
    const written = JSON.parse(readFileSync(outPath, 'utf-8')) as { groupedAudit: { zeroEvidence: string[] } };
    assert.deepEqual(written.groupedAudit.zeroEvidence, ['deepseek-v3']);
    assert.ok(output.stdout.join('\n').includes('Validated 2 launch-priority models.'));
    assert.ok(output.stdout.join('\n').includes('"zeroEvidence"'));
  });

  it('rejects invalid anchor share values with exit code 1', async () => {
    const repoDir = makeTempRepo();
    const result = await captureExit(() =>
      runLaunchValidationCli([
        '--repo-dir', repoDir,
        '--anchor-share', '0',
      ], {
        generateReport: async () => testReport as never,
      }),
    );

    assert.equal(result.code, 1);
    assert.match(result.stderr, /--anchor-share must be a number > 0 and <= 1/);
  });
});
