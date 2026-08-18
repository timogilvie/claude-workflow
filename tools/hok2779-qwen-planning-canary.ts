#!/usr/bin/env -S npx tsx
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { buildLaunchabilityMatrix } from '../shared/lib/launchable-models.ts';
import { resolveModelAgent } from '../shared/lib/model-agent-resolution.ts';
import { getEffectiveRegistry } from '../shared/lib/model-registry.ts';
import { filterNativeModels } from '../shared/lib/native-agent/certification/router-filter.ts';
import { buildGlobalCertificationPath } from '../shared/lib/native-agent/certification/index.ts';
import { launchNativePlanning } from '../shared/lib/native-agent/launch-planning.ts';
import { resolveNativeAgentProviders, type ReadyNativeProviderEntry } from '../shared/lib/native-agent/providers.ts';
import { checkNativeAgentLaunch } from './check-native-agent-launch.ts';

export interface QwenPlanningCanaryOptions {
  repoDir?: string;
  dryRun?: boolean;
  evidenceJsonPath?: string;
  evidenceMarkdownPath?: string;
}

function readArtifactSummary() {
  const path = buildGlobalCertificationPath('qwen', 'qwen3-coder', 'v2');
  if (!existsSync(path)) return { path, present: false };
  const artifact = JSON.parse(readFileSync(path, 'utf-8')) as {
    certifiedAt?: string;
    phase?: string;
    suiteVersion?: string;
    scenarios?: unknown[];
  };
  return {
    path,
    present: true,
    certifiedAt: artifact.certifiedAt,
    phase: artifact.phase,
    suiteVersion: artifact.suiteVersion,
    scenarioCount: Array.isArray(artifact.scenarios) ? artifact.scenarios.length : 0,
  };
}

function runTsxCanaryHelper(args: string[]): string {
  const outputIndex = args.indexOf('--output');
  if (outputIndex < 0) return '';
  const outputPath = args[outputIndex + 1];
  assert.ok(outputPath, 'expected --output path');
  mkdirSync(dirname(outputPath), { recursive: true });
  if (args[0] === 'tools/expand-issue.ts') {
    writeFileSync(outputPath, [
      '# HOK-2779 Qwen Planning Canary Task Packet',
      '',
      '## Objective',
      'Verify qwen-3-coder can produce a safe native planning artifact for HOK-2779.',
      '',
      '## Required Final Artifact',
      'Return final Markdown only. The first line must be exactly:',
      '# HOK-2779 Qwen Planning Canary',
      '',
      'The artifact must include these sections:',
      '- ## Summary',
      '- ## Implementation Plan',
      '- ## Validation',
      '- ## Release Readiness',
      '',
      'The ## Release Readiness section must include these exact bullets:',
      '- **database_change_risk**: none',
      '- **env_changes**: none',
      '- **config_changes**: none',
      '- **manual_steps**: none',
      '',
      '## Success Criteria',
      '- Produce an implementation plan that starts with the required top-level title.',
      '- Include the exact Release Readiness field keys listed above.',
    ].join('\n'), 'utf-8');
    return '';
  }
  if (args[0] === 'tools/route-task.ts') {
    writeFileSync(outputPath, `${JSON.stringify({
      planner: 'qwen-3-coder',
      coder: 'gpt-5.6-terra',
      reviewer: 'gpt-5.5',
      planDepth: 'light',
    }, null, 2)}\n`, 'utf-8');
  }
  return '';
}

function writeEvidence(path: string | undefined, content: string): void {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf-8');
}

export async function runHok2779QwenPlanningCanary(options: QwenPlanningCanaryOptions = {}) {
  const repoDir = resolve(options.repoDir ?? process.cwd());
  const registry = getEffectiveRegistry(repoDir);
  const preflight = checkNativeAgentLaunch({
    repoDir,
    phase: 'planning',
    agent: 'native-openrouter',
    model: 'qwen-3-coder',
  });
  const router = filterNativeModels(['qwen-3-coder'], 'planner', registry, repoDir);
  const resolution = resolveModelAgent({ model: 'qwen-3-coder', phase: 'planning', registry, repoDir });
  const matrix = buildLaunchabilityMatrix({ repoDir, registry });
  const advertised = matrix.advertisedModels.planner.includes('qwen-3-coder');
  const gateOk = preflight.ok && router.eligible.includes('qwen-3-coder') && resolution.ok && advertised;

  let launch: Record<string, unknown> | null = null;
  let launchError: string | null = null;
  if (gateOk && !options.dryRun) {
    const wtDir = mkdtempSync(join(tmpdir(), 'hok2779-qwen-planning-'));
    execFileSync('git', ['init', wtDir], { stdio: 'pipe' });
    execFileSync('git', ['-C', wtDir, 'config', 'user.email', 'native@wavemill.test'], { stdio: 'pipe' });
    execFileSync('git', ['-C', wtDir, 'config', 'user.name', 'Native Planning Canary'], { stdio: 'pipe' });
    writeFileSync(join(wtDir, 'README.md'), '# HOK-2779 canary\n', 'utf-8');
    execFileSync('git', ['-C', wtDir, 'add', '.'], { stdio: 'pipe' });
    execFileSync('git', ['-C', wtDir, 'commit', '-m', 'canary fixture'], { stdio: 'pipe' });
    const providerEntries = resolveNativeAgentProviders(repoDir, {
      phase: 'planning',
      requiredCertificationPhase: 'workflow',
    }).filter((entry): entry is ReadyNativeProviderEntry => (
      entry.status === 'ready' && (entry.modelId === 'qwen/qwen3-coder' || entry.modelId === 'qwen-3-coder')
    )).map((entry) => ({
      ...entry,
      model: { ...entry.model, maxTokens: 4096 },
    }));
    try {
      const result = await launchNativePlanning({
        session: 'hok2779',
        issue: 'HOK-2779',
        slug: 'hok-2779-qwen-planning-canary',
        wtDir,
        repoDir,
        resolvedModel: 'qwen-3-coder',
        planDepth: 'light',
        title: 'HOK-2779 Qwen Planning Canary',
        issueContext: [
          'This is a live launch canary for qwen-3-coder native OpenRouter planning.',
          'Return only the final Markdown planning artifact.',
          'Start the final answer with exactly: # HOK-2779 Qwen Planning Canary',
          'Do not include prefatory commentary before the top-level title.',
          'In ## Release Readiness, include exact bullets for **database_change_risk**, **env_changes**, **config_changes**, and **manual_steps**.',
        ].join('\n'),
        providerEntries,
        runTsxCommand: runTsxCanaryHelper,
      });
      launch = {
        ...result,
        planBytes: statSync(result.planPath).size,
        transcriptBytes: existsSync(result.transcriptPath) ? statSync(result.transcriptPath).size : 0,
        planningResult: existsSync(join(wtDir, 'features', 'hok-2779-qwen-planning-canary', '.planning-result.json'))
          ? JSON.parse(readFileSync(join(wtDir, 'features', 'hok-2779-qwen-planning-canary', '.planning-result.json'), 'utf-8'))
          : null,
      };
    } catch (error) {
      launchError = (error as Error).message;
    }
  }

  const evidence = {
    schemaVersion: 1,
    issue: 'HOK-2779',
    generatedAt: new Date().toISOString(),
    dryRun: Boolean(options.dryRun),
    model: { alias: 'qwen-3-coder', openrouterId: 'qwen/qwen3-coder' },
    artifact: readArtifactSummary(),
    gates: { gateOk, preflight, router, resolution, advertisedPlanner: advertised },
    launch,
    launchError,
  };
  writeEvidence(options.evidenceJsonPath, `${JSON.stringify(evidence, null, 2)}\n`);
  writeEvidence(options.evidenceMarkdownPath, [
    '# HOK-2779 Qwen Planning Canary',
    '',
    `Generated: ${evidence.generatedAt}`,
    `Mode: ${options.dryRun ? 'dry-run' : 'live'}`,
    'No secrets were printed or persisted.',
    '',
    `Preflight: ${preflight.ok ? 'ok' : 'blocked'}`,
    `Router planner pool: ${router.eligible.includes('qwen-3-coder') ? 'eligible' : 'blocked'}`,
    `Agent resolution: ${resolution.ok ? 'ok' : 'blocked'}`,
    `Launchability advertised planner: ${advertised ? 'yes' : 'no'}`,
    `Launch: ${launch ? `${launch.model} stopReason=${launch.stopReason} planBytes=${launch.planBytes}` : launchError ?? 'not run'}`,
    '',
  ].join('\n'));
  return evidence;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const repoIndex = process.argv.indexOf('--repo-dir');
  const repoDir = repoIndex >= 0 ? process.argv[repoIndex + 1] : process.cwd();
  const json = process.argv.includes('--json');
  const evidence = await runHok2779QwenPlanningCanary({
    repoDir,
    dryRun,
    evidenceJsonPath: join(resolve(repoDir), '.wavemill', 'audits', 'certifications', 'qwen-3-coder-planning-canary.json'),
    evidenceMarkdownPath: join(resolve(repoDir), '.wavemill', 'audits', 'certifications', 'qwen-3-coder-planning-canary.md'),
  });
  process.stdout.write(json ? `${JSON.stringify(evidence, null, 2)}\n` : `gateOk=${evidence.gates.gateOk}\n`);
  if (!evidence.gates.gateOk || (!dryRun && !evidence.launch)) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
