#!/usr/bin/env -S npx tsx
import { getNativeAgentConfig } from '../shared/lib/config.ts';
import { resolveNativeAgentProviders } from '../shared/lib/native-agent/providers.ts';

export interface NativeEligibilityResult {
  eligible: boolean;
  model?: string;
  reason:
    | 'eligible'
    | 'config_disabled'
    | 'phase_not_allowed'
    | 'no_ready_provider'
    | 'lookup_failed';
}

export function checkNativeEligibility(
  repoDir: string = process.cwd(),
  phase: 'planning' = 'planning',
): NativeEligibilityResult {
  try {
    const config = getNativeAgentConfig(repoDir);
    if (config.enabled !== true) {
      return { eligible: false, reason: 'config_disabled' };
    }

    if (!config.allowedPhases?.includes(phase)) {
      return { eligible: false, reason: 'phase_not_allowed' };
    }

    const ready = resolveNativeAgentProviders(repoDir, { phase })
      .find((entry) => entry.status === 'ready');

    if (!ready) {
      return { eligible: false, reason: 'no_ready_provider' };
    }

    return {
      eligible: true,
      model: ready.modelId,
      reason: 'eligible',
    };
  } catch {
    return { eligible: false, reason: 'lookup_failed' };
  }
}

if (import.meta.main) {
  const repoDir = process.argv[2] || process.cwd();
  const phase = (process.argv[3] || 'planning') as 'planning';

  const result = checkNativeEligibility(repoDir, phase);
  if (!result.eligible || !result.model) {
    if (result.reason === 'no_ready_provider') {
      console.warn(`[native-planning] No certified native provider ready for phase=${phase}`);
    } else if (result.reason === 'lookup_failed') {
      console.warn('[native-planning] Eligibility check failed');
    }
    process.exit(1);
  }

  process.stdout.write(`${result.model}\n`);
}
