#!/usr/bin/env -S npx tsx

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getNativeAgentConfig } from '../shared/lib/config.ts';
import { getEffectiveRegistry, getModel } from '../shared/lib/model-registry.ts';
import { isPatchCodingEnabled } from '../shared/lib/native-agent/coding-gate.ts';
import { resolveNativeLauncherPath } from '../shared/lib/native-agent/install-paths.ts';
import { validateNativeOpenRouterConfig } from '../shared/lib/native-openrouter-config-validation.ts';
import { resolveNativeAgentProviders } from '../shared/lib/native-agent/providers.ts';
import {
  equivalentOpenRouterModelIds,
  resolveLaunchPriorityModel,
} from '../shared/lib/openrouter-catalog.ts';

type NativeAgent = 'native-openai' | 'native-openrouter';
type NativePhase = 'planning' | 'coding' | 'review';

export type CheckNativeAgentLaunchSuccess = {
  ok: true;
  phase: NativePhase;
  agent: NativeAgent;
  model: string;
  provider: 'openai' | 'openrouter';
  command?: ReturnType<typeof validateNativeOpenRouterConfig>['command'];
  launcher: 'native-planning' | 'native-coding' | 'native-review';
};

export type CheckNativeAgentLaunchFailure = {
  ok: false;
  reason: string;
  code?: string;
  surface?: string;
  remediation?: string;
  wavemillAlias?: string;
  openrouterId?: string;
};

export type CheckNativeAgentLaunchResult = CheckNativeAgentLaunchSuccess | CheckNativeAgentLaunchFailure;

export interface CheckNativeAgentLaunchInput {
  repoDir: string;
  agent: NativeAgent | string;
  phase: NativePhase | string;
  model: string;
}

function readOption(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function reject(reason: string, extra: Omit<CheckNativeAgentLaunchFailure, 'ok' | 'reason'> = {}): CheckNativeAgentLaunchFailure {
  return { ok: false, reason, ...extra };
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
function canonicalModelIds(providerName: 'openai' | 'openrouter', modelId: string): Set<string> {
  if (providerName !== 'openrouter') {
    return new Set([modelId]);
  }
  return new Set(equivalentOpenRouterModelIds(modelId));
}

export function checkNativeAgentLaunch(input: CheckNativeAgentLaunchInput): CheckNativeAgentLaunchResult {
  const { repoDir, agent, phase } = input;
  const model = input.model.trim();

  if (agent !== 'native-openai' && agent !== 'native-openrouter') {
    return reject(`unsupported native agent '${agent || '(empty)'}'`, { code: 'unsupported-native-agent' });
  }
  if (phase !== 'planning' && phase !== 'coding' && phase !== 'review') {
    return reject(`unsupported native launch phase '${phase || '(empty)'}'`, { code: 'unsupported-native-stage' });
  }
  if (!model) {
    return reject('native launch requires a resolved model', { code: 'missing-model' });
  }

  // A first-party OpenAI model belongs on the ChatGPT-authenticated Codex
  // surface. Do not let a direct native-launch invocation bypass the router
  // and spend API/OpenRouter credentials for the same model.
  const capabilities = getModel(getEffectiveRegistry(repoDir), model);
  if (capabilities?.vendor === 'openai') {
    return reject(
      `OpenAI model ${model} must use the ChatGPT Codex harness, not ${agent}.`,
      {
        code: 'hosted-openai-model',
        surface: 'globalModelRegistry.models',
        remediation: 'Route the model through codex, or choose a third-party model certified for the requested native provider.',
      },
    );
  }

  const providerName = providerNameForAgent(agent);
  const openRouterValidation = providerName === 'openrouter'
    ? validateNativeOpenRouterConfig({ repoDir, model, phase })
    : null;
  if (openRouterValidation && !openRouterValidation.ok) {
    const blocker = openRouterValidation.blockers[0]!;
    return reject(blocker.detail, {
      code: blocker.code,
      surface: blocker.surface,
      remediation: blocker.remediation,
      ...(openRouterValidation.identity
        ? {
          wavemillAlias: openRouterValidation.identity.wavemillAlias,
          openrouterId: openRouterValidation.identity.openrouterId,
        }
        : {}),
    });
  }

  const config = getNativeAgentConfig(repoDir);

  if (config.enabled !== true) {
    return reject('nativeAgent.enabled must be true');
  }

  if (!config.allowedPhases?.includes(phase)) {
    return reject(`nativeAgent.allowedPhases does not include '${phase}'`);
  }

  if (phase === 'coding') {
    const gate = isPatchCodingEnabled(repoDir);
    if (!gate.enabled) {
      return reject(`native coding is not enabled (${gate.reason})`);
    }

    // Resolved from the wavemill installation, not repoDir: consumer repos
    // have no tools/ directory, and the launcher imports ../shared/lib/... so
    // a copy inside one could not run anyway.
    const launcherPath = resolveNativeLauncherPath('coding');
    if (!existsSync(launcherPath)) {
      return reject(`native coding launcher is unavailable (missing ${launcherPath})`);
    }
  }

  const entries = resolveNativeAgentProviders(repoDir, { phase });
  const requestedModels = canonicalModelIds(providerName, model);
  const entry = entries.find((candidate) => (
    candidate.providerName === providerName
    && [...canonicalModelIds(providerName, candidate.modelId)].some((candidateModel) => requestedModels.has(candidateModel))
  ));

  if (!entry) {
    return reject(`native provider ${providerName}/${model} is not configured for ${phase}`);
  }

  if (entry.status !== 'ready') {
    return reject(entry.reason);
  }

  // Role-eligibility gate: reject models that are configured and ready but not
  // eligible for this phase (e.g. a coding-only model routed to planning). Models
  // absent from the launch-priority list carry no eligibility metadata, so they
  // are allowed through rather than blocked on missing data.
  const launchPriorityModel = resolveLaunchPriorityModel(model);
  if (launchPriorityModel && !launchPriorityModel.roleEligibility.includes(phase)) {
    const eligibleRoles = launchPriorityModel.roleEligibility.join(', ') || 'none';
    return reject(`native provider ${providerName}/${model} is not eligible for ${phase} (eligible roles: ${eligibleRoles})`);
  }

  return {
    ok: true,
    phase,
    agent,
    model,
    provider: providerName,
    ...(openRouterValidation?.command ? { command: openRouterValidation.command } : {}),
    launcher: phase === 'planning'
      ? 'native-planning'
      : phase === 'coding'
        ? 'native-coding'
        : 'native-review',
  };
}

function main(): void {
  const repoDir = resolve(readOption('repo-dir') ?? process.cwd());
  const agent = (readOption('agent') ?? '') as NativeAgent;
  const phase = (readOption('phase') ?? '') as NativePhase;
  const model = (readOption('model') ?? '').trim();

  const result = checkNativeAgentLaunch({ repoDir, agent, phase, model });

  process.stdout.write(JSON.stringify(result));
  if (!result.ok) {
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
