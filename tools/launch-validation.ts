#!/usr/bin/env -S npx tsx

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditLaunchPriorityCoverage } from '../shared/lib/launch-priority-audit.ts';
import {
  buildCatalogSnapshot,
  fetchOpenRouterModels,
  loadLaunchPriorityFixture,
  normalizeCatalog,
  type LaunchPriorityFixture,
  type ModelFamily,
  type NormalizedCatalog,
  type NormalizedCatalogEntry,
} from '../shared/lib/openrouter-catalog.ts';
import { runOpenRouterSmoke } from '../shared/lib/openrouter-smoke.ts';
import type { OpenRouterTransport } from '../shared/lib/openrouter-runtime.ts';
import {
  buildFixtureCatalogSnapshot,
  buildLaunchValidationArtifact,
  summarizeLaunchValidationStatus,
  type LaunchValidationArtifact,
} from '../shared/lib/launch-validation.ts';
import { runTool, resolveRepoDir, type ParsedArgs } from '../shared/lib/tool-runner.ts';
import { hashLaunchPriorityFixture } from '../shared/lib/openrouter-catalog.ts';

const DEFAULT_OUT_PATH = '.wavemill/audits/launch-validation.json';
const moduleDir = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(moduleDir, '..', 'shared', 'fixtures', 'openrouter-responses', 'success');

const options = {
  out: { type: 'string', description: 'Output JSON path' },
  'repo-dir': { type: 'string', description: 'Repository directory to audit' },
  target: { type: 'string', description: 'Coverage target per role', default: '3' },
  'max-attempts': { type: 'string', description: 'Maximum planned follow-up attempts', default: '10' },
  prompt: { type: 'string', description: 'Override the smoke prompt (default: ping).' },
  live: { type: 'boolean', description: 'Fetch the live OpenRouter catalog and run live smoke when credentials are present.' },
  json: { type: 'boolean', description: 'Print the full validation artifact as JSON' },
} as const;

type CliArgs = ParsedArgs<typeof options>;

export interface LaunchValidationToolDeps {
  loadFixture: () => LaunchPriorityFixture;
  hashFixture: () => string;
  fetchOpenRouterModels: typeof fetchOpenRouterModels;
  buildFixtureCatalogSnapshot: typeof buildFixtureCatalogSnapshot;
  runSmoke: typeof runOpenRouterSmoke;
  auditCoverage: typeof auditLaunchPriorityCoverage;
  buildArtifact: typeof buildLaunchValidationArtifact;
}

const defaultDeps: LaunchValidationToolDeps = {
  loadFixture: () => loadLaunchPriorityFixture(),
  hashFixture: () => hashLaunchPriorityFixture(),
  fetchOpenRouterModels,
  buildFixtureCatalogSnapshot,
  runSmoke: runOpenRouterSmoke,
  auditCoverage: auditLaunchPriorityCoverage,
  buildArtifact: buildLaunchValidationArtifact,
};

function parseInteger(name: string, raw: string | undefined, minimum: number): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  return value;
}

function resolveOutPath(repoDir: string, out: string | undefined): string {
  const raw = out ?? DEFAULT_OUT_PATH;
  return isAbsolute(raw) ? raw : resolve(repoDir, raw);
}

function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp-${randomUUID()}`;
  writeFileSync(tmpPath, content, 'utf-8');
  renameSync(tmpPath, path);
}

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

function createFixtureSmokeTransport(entries: readonly NormalizedCatalogEntry[]): OpenRouterTransport {
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
    return jsonResponse({
      ...baseFixture,
      id: `launch-validation-${payload.model.replaceAll('/', '-')}`,
      model: payload.model,
    });
  };
}

async function buildLiveCatalogSnapshot(
  deps: LaunchValidationToolDeps,
  fixture: LaunchPriorityFixture,
  sourceHash: string,
  now: Date,
): Promise<NormalizedCatalog> {
  const liveModels = await deps.fetchOpenRouterModels();
  const normalized = normalizeCatalog(fixture.models, liveModels, { resolvedAt: now.toISOString() });
  return buildCatalogSnapshot(normalized.entries, normalized.blockers, sourceHash, {
    generatedAt: now.toISOString(),
  });
}

function formatFamilySummary(artifact: LaunchValidationArtifact): string[] {
  return artifact.families.map((family) => {
    const success = family.successfulModels.length > 0
      ? `success=${family.successfulModels.join(',')}`
      : 'success=none';
    const blocked = family.blockedModels.length > 0
      ? `blocked=${family.blockedModels.join(',')}`
      : 'blocked=none';
    return `  ${family.family}\t${family.status}\t${success}\t${blocked}`;
  });
}

export async function runLaunchValidationCommand(
  args: CliArgs,
  deps: LaunchValidationToolDeps = defaultDeps,
): Promise<LaunchValidationArtifact> {
  const repoDir = resolveRepoDir(args['repo-dir']);
  const outPath = resolveOutPath(repoDir, args.out);
  const coverageTargetPerRole = parseInteger('--target', args.target, 1);
  const maxAttempts = parseInteger('--max-attempts', args['max-attempts'], 0);
  const prompt = args.prompt ?? 'ping';
  const now = new Date();
  const fixture = deps.loadFixture();
  const sourceHash = deps.hashFixture();
  const smokeMode = args.live === true ? 'live' as const : 'fixture' as const;

  const catalogSnapshot = args.live === true
    ? await buildLiveCatalogSnapshot(deps, fixture, sourceHash, now)
    : deps.buildFixtureCatalogSnapshot({ fixture, sourceHash, now });
  const smokeReports = await deps.runSmoke({
    entries: catalogSnapshot.entries,
    prompt,
    ...(args.live === true
      ? { apiKey: process.env.OPENROUTER_API_KEY }
      : { transport: createFixtureSmokeTransport(catalogSnapshot.entries) }),
  });
  const audit = deps.auditCoverage({
    catalog: catalogSnapshot,
    repoDir,
    coverageTargetPerRole,
    maxAttempts,
    now,
  });
  const artifact = deps.buildArtifact({
    catalogSnapshot,
    smokeReports,
    smokeMode,
    smokePrompt: prompt,
    launchPriorityFixture: fixture,
    launchPrioritySourceHash: sourceHash,
    audit,
    now,
  });
  const serialized = JSON.stringify(artifact, null, 2);

  writeAtomic(outPath, `${serialized}\n`);

  console.log(`Launch validation: ${summarizeLaunchValidationStatus(artifact)}`);
  console.log(`Artifact: ${outPath}`);
  console.log('Families:');
  for (const line of formatFamilySummary(artifact)) {
    console.log(line);
  }
  if (args.json === true) {
    console.log(serialized);
  }
  if (artifact.status === 'failed') {
    throw new Error('Launch validation found silent coverage gaps or unmet family evidence.');
  }
  return artifact;
}

export async function runLaunchValidationCli(
  argv: string[] = process.argv.slice(2),
  deps: LaunchValidationToolDeps = defaultDeps,
): Promise<void> {
  await runTool({
    name: 'launch-validation',
    description: 'Build the grouped launch-priority OpenRouter validation artifact.',
    options,
    examples: [
      'npx tsx tools/launch-validation.ts',
      'npx tsx tools/launch-validation.ts --repo-dir /path/to/repo --target 3 --max-attempts 10',
      'npx tsx tools/launch-validation.ts --live --json',
    ],
    additionalHelp: [
      'Default mode uses fixture-backed catalog and smoke responses for deterministic CI.',
      'Use --live to fetch the public OpenRouter catalog; missing OPENROUTER_API_KEY',
      'is reported as per-model smoke blockers instead of crashing the run.',
    ].join('\n'),
    run: ({ args }) => runLaunchValidationCommand(args, deps),
  }, argv);
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  await runLaunchValidationCli();
}
