#!/usr/bin/env -S npx tsx
import { getNativeAgentConfig } from '../shared/lib/config.ts';
import { resolveNativeAgentProviders } from '../shared/lib/native-agent/providers.ts';
import {
  loadLaunchPriorityList,
  resolveLaunchPriorityModel,
  type LaunchPriorityModel,
  type RoleEligibility,
} from '../shared/lib/openrouter-catalog.ts';

const repoDir = process.argv[2] || process.cwd();
const phase = process.argv[3] || 'planning';

function isRoleEligible(modelId: string, phase: string): boolean {
  if (phase !== 'planning' && phase !== 'coding' && phase !== 'review') {
    return false;
  }

  const launchPriorityModel = resolveLaunchPriorityModel(modelId) ?? resolveStorageModelLaunchPriority(modelId);
  return !launchPriorityModel || launchPriorityModel.roleEligibility.includes(phase as RoleEligibility);
}

function resolveStorageModelLaunchPriority(modelId: string): LaunchPriorityModel | null {
  if (modelId.includes('/')) {
    return null;
  }
  const match = loadLaunchPriorityList().find((entry) => entry.openrouterId.split('/')[1] === modelId);
  return match ?? null;
}

try {
  const config = getNativeAgentConfig(repoDir);
  if (config.enabled !== true || !config.allowedPhases?.includes(phase as 'planning')) {
    process.exit(1);
  }

  const ready = resolveNativeAgentProviders(repoDir, { phase })
    .find((entry) => entry.status === 'ready' && isRoleEligible(entry.modelId, phase));

  if (!ready) {
    console.warn(`[native-planning] No role-eligible certified native provider ready for phase=${phase}`);
    process.exit(1);
  }

  process.stdout.write(`${ready.modelId}\n`);
} catch (err) {
  console.warn(`[native-planning] Eligibility check failed: ${(err as Error).message}`);
  process.exit(1);
}
