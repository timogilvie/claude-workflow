#!/usr/bin/env -S npx tsx
import { getNativeAgentConfig } from '../shared/lib/config.ts';
import { resolveNativeAgentProviders } from '../shared/lib/native-agent/providers.ts';

const repoDir = process.argv[2] || process.cwd();
const phase = process.argv[3] || 'planning';

try {
  const config = getNativeAgentConfig(repoDir);
  if (config.enabled !== true || !config.allowedPhases?.includes(phase as 'planning')) {
    process.exit(1);
  }

  const ready = resolveNativeAgentProviders(repoDir, { phase })
    .find((entry) => entry.status === 'ready');

  if (!ready) {
    console.warn(`[native-planning] No certified native provider ready for phase=${phase}`);
    process.exit(1);
  }

  process.stdout.write(`${ready.modelId}\n`);
} catch (err) {
  console.warn(`[native-planning] Eligibility check failed: ${(err as Error).message}`);
  process.exit(1);
}
