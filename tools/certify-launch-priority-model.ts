#!/usr/bin/env -S npx tsx

import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listEffectiveModelsForStage } from '../shared/lib/effective-models.ts';
import { auditLaunchPriorityCoverage, type LaunchPriorityAudit, type LaunchPriorityRole, type ModelRoleEvidence } from '../shared/lib/launch-priority-audit.ts';
import { getEffectiveRegistry, getModel } from '../shared/lib/model-registry.ts';
import {
  fetchOpenRouterModels,
  loadLaunchPriorityList,
  normalizeCatalog,
  type LaunchPriorityModel,
} from '../shared/lib/openrouter-catalog.ts';
import { runOpenRouterSmoke, type SmokeReport } from '../shared/lib/openrouter-smoke.ts';
import { runTool, resolveRepoDir, type ParsedArgs } from '../shared/lib/tool-runner.ts';
import { runWavemillRouterEval } from '../src/evaluation/adapters/wavemill-router-adapter.ts';
import {
  createDryRunEntries,
  createDryRunTransport,
  sanitizeSmokeReports,
  selectSmokeEntries,
} from './openrouter-smoke.ts';

const DEFAULT_REPORT_DIR = '.wavemill/audits/certifications';
const DEFAULT_AUDIT_OUT = '.wavemill/audits/launch-priority-coverage.json';
const ROLE_TO_ROUTER_STAGE: Record<LaunchPriorityRole, 'planner' | 'coder' | 'reviewer'> = {
  planning: 'planner',
  coding: 'coder',
  review: 'reviewer',
};

const options = {
  model: { type: 'string', description: 'Wavemill alias or OpenRouter ID to certify.' },
  target: { type: 'string', description: 'Coverage target per role.', default: '3' },
  live: { type: 'boolean', description: 'Run targeted live OpenRouter smoke.' },
  persist: { type: 'boolean', description: 'Persist eval rows needed to close current coverage gaps.' },
  issue: { type: 'string', description: 'Linear issue identifier to include in the report.' },
  out: { type: 'string', description: 'Certification report path.' },
  'audit-out': { type: 'string', description: 'Launch-priority audit output path.', default: DEFAULT_AUDIT_OUT },
  prompt: { type: 'string', description: 'Smoke prompt.', default: 'ping' },
  json: { type: 'boolean', description: 'Print the certification report as JSON.' },
  'repo-dir': { type: 'string', description: 'Repository directory to certify.' },
} as const;

type CliArgs = ParsedArgs<typeof options>;

export interface CertificationCheck {
  name: 'fixture' | 'registry' | 'global-effective-pools';
  status: 'ok' | 'blocker';
  detail: string;
}

export interface CertificationRoleResult {
  role: LaunchPriorityRole;
  before: number;
  after: number;
  target: number;
  gapBefore: number;
  status: ModelRoleEvidence['status'];
}

export interface CertificationReport {
  schemaVersion: '1';
  generatedAt: string;
  issue?: string;
  model: {
    wavemillAlias: string;
    openrouterId: string;
    family: LaunchPriorityModel['family'];
    status: LaunchPriorityModel['status'];
    priorityTier: number;
    roleEligibility: LaunchPriorityRole[];
  };
  target: number;
  persist: boolean;
  checks: CertificationCheck[];
  smoke: {
    dryRun: SmokeReport[];
    live?: SmokeReport[] | { skipped: true; message: string };
  };
  eval: {
    plannedRuns: number;
    executedRuns: number;
    persistedIds: string[];
  };
  audit: {
    zeroEvidenceBefore: boolean;
    zeroEvidenceAfter: boolean;
    roles: CertificationRoleResult[];
  };
  reportPath: string;
  auditPath: string;
  summary: string;
}

function parseInteger(name: string, raw: string | undefined, minimum: number): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  return value;
}

function resolveOutPath(repoDir: string, path: string): string {
  return isAbsolute(path) ? path : resolve(repoDir, path);
}

function defaultReportPath(alias: string): string {
  return `${DEFAULT_REPORT_DIR}/${alias}.json`;
}

function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp-${randomUUID()}`;
  writeFileSync(tmpPath, content, 'utf-8');
  renameSync(tmpPath, path);
}

function resolveModel(input: string | undefined, catalog: readonly LaunchPriorityModel[]): LaunchPriorityModel {
  const raw = input?.trim();
  if (!raw) {
    throw new Error('--model is required');
  }
  const match = catalog.find((entry) => entry.wavemillAlias === raw || entry.openrouterId === raw);
  if (!match) {
    throw new Error(`Unknown launch-priority model: ${raw}`);
  }
  return match;
}

function evidenceRows(audit: LaunchPriorityAudit, alias: string): ModelRoleEvidence[] {
  return audit.models.filter((entry) => entry.wavemillAlias === alias);
}

function rowsByRole(rows: readonly ModelRoleEvidence[]): Map<LaunchPriorityRole, ModelRoleEvidence> {
  return new Map(rows.map((row) => [row.role, row]));
}

function plannedRunsFor(rows: readonly ModelRoleEvidence[], target: number): number {
  return rows.reduce((max, row) => Math.max(max, Math.max(0, target - row.directEvidenceCount)), 0);
}

function buildChecks(model: LaunchPriorityModel, repoDir: string): CertificationCheck[] {
  const registry = getEffectiveRegistry(repoDir);
  const routerMissingRoles = model.roleEligibility.filter((role) => {
    const stage = ROLE_TO_ROUTER_STAGE[role];
    const effectiveStage = stage === 'planner' ? 'planning' : stage === 'coder' ? 'coding' : 'review';
    return !listEffectiveModelsForStage(effectiveStage, { repoDir }).models.includes(model.wavemillAlias);
  });

  return [
    {
      name: 'fixture',
      status: 'ok',
      detail: `${model.wavemillAlias} is present in the launch-priority fixture as ${model.openrouterId}.`,
    },
    {
      name: 'registry',
      status: getModel(registry, model.wavemillAlias) ? 'ok' : 'blocker',
      detail: getModel(registry, model.wavemillAlias)
        ? `${model.wavemillAlias} is present in the effective model registry.`
        : `${model.wavemillAlias} is missing from the effective model registry.`,
    },
    {
      name: 'global-effective-pools',
      status: routerMissingRoles.length === 0 ? 'ok' : 'blocker',
      detail: routerMissingRoles.length === 0
        ? `${model.wavemillAlias} is present in all eligible global effective-model pools.`
        : `${model.wavemillAlias} is missing from global effective-model pools for: ${routerMissingRoles.join(', ')}.`,
    },
  ];
}

async function runDrySmoke(model: LaunchPriorityModel, prompt: string): Promise<SmokeReport[]> {
  const entries = selectSmokeEntries(createDryRunEntries(), { models: [model.wavemillAlias] });
  return sanitizeSmokeReports(await runOpenRouterSmoke({
    entries,
    transport: createDryRunTransport(entries),
    prompt,
  }));
}

async function runLiveSmoke(model: LaunchPriorityModel, prompt: string): Promise<SmokeReport[] | { skipped: true; message: string }> {
  if (process.env.OPENROUTER_LIVE_SMOKE !== '1' || !process.env.OPENROUTER_API_KEY) {
    return {
      skipped: true,
      message: 'live smoke skipped because OPENROUTER_LIVE_SMOKE=1 and OPENROUTER_API_KEY are required.',
    };
  }

  const liveModels = await fetchOpenRouterModels();
  const normalized = normalizeCatalog(loadLaunchPriorityList(), liveModels);
  const entry = normalized.entries.find((candidate) => candidate.wavemillAlias === model.wavemillAlias);
  if (!entry) {
    const blocker = normalized.blockers.find((candidate) => candidate.wavemillAlias === model.wavemillAlias);
    return [{
      modelId: model.wavemillAlias,
      family: model.family,
      status: 'blocker',
      category: 'provider_unavailable',
      detail: blocker?.detail ?? `${model.openrouterId} was not present in the live OpenRouter catalog.`,
    }];
  }

  return sanitizeSmokeReports(await runOpenRouterSmoke({
    entries: [entry],
    apiKey: process.env.OPENROUTER_API_KEY,
    prompt,
  }));
}

function buildSummary(report: Omit<CertificationReport, 'summary'>): string {
  const live = Array.isArray(report.smoke.live)
    ? report.smoke.live.map((entry) => `${entry.modelId}:${entry.status}`).join(', ')
    : report.smoke.live?.skipped
      ? 'skipped'
      : 'not requested';
  const roleSummary = report.audit.roles
    .map((role) => `${role.role} ${role.before}->${role.after}/${role.target} (${role.status})`)
    .join('; ');
  return [
    `Certified ${report.model.wavemillAlias}: ${roleSummary}.`,
    `Dry smoke: ${report.smoke.dryRun.map((entry) => `${entry.modelId}:${entry.status}`).join(', ')}.`,
    `Live smoke: ${live}.`,
    `Eval runs: ${report.eval.executedRuns}/${report.eval.plannedRuns}.`,
    `Zero-evidence after: ${report.audit.zeroEvidenceAfter ? 'yes' : 'no'}.`,
  ].join(' ');
}

export function getCertificationPersistBlockers(input: {
  checks: readonly CertificationCheck[];
  dryRun: readonly SmokeReport[];
  live?: readonly SmokeReport[] | { skipped: true; message: string };
}): string[] {
  const blockers = input.checks
    .filter((check) => check.status === 'blocker')
    .map((check) => `${check.name}: ${check.detail}`);

  for (const report of input.dryRun) {
    if (report.status === 'blocker') {
      blockers.push(`dry-smoke ${report.modelId}: ${report.detail ?? report.category ?? 'blocked'}`);
    }
  }

  if (Array.isArray(input.live)) {
    for (const report of input.live) {
      if (report.status === 'blocker') {
        blockers.push(`live-smoke ${report.modelId}: ${report.detail ?? report.category ?? 'blocked'}`);
      }
    }
  } else if (input.live?.skipped) {
    blockers.push(`live-smoke: ${input.live.message}`);
  }

  return blockers;
}

export async function runCertifyLaunchPriorityModelCommand(args: CliArgs): Promise<CertificationReport> {
  const repoDir = resolveRepoDir(args['repo-dir']);
  process.chdir(repoDir);

  const target = parseInteger('--target', args.target, 1);
  const catalog = loadLaunchPriorityList();
  const model = resolveModel(args.model, catalog);
  const reportPath = resolveOutPath(repoDir, (args.out as string | undefined) ?? defaultReportPath(model.wavemillAlias));
  const auditPath = resolveOutPath(repoDir, (args['audit-out'] as string | undefined) ?? DEFAULT_AUDIT_OUT);
  const prompt = (args.prompt as string | undefined) || 'ping';
  const persist = args.persist === true;
  const beforeAudit = auditLaunchPriorityCoverage({ catalog, repoDir, coverageTargetPerRole: target });
  const beforeRows = evidenceRows(beforeAudit, model.wavemillAlias);
  const beforeByRole = rowsByRole(beforeRows);
  const plannedRuns = plannedRunsFor(beforeRows, target);
  const checks = buildChecks(model, repoDir);
  const dryRun = await runDrySmoke(model, prompt);
  const live = args.live === true ? await runLiveSmoke(model, prompt) : undefined;
  const persistedIds: string[] = [];
  const persistBlockers = getCertificationPersistBlockers({ checks, dryRun, live });

  if (persist && plannedRuns > 0) {
    if (persistBlockers.length > 0) {
      throw new Error(`Refusing to persist certification evidence while blockers remain: ${persistBlockers.join('; ')}`);
    }
    for (let index = 0; index < plannedRuns; index += 1) {
      const result = await runWavemillRouterEval({
        repoDir,
        policy: 'challenge_prospective',
        modelsAvailable: [model.wavemillAlias],
        persist: true,
      });
      persistedIds.push(result.hemRecord.id);
    }
  }

  const afterAudit = auditLaunchPriorityCoverage({ catalog, repoDir, coverageTargetPerRole: target });
  writeAtomic(auditPath, `${JSON.stringify(afterAudit, null, 2)}\n`);
  const afterByRole = rowsByRole(evidenceRows(afterAudit, model.wavemillAlias));
  const roles = model.roleEligibility.map((role) => {
    const before = beforeByRole.get(role);
    const after = afterByRole.get(role);
    return {
      role,
      before: before?.directEvidenceCount ?? 0,
      after: after?.directEvidenceCount ?? 0,
      target,
      gapBefore: Math.max(0, target - (before?.directEvidenceCount ?? 0)),
      status: after?.status ?? 'zero-evidence',
    } satisfies CertificationRoleResult;
  });

  const reportWithoutSummary = {
    schemaVersion: '1' as const,
    generatedAt: new Date().toISOString(),
    ...(args.issue ? { issue: args.issue as string } : {}),
    model: {
      wavemillAlias: model.wavemillAlias,
      openrouterId: model.openrouterId,
      family: model.family,
      status: model.status,
      priorityTier: model.priorityTier,
      roleEligibility: [...model.roleEligibility],
    },
    target,
    persist,
    checks,
    smoke: {
      dryRun,
      ...(live ? { live } : {}),
    },
    eval: {
      plannedRuns,
      executedRuns: persistedIds.length,
      persistedIds,
    },
    audit: {
      zeroEvidenceBefore: beforeAudit.zeroEvidence.includes(model.wavemillAlias),
      zeroEvidenceAfter: afterAudit.zeroEvidence.includes(model.wavemillAlias),
      roles,
    },
    reportPath,
    auditPath,
  };
  const report: CertificationReport = {
    ...reportWithoutSummary,
    summary: buildSummary(reportWithoutSummary),
  };

  writeAtomic(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  if (args.json === true) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(report.summary);
    console.log(`Report: ${reportPath}`);
    console.log(`Audit: ${auditPath}`);
  }
  return report;
}

export async function runCertifyLaunchPriorityModelCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  await runTool({
    name: 'certify-launch-priority-model',
    description: 'Run targeted smoke and eval evidence certification for one launch-priority model.',
    options,
    examples: [
      'npx tsx tools/certify-launch-priority-model.ts --model glm-5.2 --target 3 --persist --json',
      'OPENROUTER_LIVE_SMOKE=1 npx tsx tools/certify-launch-priority-model.ts --model qwen-3-coder --live --persist --issue HOK-2532',
    ],
    run: ({ args }) => runCertifyLaunchPriorityModelCommand(args),
  }, argv);
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  await runCertifyLaunchPriorityModelCli();
}
