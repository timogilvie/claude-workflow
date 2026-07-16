#!/usr/bin/env -S npx tsx

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getNativeAgentConfig } from '../shared/lib/config.ts';
import { isPatchCodingEnabled } from '../shared/lib/native-agent/coding-gate.ts';
import { resolveNativeAgentProviders } from '../shared/lib/native-agent/providers.ts';
import {
  resolveLaunchPriorityModel,
  resolveOpenRouterIdFromWavemillAlias,
} from '../shared/lib/openrouter-catalog.ts';

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

/**
 * Canonicalize an OpenRouter model identifier so that the wavemill alias the
 * router emits (e.g. "qwen-3-coder") and the OpenRouter slug stored in
 * nativeAgent config (e.g. "qwen/qwen3-coder") compare equal. The launcher and
 * certification gate already normalize both forms; this keeps the pre-launch
 * probe consistent so a valid alias is not rejected as "not configured".
 */
function canonicalModelId(providerName: 'openai' | 'openrouter', modelId: string): string {
  if (providerName !== 'openrouter') {
    return modelId;
  }
  if (modelId.includes('/')) {
    return modelId;
  }
  return resolveOpenRouterIdFromWavemillAlias(modelId) ?? modelId;
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
  const requestedModel = canonicalModelId(providerName, model);
  const entry = entries.find((candidate) => (
    candidate.providerName === providerName
    && canonicalModelId(providerName, candidate.modelId) === requestedModel
  ));

  if (!entry) {
    fail(`native provider ${providerName}/${model} is not configured for ${phase}`);
  }

  if (entry.status !== 'ready') {
    fail(entry.reason);
  }

  // Role-eligibility gate: reject models that are configured and ready but not
  // eligible for this phase (e.g. a coding-only model routed to planning). Models
  // absent from the launch-priority list carry no eligibility metadata, so they
  // are allowed through rather than blocked on missing data.
  const launchPriorityModel = resolveLaunchPriorityModel(model);
  if (launchPriorityModel && !launchPriorityModel.roleEligibility.includes(phase)) {
    const eligibleRoles = launchPriorityModel.roleEligibility.join(', ') || 'none';
    fail(`native provider ${providerName}/${model} is not eligible for ${phase} (eligible roles: ${eligibleRoles})`);
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
