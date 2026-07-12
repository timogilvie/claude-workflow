#!/usr/bin/env -S npx tsx

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fetchOpenRouterModels,
  loadLaunchPriorityFixture,
  normalizeCatalog,
  resolveWavemillAliasFromOpenRouterId,
  type ModelFamily,
  type NormalizedCatalogEntry,
} from '../shared/lib/openrouter-catalog.ts';
import { runOpenRouterSmoke } from '../shared/lib/openrouter-smoke.ts';
import { runTool, resolveRepoDir } from '../shared/lib/tool-runner.ts';
import type { OpenRouterTransport } from '../shared/lib/openrouter-runtime.ts';

const moduleDir = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(moduleDir, '..', 'shared', 'fixtures', 'openrouter-responses', 'success');

function readFixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(fixtureDir, `${name}.json`), 'utf-8')) as Record<string, unknown>;
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as Response;
}

function createDryRunEntries(): NormalizedCatalogEntry[] {
  const fixture = loadLaunchPriorityFixture();
  const mockModels = new Map(
    fixture.models.map((model) => [
      model.openrouterId,
      {
        id: model.openrouterId,
        context_length: 200_000,
        pricing: { prompt: '0.000001', completion: '0.000002' },
      },
    ]),
  );
  return normalizeCatalog(fixture.models, mockModels, { resolvedAt: 'dry-run' }).entries;
}

function createDryRunTransport(entries: readonly NormalizedCatalogEntry[]): OpenRouterTransport {
  const familyFixtures = new Map<ModelFamily, Record<string, unknown>>([
    ['claude', readFixture('claude')],
    ['gpt', readFixture('gpt')],
    ['qwen', readFixture('qwen')],
    ['deepseek', readFixture('deepseek')],
    ['kimi', readFixture('kimi')],
    ['gemini', readFixture('gemini')],
    ['glm', readFixture('glm')],
    ['llama', readFixture('qwen')],
    ['mistral', readFixture('qwen')],
    ['grok', readFixture('qwen')],
  ]);
  const familyByOpenrouterId = new Map(entries.map((entry) => [entry.openrouterId, entry.family]));

  return async (_url, init) => {
    const payload = JSON.parse(String(init.body)) as { model: string };
    const family = familyByOpenrouterId.get(payload.model) ?? 'qwen';
    const baseFixture = familyFixtures.get(family) ?? familyFixtures.get('qwen');
    const alias = resolveWavemillAliasFromOpenRouterId(payload.model) ?? payload.model;
    return jsonResponse({
      ...baseFixture,
      id: `dry-run-${alias}`,
      model: payload.model,
    });
  };
}

function formatText(
  mode: 'dry-run' | 'live',
  reports: Awaited<ReturnType<typeof runOpenRouterSmoke>>,
): string {
  const okCount = reports.filter((report) => report.status === 'ok').length;
  const blockerCount = reports.length - okCount;
  return [
    `${mode}: ${okCount} ok, ${blockerCount} blocker${blockerCount === 1 ? '' : 's'}`,
    ...reports.map((report) =>
      report.status === 'ok'
        ? `- OK ${report.modelId}`
        : `- BLOCKER ${report.modelId} [${report.category}] ${report.detail}`),
  ].join('\n');
}

runTool({
  name: 'openrouter-smoke',
  description: 'Run a dry-run or gated live smoke sweep across launch-priority OpenRouter models.',
  options: {
    live: { type: 'boolean', description: 'Run the live OpenRouter smoke after the dry-run passes.' },
    json: { type: 'boolean', description: 'Emit machine-readable JSON.' },
    prompt: { type: 'string', description: 'Override the smoke prompt (default: ping).' },
    'repo-dir': { type: 'string', description: 'Repository directory to resolve before running.' },
  },
  async run({ args }) {
    process.chdir(resolveRepoDir(args['repo-dir'] as string | undefined));

    const prompt = (args.prompt as string | undefined) || 'ping';
    const dryRunEntries = createDryRunEntries();
    const dryRun = await runOpenRouterSmoke({
      entries: dryRunEntries,
      transport: createDryRunTransport(dryRunEntries),
      prompt,
    });

    if (args.live !== true) {
      const output = args.json === true
        ? JSON.stringify({ mode: 'dry-run', reports: dryRun }, null, 2)
        : formatText('dry-run', dryRun);
      console.log(output);
      return;
    }

    if (process.env.OPENROUTER_LIVE_SMOKE !== '1' || !process.env.OPENROUTER_API_KEY) {
      const message = 'live: skipped because OPENROUTER_LIVE_SMOKE=1 and OPENROUTER_API_KEY are required.';
      const output = args.json === true
        ? JSON.stringify({ mode: 'dry-run', reports: dryRun, live: { skipped: true, message } }, null, 2)
        : `${formatText('dry-run', dryRun)}\n${message}`;
      console.log(output);
      return;
    }

    const liveModels = await fetchOpenRouterModels();
    const liveEntries = normalizeCatalog(loadLaunchPriorityFixture().models, liveModels).entries;
    const live = await runOpenRouterSmoke({
      entries: liveEntries,
      apiKey: process.env.OPENROUTER_API_KEY,
      prompt,
    });

    const output = args.json === true
      ? JSON.stringify({ dryRun, live }, null, 2)
      : `${formatText('dry-run', dryRun)}\n${formatText('live', live)}`;
    console.log(output);
  },
});
