#!/usr/bin/env -S npx tsx

import { runTool } from '../shared/lib/tool-runner.ts';
import {
  SMOKE_PROVIDERS,
  SMOKE_PHASES,
  runNativeAgentDryRun,
  runNativeAgentLive,
  type SmokeProvider,
  type SmokePhase,
  type NativeSmokeResult,
} from '../shared/lib/native-agent/smoke.ts';

function formatResult(mode: 'dry-run' | 'live', result: NativeSmokeResult): string {
  const lines: string[] = [];

  const outcomeLabel = result.outcome === 'skipped' ? 'SKIPPED' : 'OK';
  lines.push(`[${mode}] ${outcomeLabel}`);
  lines.push(`Provider:    ${result.provider}`);
  lines.push(`Model:       ${result.modelId}`);
  lines.push(`Phase:       ${result.phase}`);
  lines.push(`API key env: ${result.apiKeyEnv}`);

  if (result.skipReason) {
    lines.push(`Skip reason: ${result.skipReason}`);
  }

  if (result.exposedTools.length > 0) {
    lines.push(`Exposed tools (${result.exposedTools.length}):`);
    for (const tool of result.exposedTools) {
      lines.push(`  - ${tool}`);
    }
  }

  if (result.transcriptPath) {
    lines.push(`Transcript:  ${result.transcriptPath}`);
  }

  if (result.usage) {
    const u = result.usage;
    lines.push(`Usage:       ${u.inputTokens} in / ${u.outputTokens} out tokens`);
    lines.push(`             ${u.turnsCompleted} turns, ${u.toolCallsExecuted} tool calls, ${u.wallClockMs}ms`);
  }

  return lines.join('\n');
}

function formatJson(mode: 'dry-run' | 'live', result: NativeSmokeResult): string {
  return JSON.stringify({ mode, ...result }, null, 2);
}

runTool({
  name: 'smoke-native-agent',
  description: [
    'Smoke test the native agent read-only loop for OpenAI or OpenRouter providers.',
    `Providers: ${SMOKE_PROVIDERS.join(', ')}. Phases: ${SMOKE_PHASES.join(', ')}.`,
  ].join(' '),
  options: {
    provider: {
      type: 'string',
      description: `Provider to smoke test. One of: ${SMOKE_PROVIDERS.join(', ')}. Default: openai.`,
    },
    phase: {
      type: 'string',
      description: `Agent phase. One of: ${SMOKE_PHASES.join(', ')}. Default: planning.`,
    },
    'dry-run': {
      type: 'boolean',
      description: 'Validate without API keys (default when --live is not set).',
    },
    live: {
      type: 'boolean',
      description: 'Run a real provider round-trip. Skips cleanly when the key is absent.',
    },
    json: {
      type: 'boolean',
      description: 'Emit machine-readable JSON.',
    },
    repo: {
      type: 'string',
      description: 'Repository directory. Defaults to current working directory.',
    },
  },
  async run({ args }) {
    const rawProvider = (args.provider as string | undefined) ?? 'openai';
    const rawPhase = (args.phase as string | undefined) ?? 'planning';
    const isLive = args.live === true;
    const repoDir = (args.repo as string | undefined) || process.cwd();

    if (!(SMOKE_PROVIDERS as readonly string[]).includes(rawProvider)) {
      console.error(
        `Invalid --provider "${rawProvider}". Must be one of: ${SMOKE_PROVIDERS.join(', ')}`,
      );
      process.exit(1);
    }

    if (!(SMOKE_PHASES as readonly string[]).includes(rawPhase)) {
      console.error(
        `Invalid --phase "${rawPhase}". Must be one of: ${SMOKE_PHASES.join(', ')}`,
      );
      process.exit(1);
    }

    const provider = rawProvider as SmokeProvider;
    const phase = rawPhase as SmokePhase;
    const smokeOptions = { provider, phase, repoDir };

    const mode: 'dry-run' | 'live' = isLive ? 'live' : 'dry-run';
    const result = isLive
      ? await runNativeAgentLive(smokeOptions)
      : await runNativeAgentDryRun(smokeOptions);

    const output = args.json === true
      ? formatJson(mode, result)
      : formatResult(mode, result);

    console.log(output);
  },
});
