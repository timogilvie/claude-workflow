import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { registerScriptedPiProvider } from './provider.ts';
import { describeNativePlanningHelperFailure, launchNativePlanning } from './launch-planning.ts';
import type { ToolDescriptor } from './tools/types.ts';
import type { ReadyNativeProviderEntry } from './providers.ts';

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

function readyOpenRouterEntry(modelId: string, api: string): ReadyNativeProviderEntry {
  return {
    providerName: 'openrouter',
    modelId,
    status: 'ready',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    baseUrl: 'https://openrouter.ai/api/v1',
    headers: {},
    model: {
      ...scriptedModel(api),
      id: `openrouter:${modelId}`,
      name: modelId,
      provider: 'scripted',
    },
    certificationOnly: false,
  };
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

function stubRunTsxCommandWithExpansion(expandedIssues: string[]): (args: string[]) => string {
  return (args: string[]) => {
    const command = args[0];
    const outputIndex = args.indexOf('--output');
    if (command === 'tools/expand-issue.ts') {
      expandedIssues.push(args[1] ?? '');
      assert.ok(outputIndex >= 0, 'expand-issue must receive --output');
      writeFileSync(args[outputIndex + 1]!, [
        '# Task Packet',
        '## 1. Objective',
        'Plan the challenger workflow.',
        '## Success Criteria',
        '- packet expands from the canonical Linear issue',
      ].join('\n'));
      return '';
    }
    if (command === 'tools/route-task.ts') {
      assert.ok(outputIndex >= 0, 'route-task must receive --output');
      writeFileSync(args[outputIndex + 1]!, `${JSON.stringify({
        planner: 'gpt-5.4',
        coder: 'gpt-5.4',
        reviewer: 'gpt-5.4',
        planDepth: 'light',
      }, null, 2)}\n`);
      return '';
    }
    throw new Error(`unexpected tsx command: ${args.join(' ')}`);
  };
}

function writeNativeConfig(
  repoDir: string,
  config: Record<string, unknown>,
): void {
  writeFileSync(join(repoDir, '.wavemill-config.json'), `${JSON.stringify(config, null, 2)}\n`);
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
  it('writes plan.md, leaves approval to the monitor, and idles the native hook on success', async () => {
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
      assert.equal(existsSync(join(featureDir, '.plan-approved')), false);
      const stageResult = JSON.parse(
        readFileSync(join(featureDir, '.planning-result.json'), 'utf-8'),
      ) as Record<string, unknown>;
      assert.equal(stageResult.status, 'awaiting_user');
      assert.equal(stageResult.finishedAt, null);
      assert.equal(stageResult.agent, 'native');
      assert.equal(stageResult.model, `scripted:${api}`);
      assert.equal(stageResult.notes, 'Native planning ready for approval');
      assert.deepEqual(stageResult.artifacts, {
        type: 'planning',
        planFile: 'features/demo/plan.md',
        taskPacketFile: 'features/demo/task-packet.md',
      });

      const hook = JSON.parse(readFileSync(result.hookPath, 'utf-8')) as Record<string, unknown>;
      assert.equal(hook.state, 'idle');
      assert.equal(hook.agent, 'native');
      assert.equal(hook.event, 'process_exit');
      assert.equal(hook.detail, 'planning_awaiting_user');
    } finally {
      cleanup(wtDir);
    }
  });

  it('expands challenger task packets with the canonical Linear issue id', async () => {
    const { wtDir, featureDir, packetPath } = setupWorktree();
    const api = uniqueApi('challenger-linear-issue');
    const expandedIssues: string[] = [];
    writeFileSync(packetPath, 'raw challenger context without task packet sections\n');

    try {
      registerScriptedPiProvider({
        api,
        turns: [{
          content: [{
            type: 'text',
            text: '# Challenger Plan\n## Release Readiness\n- **database_change_risk**: none',
          }],
          stopReason: 'stop',
        }],
      });

      await launchNativePlanning({
        session: 'sess',
        issue: 'HOK-2464_c',
        linearIssue: 'HOK-2464',
        slug: 'demo',
        wtDir,
        repoDir: REPO_DIR,
        title: 'Plan challenger',
        loopModelOverride: scriptedModel(api),
        runTsxCommand: stubRunTsxCommandWithExpansion(expandedIssues),
      });

      assert.deepEqual(expandedIssues, ['HOK-2464']);
      assert.match(readFileSync(join(featureDir, 'plan.md'), 'utf-8'), /# Challenger Plan/);
    } finally {
      cleanup(wtDir);
    }
  });

  it('falls back from a synthetic challenger id to the root Linear issue id during expansion', async () => {
    const { wtDir, packetPath } = setupWorktree();
    const api = uniqueApi('challenger-suffix-fallback');
    const expandedIssues: string[] = [];
    writeFileSync(packetPath, 'raw challenger context without task packet sections\n');

    try {
      registerScriptedPiProvider({
        api,
        turns: [{
          content: [{
            type: 'text',
            text: '# Challenger Plan\n## Release Readiness\n- **database_change_risk**: none',
          }],
          stopReason: 'stop',
        }],
      });

      await launchNativePlanning({
        session: 'sess',
        issue: 'HOK-2464_c',
        slug: 'demo',
        wtDir,
        repoDir: REPO_DIR,
        loopModelOverride: scriptedModel(api),
        runTsxCommand: stubRunTsxCommandWithExpansion(expandedIssues),
      });

      assert.deepEqual(expandedIssues, ['HOK-2464']);
    } finally {
      cleanup(wtDir);
    }
  });

  it('materializes task-packet.md from structured selected-task.json before expanding', async () => {
    const { wtDir, featureDir, packetPath } = setupWorktree();
    const api = uniqueApi('selected-task-materialized');
    const helperCommands: string[] = [];
    rmSync(packetPath, { force: true });
    writeFileSync(join(featureDir, 'selected-task.json'), `${JSON.stringify({
      taskId: 'HOK-2464_c',
      title: 'Wavemill auto-advances blocked coding',
      description: [
        '# Wavemill Auto-Advances Blocked Coding - Quick Reference',
        '## Objective',
        'Add a liveness guard.',
        '## Success Criteria',
        '- no silent advance',
      ].join('\n'),
    }, null, 2)}\n`);

    try {
      registerScriptedPiProvider({
        api,
        turns: [{
          content: [{
            type: 'text',
            text: '# Plan\n## Release Readiness\n- **database_change_risk**: none',
          }],
          stopReason: 'stop',
        }],
      });

      await launchNativePlanning({
        session: 'sess',
        issue: 'HOK-2464_c',
        linearIssue: 'HOK-2464',
        slug: 'demo',
        wtDir,
        repoDir: REPO_DIR,
        loopModelOverride: scriptedModel(api),
        runTsxCommand: (args: string[]) => {
          helperCommands.push(args[0] ?? '');
          if (args[0] === 'tools/expand-issue.ts') {
            throw new Error('expand should not run when selected-task has structured task content');
          }
          if (args[0] === 'tools/route-task.ts') {
            const outputIndex = args.indexOf('--output');
            assert.ok(outputIndex >= 0, 'route-task must receive --output');
            writeFileSync(args[outputIndex + 1]!, `${JSON.stringify({
              planner: 'gpt-5.4',
              coder: 'gpt-5.4',
              reviewer: 'gpt-5.4',
              planDepth: 'light',
            }, null, 2)}\n`);
            return '';
          }
          throw new Error(`unexpected tsx command: ${args.join(' ')}`);
        },
      });

      assert.deepEqual(helperCommands, ['tools/route-task.ts']);
      assert.match(readFileSync(packetPath, 'utf-8'), /Quick Reference/);
      assert.match(readFileSync(join(featureDir, 'plan.md'), 'utf-8'), /# Plan/);
    } finally {
      cleanup(wtDir);
    }
  });

  it('normalizes helper ETIMEDOUT errors with command context', () => {
    const timeout = new Error('spawnSync npx ETIMEDOUT') as Error & { code: string };
    timeout.code = 'ETIMEDOUT';

    const error = describeNativePlanningHelperFailure(timeout, [
      'tools/expand-issue.ts',
      'HOK-2464',
      '--output',
      '/tmp/task-packet.md',
    ], 720000);

    assert.match(error.message, /Native planning helper timed out after 720000ms/);
    assert.match(error.message, /npx tsx tools\/expand-issue\.ts HOK-2464 --output \/tmp\/task-packet\.md/);
    assert.doesNotMatch(error.message, /^spawnSync npx ETIMEDOUT$/);
  });

  it('selects the ready provider matching the routed OpenRouter alias', async () => {
    const { wtDir, featureDir } = setupWorktree();
    const qwenApi = uniqueApi('qwen-provider');
    const kimiApi = uniqueApi('kimi-provider');

    try {
      registerScriptedPiProvider({
        api: qwenApi,
        turns: [{
          content: [{
            type: 'text',
            text: '# Wrong Provider\n## Release Readiness\n- **database_change_risk**: none',
          }],
          stopReason: 'stop',
        }],
      });
      registerScriptedPiProvider({
        api: kimiApi,
        turns: [{
          content: [{
            type: 'text',
            text: '# Kimi Provider\n## Release Readiness\n- **database_change_risk**: none',
          }],
          stopReason: 'stop',
        }],
      });

      const result = await launchNativePlanning({
        session: 'sess',
        issue: 'HOK-2464_c',
        slug: 'demo',
        wtDir,
        repoDir: REPO_DIR,
        resolvedModel: 'kimi-k2.7-code',
        providerEntries: [
          readyOpenRouterEntry('qwen/qwen3-coder', qwenApi),
          readyOpenRouterEntry('moonshotai/kimi-k2.7-code', kimiApi),
        ],
        runTsxCommand: stubRunTsxCommand(),
      });

      assert.equal(result.model, 'moonshotai/kimi-k2.7-code');
      assert.match(readFileSync(join(featureDir, 'plan.md'), 'utf-8'), /# Kimi Provider/);
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
      assert.equal(hook.detail, 'planning_awaiting_user');
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

  it('writes cleanup details to the planning stage result on abort', async () => {
    const { wtDir, featureDir } = setupWorktree();
    const api = uniqueApi('aborted');
    const hookPath = `/tmp/wavemill-aborted-${Date.now()}.hook`;
    const controller = new AbortController();
    controller.abort();

    try {
      await assert.rejects(
        () => launchNativePlanning({
          session: 'aborted',
          issue: 'HOK-2313',
          slug: 'demo',
          wtDir,
          repoDir: REPO_DIR,
          hookPath,
          loopModelOverride: scriptedModel(api),
          runTsxCommand: stubRunTsxCommand(),
          signal: controller.signal,
        }),
        /without a final plan/,
      );

      const stageResult = JSON.parse(
        readFileSync(join(featureDir, '.planning-result.json'), 'utf-8'),
      ) as Record<string, unknown>;
      assert.equal(stageResult.status, 'aborted');
      assert.equal(stageResult.finalTreeState, 'clean');
      assert.equal(stageResult.cleanupDecision, 'no-action-needed');
      assert.equal((stageResult.cleanupReport as Record<string, unknown>).reason, 'aborted');
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

  it('surfaces actionable provider-resolution failures when no planning provider is ready', async () => {
    const { wtDir } = setupWorktree();
    const originalOpenAiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'test-openai-key';
    writeNativeConfig(wtDir, {
      nativeAgent: {
        enabled: true,
        allowedPhases: ['planning'],
        providers: {
          openai: {
            models: ['uncertified-model'],
          },
        },
      },
    });

    try {
      await assert.rejects(
        () => launchNativePlanning({
          session: 'sess',
          issue: 'HOK-2313',
          slug: 'demo',
          wtDir,
          repoDir: wtDir,
          runTsxCommand: stubRunTsxCommand(),
        }),
        (error: unknown) => error instanceof Error
          && /openai:uncertified-model/.test(error.message)
          && /reason=unregistered_model/.test(error.message)
          && /wavemill native-agent models report --json/.test(error.message)
          && /native-agent-certify\.ts --provider openai --model uncertified-model --phase read-only/.test(error.message),
      );
    } finally {
      if (originalOpenAiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalOpenAiKey;
      }
      cleanup(wtDir);
    }
  });
});
