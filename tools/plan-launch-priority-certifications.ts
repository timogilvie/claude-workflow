#!/usr/bin/env -S npx tsx

import { fileURLToPath } from 'node:url';
import { getOpenRouterProviderConfig } from '../shared/lib/config.ts';
import { listEffectiveModelsForStage } from '../shared/lib/effective-models.ts';
import { auditLaunchPriorityCoverage, type LaunchPriorityAudit, type LaunchPriorityRole, type ModelRoleEvidence } from '../shared/lib/launch-priority-audit.ts';
import { loadLaunchPriorityList, type LaunchPriorityModel, type ModelFamily } from '../shared/lib/openrouter-catalog.ts';
import { runTool, resolveRepoDir, type ParsedArgs } from '../shared/lib/tool-runner.ts';
import { evaluateEvidenceEligibility } from '../shared/lib/model-evidence-policy.ts';
import type { EvalRecord } from '../shared/lib/eval-schema.ts';

const FAMILY_ISSUES: Partial<Record<ModelFamily, string>> = {
  deepseek: 'HOK-2527',
  gemini: 'HOK-2528',
  glm: 'HOK-2529',
  gpt: 'HOK-2530',
  kimi: 'HOK-2531',
  qwen: 'HOK-2532',
  mistral: 'HOK-2533',
  llama: 'HOK-2534',
};
const ROLE_TO_ROUTER_STAGE: Record<LaunchPriorityRole, 'planner' | 'coder' | 'reviewer'> = {
  planning: 'planner',
  coding: 'coder',
  review: 'reviewer',
};

const options = {
  target: { type: 'string', description: 'Coverage target per role.', default: '3' },
  json: { type: 'boolean', description: 'Emit the plan as JSON.' },
  'include-below-target': { type: 'boolean', description: 'Include below-target models, not just zero-evidence aliases.' },
  'repo-dir': { type: 'string', description: 'Repository directory to inspect.' },
} as const;

type CliArgs = ParsedArgs<typeof options>;

export interface CertificationPlanRole {
  role: LaunchPriorityRole;
  directEvidenceCount: number;
  gap: number;
  status: ModelRoleEvidence['status'];
  blockers: ModelRoleEvidence['blockers'];
}

export interface CertificationPlanAlias {
  wavemillAlias: string;
  openrouterId: string;
  family: ModelFamily;
  priorityTier: number;
  launchPriorityStatus: LaunchPriorityModel['status'];
  issue: string | null;
  roles: CertificationPlanRole[];
  preflightBlockers: string[];
  runsNeeded: number;
  commands: {
    drySmoke: string;
    certify: string;
  };
}

export interface CertificationPlanGroup {
  issue: string | null;
  family: ModelFamily;
  aliases: CertificationPlanAlias[];
}

export interface CertificationPlan {
  schemaVersion: '1';
  generatedAt: string;
  target: number;
  includeBelowTarget: boolean;
  zeroEvidence: string[];
  belowTarget: string[];
  groups: CertificationPlanGroup[];
  totals: {
    aliases: number;
    plannedEvalRuns: number;
    blockedRoleCells: number;
    blockedAliases: number;
  };
}

function parseInteger(name: string, raw: string | undefined, minimum: number): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  return value;
}

function modelByAlias(catalog: readonly LaunchPriorityModel[]): Map<string, LaunchPriorityModel> {
  return new Map(catalog.map((entry) => [entry.wavemillAlias, entry]));
}

function shouldIncludeAlias(alias: string, audit: LaunchPriorityAudit, includeBelowTarget: boolean): boolean {
  return audit.zeroEvidence.includes(alias) || (includeBelowTarget && audit.belowTarget.includes(alias));
}

function rolePlan(row: ModelRoleEvidence, target: number): CertificationPlanRole {
  return {
    role: row.role,
    directEvidenceCount: row.directEvidenceCount,
    gap: Math.max(0, target - row.directEvidenceCount),
    status: row.status,
    blockers: row.blockers,
  };
}

function launchPriorityPersistenceProbe(modelId: string): EvalRecord {
  return {
    id: `launch-priority-persistence:${modelId}`,
    schemaVersion: '1.43.0',
    originalPrompt: `Launch-priority persistence probe for ${modelId}`,
    modelId,
    modelVersion: modelId,
    attempted_model: modelId,
    score: 1,
    scoreBand: 'Strong',
    timeSeconds: 0,
    timestamp: new Date(0).toISOString(),
    interventionRequired: false,
    interventionCount: 0,
    interventionDetails: [],
    rationale: 'persistence eligibility probe',
    taskDescriptor: {
      schema_version: '1.0',
      signals: {
        heuristic: {
          task_type: 'feature',
          languages: [],
          framework_tags: [],
          files_touched: 0,
          repo_size_loc: 0,
          description_tokens: 0,
          is_greenfield: false,
          has_migration: false,
          has_ui: false,
          has_tests: false,
          cross_service: false,
        },
        learned: {
          complexity: 1,
          domain: 'devtools',
          risk_flags: [],
        },
      },
      constraints: {
        models_available: [modelId],
        objective: 'balanced',
      },
      stages: {
        planner: { model: modelId },
        coder: { model: modelId },
        reviewer: { model: modelId },
      },
    },
  } as EvalRecord;
}

function persistenceBlockers(alias: string): string[] {
  const decision = evaluateEvidenceEligibility(
    launchPriorityPersistenceProbe(alias),
    'launch_priority_persistence',
    { strict: true },
  );
  return decision.eligible ? [] : decision.reasons;
}

function aliasCommands(alias: string, issue: string | null, target: number, persistAllowed: boolean): CertificationPlanAlias['commands'] {
  const issueArg = issue ? ` --issue ${issue}` : '';
  const persistArg = persistAllowed ? ' --persist' : '';
  return {
    drySmoke: `npx tsx tools/openrouter-smoke.ts --models ${alias} --json`,
    certify: `OPENROUTER_LIVE_SMOKE=1 npx tsx tools/certify-launch-priority-model.ts --model ${alias} --target ${target} --live${persistArg}${issueArg} --json`,
  };
}

export function buildCertificationPlan(input: {
  audit: LaunchPriorityAudit;
    catalog: readonly LaunchPriorityModel[];
    target: number;
    includeBelowTarget?: boolean;
    preflightBlockers?: Map<string, string[]>;
    now?: Date;
}): CertificationPlan {
  const includeBelowTarget = input.includeBelowTarget === true;
  const catalogByAlias = modelByAlias(input.catalog);
  const rowsByAlias = new Map<string, ModelRoleEvidence[]>();
  for (const row of input.audit.models) {
    if (!shouldIncludeAlias(row.wavemillAlias, input.audit, includeBelowTarget)) {
      continue;
    }
    if (row.status === 'at-target') {
      continue;
    }
    const existing = rowsByAlias.get(row.wavemillAlias);
    if (existing) {
      existing.push(row);
    } else {
      rowsByAlias.set(row.wavemillAlias, [row]);
    }
  }

  const aliases: CertificationPlanAlias[] = [...rowsByAlias.entries()]
    .map(([alias, rows]) => {
      const model = catalogByAlias.get(alias);
      if (!model) {
        throw new Error(`Audit row references unknown launch-priority alias: ${alias}`);
      }
      const roles = rows.map((row) => rolePlan(row, input.target));
      const issue = FAMILY_ISSUES[model.family] ?? null;
      const policyBlockers = persistenceBlockers(model.wavemillAlias);
      const preflightBlockers = [
        ...(input.preflightBlockers?.get(model.wavemillAlias) ?? []),
        ...policyBlockers,
      ];
      return {
        wavemillAlias: model.wavemillAlias,
        openrouterId: model.openrouterId,
        family: model.family,
        priorityTier: model.priorityTier,
        launchPriorityStatus: model.status,
        issue,
        roles,
        preflightBlockers,
        runsNeeded: roles.reduce((max, role) => Math.max(max, role.gap), 0),
        commands: aliasCommands(model.wavemillAlias, issue, input.target, policyBlockers.length === 0),
      };
    })
    .sort((left, right) =>
      (left.issue ?? '').localeCompare(right.issue ?? '')
      || left.priorityTier - right.priorityTier
      || left.wavemillAlias.localeCompare(right.wavemillAlias));

  const grouped = new Map<string, CertificationPlanGroup>();
  for (const alias of aliases) {
    const key = `${alias.issue ?? 'unmapped'}:${alias.family}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.aliases.push(alias);
    } else {
      grouped.set(key, {
        issue: alias.issue,
        family: alias.family,
        aliases: [alias],
      });
    }
  }

  return {
    schemaVersion: '1',
    generatedAt: (input.now ?? new Date()).toISOString(),
    target: input.target,
    includeBelowTarget,
    zeroEvidence: [...input.audit.zeroEvidence],
    belowTarget: [...input.audit.belowTarget],
    groups: [...grouped.values()],
    totals: {
      aliases: aliases.length,
      plannedEvalRuns: aliases.reduce((sum, alias) => sum + alias.runsNeeded, 0),
      blockedRoleCells: aliases.reduce(
        (sum, alias) => sum + alias.roles.filter((role) => role.blockers.length > 0).length,
        0,
      ),
      blockedAliases: aliases.filter((alias) => alias.preflightBlockers.length > 0).length,
    },
  };
}

function buildPreflightBlockers(catalog: readonly LaunchPriorityModel[], repoDir: string): Map<string, string[]> {
  const provider = getOpenRouterProviderConfig(repoDir);
  const blockers = new Map<string, string[]>();

  for (const model of catalog) {
    const messages: string[] = [];
    if (provider.enabled !== true) {
      messages.push('providers.openrouter.enabled is not true');
    }
    const missingRoles = model.roleEligibility.filter((role) => {
      const stage = ROLE_TO_ROUTER_STAGE[role];
      const effectiveStage = stage === 'planner' ? 'planning' : stage === 'coder' ? 'coding' : 'review';
      return !listEffectiveModelsForStage(effectiveStage, { repoDir }).models.includes(model.wavemillAlias);
    });
    if (missingRoles.length > 0) {
      messages.push(`missing from global effective-model pools for ${missingRoles.join(', ')}`);
    }
    if (messages.length > 0) {
      blockers.set(model.wavemillAlias, messages);
    }
  }

  return blockers;
}

function formatText(plan: CertificationPlan): string {
  const lines = [
    `Launch-priority certification plan: ${plan.totals.aliases} aliases, ${plan.totals.plannedEvalRuns} eval runs, ${plan.totals.blockedAliases} preflight-blocked aliases.`,
  ];
  for (const group of plan.groups) {
    lines.push('');
    lines.push(`${group.issue ?? 'unmapped'} ${group.family}`);
    for (const alias of group.aliases) {
      const roleSummary = alias.roles
        .map((role) => `${role.role}:${role.directEvidenceCount}+${role.gap}${role.blockers.length > 0 ? ':blocked' : ''}`)
        .join(', ');
      lines.push(`  ${alias.wavemillAlias} (${alias.openrouterId}) runs=${alias.runsNeeded} roles=[${roleSummary}]`);
      if (alias.preflightBlockers.length > 0) {
        lines.push(`    preflight blockers: ${alias.preflightBlockers.join('; ')}`);
      }
      lines.push(`    ${alias.commands.certify}`);
    }
  }
  return lines.join('\n');
}

export async function runPlanLaunchPriorityCertificationsCommand(args: CliArgs): Promise<CertificationPlan> {
  const repoDir = resolveRepoDir(args['repo-dir']);
  const target = parseInteger('--target', args.target, 1);
  const catalog = loadLaunchPriorityList();
  const audit = auditLaunchPriorityCoverage({
    catalog,
    repoDir,
    coverageTargetPerRole: target,
  });
  const plan = buildCertificationPlan({
    audit,
    catalog,
    target,
    includeBelowTarget: args['include-below-target'] === true,
    preflightBlockers: buildPreflightBlockers(catalog, repoDir),
  });

  if (args.json === true) {
    console.log(JSON.stringify(plan, null, 2));
  } else {
    console.log(formatText(plan));
  }
  return plan;
}

export async function runPlanLaunchPriorityCertificationsCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  await runTool({
    name: 'plan-launch-priority-certifications',
    description: 'Plan targeted certification commands for launch-priority zero-evidence aliases.',
    options,
    examples: [
      'npx tsx tools/plan-launch-priority-certifications.ts',
      'npx tsx tools/plan-launch-priority-certifications.ts --target 3 --json',
    ],
    run: ({ args }) => runPlanLaunchPriorityCertificationsCommand(args),
  }, argv);
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  await runPlanLaunchPriorityCertificationsCli();
}
