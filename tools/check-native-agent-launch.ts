#!/usr/bin/env -S npx tsx

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getNativeAgentConfig } from '../shared/lib/config.ts';
import { isPatchCodingEnabled } from '../shared/lib/native-agent/coding-gate.ts';
import { resolveNativeAgentProviders } from '../shared/lib/native-agent/providers.ts';

type NativeAgent = 'native-openai' | 'native-openrouter';
type NativePhase = 'planning' | 'coding' | 'review';

function readOption(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function fail(reason: string): never {
  process.stdout.write(JSON.stringify({ ok: false, reason }));
  process.exit(1);
}

function providerNameForAgent(agent: NativeAgent): 'openai' | 'openrouter' {
  return agent === 'native-openai' ? 'openai' : 'openrouter';
}

function main(): void {
  const repoDir = resolve(readOption('repo-dir') ?? process.cwd());
  const agent = (readOption('agent') ?? '') as NativeAgent;
  const phase = (readOption('phase') ?? '') as NativePhase;
  const model = (readOption('model') ?? '').trim();

  if (agent !== 'native-openai' && agent !== 'native-openrouter') {
    fail(`unsupported native agent '${agent || '(empty)'}'`);
  }
  if (phase !== 'planning' && phase !== 'coding' && phase !== 'review') {
    fail(`unsupported native launch phase '${phase || '(empty)'}'`);
  }
  if (!model) {
    fail('native launch requires a resolved model');
  }

  const providerName = providerNameForAgent(agent);
  const config = getNativeAgentConfig(repoDir);

  if (config.enabled !== true) {
    fail('nativeAgent.enabled must be true');
  }

  if (!config.allowedPhases?.includes(phase)) {
    fail(`nativeAgent.allowedPhases does not include '${phase}'`);
  }

  if (phase === 'coding') {
    const gate = isPatchCodingEnabled(repoDir);
    if (!gate.enabled) {
      fail(`native coding is not enabled (${gate.reason})`);
    }

    const launcherPath = join(repoDir, 'tools', 'launch-native-coding.ts');
    if (!existsSync(launcherPath)) {
      fail('native coding launcher is unavailable (missing tools/launch-native-coding.ts)');
    }

    fail('native coding shell dispatch is not implemented');
  }

  const entries = resolveNativeAgentProviders(repoDir, { phase });
  const entry = entries.find((candidate) => (
    candidate.providerName === providerName && candidate.modelId === model
  ));

  if (!entry) {
    fail(`native provider ${providerName}/${model} is not configured for ${phase}`);
  }

  if (entry.status !== 'ready') {
    fail(entry.reason);
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    phase,
    agent,
    model,
    provider: providerName,
    launcher: phase === 'planning' ? 'native-planning' : 'native-review',
  }));
}

main();
