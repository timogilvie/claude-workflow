#!/usr/bin/env -S npx tsx

import { resolve } from 'node:path';
import {
  getNativeOpenRouterProviderConfig,
  getOpenRouterProviderConfig,
} from '../shared/lib/config.ts';
import { errorMessage } from '../shared/lib/error-utils.ts';
import { fetchOpenRouterCredits } from '../shared/lib/openrouter-credits.ts';
import { writeOpenRouterCredits } from '../shared/lib/quota-state.ts';
import { runTool } from '../shared/lib/tool-runner.ts';

runTool({
  name: 'refresh-openrouter-credits',
  description: 'Refresh cached OpenRouter prepaid credit balance.',
  options: {
    'repo-dir': {
      type: 'string',
      description: 'Repository directory containing .wavemill/quota-state.json',
    },
    'timeout-ms': {
      type: 'string',
      description: 'Maximum HTTP time before aborting the refresh',
      default: '5000',
    },
  },
  examples: [
    'npx tsx tools/refresh-openrouter-credits.ts --repo-dir .',
  ],
  async run({ args }) {
    const repoDir = resolve(args['repo-dir'] ?? process.cwd());
    const timeoutMs = parseTimeout(args['timeout-ms']);
    const nativeProvider = getNativeOpenRouterProviderConfig(repoDir);
    const provider = getOpenRouterProviderConfig(repoDir);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const credits = await fetchOpenRouterCredits({
        apiKeyEnv: nativeProvider.apiKeyEnv ?? provider.apiKeyEnv,
        baseUrl: nativeProvider.baseUrl ?? provider.baseUrl,
        signal: controller.signal,
      });
      if (!credits) {
        writeOpenRouterCredits(repoDir, { error: 'OpenRouter API key is missing or unauthorized.' });
        return;
      }
      writeOpenRouterCredits(repoDir, {
        ...credits,
        updatedAt: new Date().toISOString(),
        lastFetchError: null,
      });
      console.log(JSON.stringify({ ok: true, balanceUsd: credits.balanceUsd }));
    } catch (error) {
      writeOpenRouterCredits(repoDir, { error: errorMessage(error) });
      console.warn(`OpenRouter credits refresh failed: ${errorMessage(error)}`);
    } finally {
      clearTimeout(timer);
    }
  },
});

function parseTimeout(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5000;
}
