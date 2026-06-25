import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { registerScriptedPiProvider } from './provider.ts';
import { launchNativePlanning } from './launch-planning.ts';
import type { ToolDescriptor } from './tools/types.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = resolve(__dirname, '../../..');

let apiSeq = 0;
function uniqueApi(label: string): string {
  apiSeq += 1;
  return `launch-planning-${label}-${apiSeq}`;
}

function setupWorktree(): { wtDir: string; featureDir: string; packetPath: string; sourcePath: string } {
  const wtDir = mkdtempSync(join(tmpdir(), 'native-planning-wt-'));
  execFileSync('git', ['init', wtDir], { stdio: 'pipe' });
  execFileSync('git', ['-C', wtDir, 'config', 'user.email', 'native@wavemill.test'], { stdio: 'pipe' });
  execFileSync('git', ['-C', wtDir, 'config', 'user.name', 'Native Planning Test'], { stdio: 'pipe' });

  const featureDir = join(wtDir, 'features', 'demo');
  const packetPath = join(featureDir, 'task-packet.md');
  const sourcePath = join(wtDir, 'src.ts');
  mkdirSync(featureDir, { recursive: true });
  writeFileSync(packetPath, [
    '# Task Packet',
    '## 1. Objective',
    'Wire native planning.',
    '## Success Criteria',
    '- planning completes',
  ].join('\n'));
  writeFileSync(sourcePath, 'export const value = 1;\n');
  execFileSync('git', ['-C', wtDir, 'add', '.'], { stdio: 'pipe' });
  execFileSync('git', ['-C', wtDir, 'commit', '-m', 'fixture'], { stdio: 'pipe' });

  return { wtDir, featureDir, packetPath, sourcePath };
}

function cleanup(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

function scriptedModel(api: string) {
  return {
    id: `scripted:${api}`,
    name: `scripted:${api}`,
    api,
    provider: 'scripted',
  } as const;
}

function stubRunTsxCommand(): (args: string[]) => string {
  return (args: string[]) => {
    const outputIndex = args.indexOf('--output');
    if (outputIndex >= 0) {
      writeFileSync(args[outputIndex + 1]!, `${JSON.stringify({
        planner: 'gpt-5.4',
        coder: 'gpt-5.4',
        reviewer: 'gpt-5.4',
        planDepth: 'light',
      }, null, 2)}\n`);
    }
    return '';
  };
}

function makeMutationTool(executed: { value: boolean }): ToolDescriptor {
  return {
    metadata: {
      name: 'write_source',
      description: 'Mutate source files.',
      class: 'mutation',
      allowedPhases: [] as const,
      executionMode: 'sequential',
      outputCapPolicy: { strategy: 'none' as const },
    },
    label: 'write_source',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
    async execute() {
      executed.value = true;
      return {
        content: [{ type: 'text', text: 'mutated' }],
      };
    },
  };
}

describe('launchNativePlanning', () => {
  it('writes plan.md, .plan-approved, and idle native hook on success', async () => {
    const { wtDir, featureDir } = setupWorktree();
    const api = uniqueApi('success');

    try {
      registerScriptedPiProvider({
        api,
        turns: [{
          content: [{
            type: 'text',
            text: [
              '# Implementation Plan',
              '## Phase 1',
              '- Inspect launch path',
              '## Release Readiness',
              '- **database_change_risk**: none',
            ].join('\n'),
          }],
          stopReason: 'stop',
        }],
      });

      const result = await launchNativePlanning({
        session: 'sess',
        issue: 'HOK-2313',
        slug: 'demo',
        wtDir,
        repoDir: REPO_DIR,
        title: 'Wire native planning',
        loopModelOverride: scriptedModel(api),
        runTsxCommand: stubRunTsxCommand(),
      });

      assert.equal(result.stopReason, 'stop');
      assert.equal(result.provider, 'scripted');
      assert.equal(result.model, `scripted:${api}`);
      const planPath = join(featureDir, 'plan.md');
      const plan = readFileSync(planPath, 'utf-8');
      assert.match(plan, /# Implementation Plan/);
      assert.match(plan, /## Release Readiness/);
      assert.ok(existsSync(join(featureDir, '.plan-approved')));

      const hook = JSON.parse(readFileSync(result.hookPath, 'utf-8')) as Record<string, unknown>;
      assert.equal(hook.state, 'idle');
      assert.equal(hook.agent, 'native');
      assert.equal(hook.event, 'process_exit');
      assert.equal(hook.detail, 'planning_completed');
    } finally {
      cleanup(wtDir);
    }
  });

  it('denies a registered mutation tool and keeps source unchanged', async () => {
    const { wtDir, sourcePath } = setupWorktree();
    const api = uniqueApi('registered-mutation');
    const executed = { value: false };

    try {
      registerScriptedPiProvider({
        api,
        turns: [
          {
            content: [{
              type: 'tool_call',
              id: 'mut-1',
              name: 'write_source',
              arguments: { path: 'src.ts', content: 'export const value = 2;\n' },
            }],
            stopReason: 'toolUse',
          },
          {
            content: [{ type: 'text', text: '# Plan\n## Release Readiness\n- **database_change_risk**: none' }],
            stopReason: 'stop',
          },
        ],
      });

      const result = await launchNativePlanning({
        session: 'sess',
        issue: 'HOK-2313',
        slug: 'demo',
        wtDir,
        repoDir: REPO_DIR,
        loopModelOverride: scriptedModel(api),
        extraDescriptors: [makeMutationTool(executed)],
        runTsxCommand: stubRunTsxCommand(),
      });

      assert.equal(executed.value, false);
      assert.equal(readFileSync(sourcePath, 'utf-8'), 'export const value = 1;\n');
      const hook = JSON.parse(readFileSync(result.hookPath, 'utf-8')) as Record<string, unknown>;
      assert.equal(hook.state, 'idle');
      assert.equal(hook.event, 'process_exit');
      assert.equal(hook.detail, 'planning_completed');
    } finally {
      cleanup(wtDir);
    }
  });

  it('denies an unregistered mutation tool name', async () => {
    const { wtDir, sourcePath } = setupWorktree();
    const api = uniqueApi('unregistered-mutation');

    try {
      registerScriptedPiProvider({
        api,
        turns: [
          {
            content: [{
              type: 'tool_call',
              id: 'mut-2',
              name: 'patch_source',
              arguments: { path: 'src.ts', content: 'bad' },
            }],
            stopReason: 'toolUse',
          },
          {
            content: [{ type: 'text', text: '# Plan\n## Release Readiness\n- **database_change_risk**: none' }],
            stopReason: 'stop',
          },
        ],
      });

      await launchNativePlanning({
        session: 'sess',
        issue: 'HOK-2313',
        slug: 'demo',
        wtDir,
        repoDir: REPO_DIR,
        loopModelOverride: scriptedModel(api),
        runTsxCommand: stubRunTsxCommand(),
      });

      assert.equal(readFileSync(sourcePath, 'utf-8'), 'export const value = 1;\n');
    } finally {
      cleanup(wtDir);
    }
  });

  it('writes an error hook and no approval marker when the final assistant text is empty', async () => {
    const { wtDir, featureDir } = setupWorktree();
    const api = uniqueApi('empty-final');
    const hookPath = `/tmp/wavemill-empty-final-${Date.now()}.hook`;

    try {
      registerScriptedPiProvider({
        api,
        turns: [{ content: [], stopReason: 'stop' }],
      });

      await assert.rejects(
        () => launchNativePlanning({
          session: 'empty-final',
          issue: 'HOK-2313',
          slug: 'demo',
          wtDir,
          repoDir: REPO_DIR,
          hookPath,
          loopModelOverride: scriptedModel(api),
          runTsxCommand: stubRunTsxCommand(),
        }),
        /without a final plan/,
      );

      assert.equal(existsSync(join(featureDir, 'plan.md')), false);
      assert.equal(existsSync(join(featureDir, '.plan-approved')), false);
      const hook = JSON.parse(readFileSync(hookPath, 'utf-8')) as Record<string, unknown>;
      assert.equal(hook.state, 'error');
      assert.equal(hook.agent, 'native');
    } finally {
      cleanup(wtDir);
      rmSync(hookPath, { force: true });
    }
  });

  it('rejects non-planning phases before launching the loop', async () => {
    const { wtDir } = setupWorktree();
    const api = uniqueApi('wrong-phase');

    try {
      await assert.rejects(
        () => launchNativePlanning({
          session: 'sess',
          issue: 'HOK-2313',
          slug: 'demo',
          wtDir,
          repoDir: REPO_DIR,
          phase: 'coding',
          loopModelOverride: scriptedModel(api),
        }),
        /planning phase/,
      );
    } finally {
      cleanup(wtDir);
    }
  });
});
