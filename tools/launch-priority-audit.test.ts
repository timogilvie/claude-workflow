import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { auditLaunchPriorityCoverage } from '../shared/lib/launch-priority-audit.ts';
import type { LaunchPriorityModel } from '../shared/lib/openrouter-catalog.ts';
import { runLaunchPriorityAuditCli, runLaunchPriorityAuditCommand } from './launch-priority-audit.ts';

const tempDirs: string[] = [];

function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'launch-priority-cli-'));
  tempDirs.push(dir);
  writeFileSync(join(dir, '.wavemill-config.json'), '{}\n', 'utf-8');
  mkdirSync(join(dir, '.wavemill', 'evals'), { recursive: true });
  return dir;
}

function makeCatalog(): LaunchPriorityModel[] {
  return [
    {
      wavemillAlias: 'qwen-3-coder',
      openrouterId: 'qwen/qwen3-coder',
      family: 'qwen',
      status: 'active',
      priorityTier: 1,
      roleEligibility: ['coding'],
    },
    {
      wavemillAlias: 'deepseek-v3',
      openrouterId: 'deepseek/deepseek-chat-v3-0324',
      family: 'deepseek',
      status: 'active',
      priorityTier: 1,
      roleEligibility: ['coding'],
    },
  ];
}

const testDeps = {
  loadCatalog: makeCatalog,
  auditCoverage: (options: Parameters<typeof auditLaunchPriorityCoverage>[0]) =>
    auditLaunchPriorityCoverage({
      ...options,
      checkNativeCertification: () => ({ eligible: true }),
    }),
};

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

describe('launch-priority-audit cli', () => {
  it('writes an audit file with zero-evidence models when the corpus is empty', async () => {
    const repoDir = makeTempRepo();
    const outPath = join(repoDir, 'reports', 'launch-priority.json');
    writeFileSync(join(repoDir, '.wavemill', 'evals', 'evals.jsonl'), '', 'utf-8');

    await runLaunchPriorityAuditCommand({
      out: outPath,
      'repo-dir': repoDir,
      target: '3',
      'max-attempts': '10',
      json: false,
    }, testDeps);

    assert.equal(existsSync(outPath), true);
    const written = JSON.parse(readFileSync(outPath, 'utf-8')) as { zeroEvidence: string[] };
    assert.deepEqual(written.zeroEvidence, ['deepseek-v3', 'qwen-3-coder']);
  });

  it('prints JSON to stdout with --json and still writes the file', async () => {
    const repoDir = makeTempRepo();
    const outPath = join(repoDir, 'reports', 'launch-priority.json');
    const output = captureOutput();

    try {
      await runLaunchPriorityAuditCommand({
        out: outPath,
        'repo-dir': repoDir,
        target: '3',
        'max-attempts': '10',
        json: true,
      }, testDeps);
    } finally {
      output.restore();
    }

    assert.equal(existsSync(outPath), true);
    assert.ok(output.stdout.join('\n').includes('"zeroEvidence"'));
  });

  it('creates missing output directories', async () => {
    const repoDir = makeTempRepo();
    const outPath = join(repoDir, 'nested', 'reports', 'launch-priority.json');

    await runLaunchPriorityAuditCommand({
      out: outPath,
      'repo-dir': repoDir,
      target: '3',
      'max-attempts': '10',
      json: false,
    }, testDeps);

    assert.equal(existsSync(outPath), true);
  });

  it('rejects non-positive targets with exit code 1', async () => {
    const repoDir = makeTempRepo();
    const result = await captureExit(() =>
      runLaunchPriorityAuditCli([
        '--repo-dir', repoDir,
        '--target', '0',
      ], testDeps),
    );

    assert.equal(result.code, 1);
    assert.match(result.stderr, /--target must be an integer >= 1/);
  });

  it('rejects negative max-attempts with exit code 1', async () => {
    const repoDir = makeTempRepo();
    const result = await captureExit(() =>
      runLaunchPriorityAuditCli([
        '--repo-dir', repoDir,
        '--max-attempts=-1',
      ], testDeps),
    );

    assert.equal(result.code, 1);
    assert.match(result.stderr, /--max-attempts must be an integer >= 0/);
  });

  it('produces stable artifacts across repeated runs apart from generatedAt', async () => {
    const repoDir = makeTempRepo();
    const outPath = join(repoDir, 'reports', 'launch-priority.json');
    await runLaunchPriorityAuditCommand({
      out: outPath,
      'repo-dir': repoDir,
      target: '3',
      'max-attempts': '10',
      json: false,
    }, testDeps);
    const first = JSON.parse(readFileSync(outPath, 'utf-8')) as Record<string, unknown>;

    await runLaunchPriorityAuditCommand({
      out: outPath,
      'repo-dir': repoDir,
      target: '3',
      'max-attempts': '10',
      json: false,
    }, testDeps);
    const second = JSON.parse(readFileSync(outPath, 'utf-8')) as Record<string, unknown>;

    delete first.generatedAt;
    delete second.generatedAt;
    assert.deepEqual(first, second);
  });
});
