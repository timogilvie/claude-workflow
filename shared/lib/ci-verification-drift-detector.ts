import type { GitHubDiscoveryResult, WorkflowJob } from './github-ci-discovery.ts';
import type { PrePrVerificationConfigSchema } from './config.ts';

export type DriftFindingType =
  | 'aligned'
  | 'recipe-missing'
  | 'unmapped-check'
  | 'workflow-uncovered'
  | 'workflow-changed'
  | 'metadata-unavailable'
  | 'manual-review';

export type DriftSeverity = 'info' | 'warning' | 'error';

export interface DriftFinding {
  type: DriftFindingType;
  checkName: string;
  localCommand?: string;
  githubJobName?: string;
  githubWorkflowPath?: string;
  severity: DriftSeverity;
  reason: string;
  suggestedFix?: string;
  requiresAcknowledgement: boolean;
  acknowledged?: boolean;
}

export interface VerificationDriftReport {
  repository: string;
  timestamp: string;
  source: 'github-enforced' | 'explicit';
  githubChecks: string[];
  localRecipe: string[];
  findings: DriftFinding[];
  hasActionableDrift: boolean;
  summary: string;
}

export interface VerificationDriftInput {
  repository: string;
  discovery?: GitHubDiscoveryResult | null;
  config?: PrePrVerificationConfigSchema | null;
  localWorkflowJobs?: Array<{ jobName: string; workflowPath: string }>;
  metadataError?: Error | string | null;
  timestamp?: string;
}

export interface ProposedMapping {
  checkName: string;
  localCommand?: string;
  confidence: number;
  reason: string;
  requiresManualReview: boolean;
}

interface CommandCandidate {
  command: string;
  normalized: string;
  tokens: Set<string>;
}

interface CheckMapping {
  checkName: string;
  candidates: Array<{ command: string; score: number; reason: string }>;
}

const MIN_AUTO_MAPPING_SCORE = 0.72;
const MANUAL_REVIEW_SCORE_DELTA = 0.12;

export function detectVerificationDrift(input: VerificationDriftInput): VerificationDriftReport {
  const config = input.config ?? {};
  const commands = config.recipe?.commands ?? [];
  const timestamp = input.timestamp ?? new Date().toISOString();
  const source = config.source ?? 'explicit';

  if (input.metadataError || !input.discovery) {
    const message =
      typeof input.metadataError === 'string'
        ? input.metadataError
        : input.metadataError?.message ?? 'GitHub metadata was not available.';
    const findings: DriftFinding[] = [
      {
        type: 'metadata-unavailable',
        checkName: '(github metadata)',
        severity: 'warning',
        reason: message,
        suggestedFix:
          'Authenticate gh with repository branch protection/ruleset permissions, then rerun CI verification drift diagnostics.',
        requiresAcknowledgement: false,
      },
    ];
    return buildReport(input.repository, timestamp, source, [], commands, findings);
  }

  const checks = uniqueSorted(input.discovery.checks);
  const mappings = buildMappingIndex(checks, commands, config);
  const workflowByCheck = buildWorkflowIndex(buildWorkflowProvenance(input), checks);
  const findings: DriftFinding[] = [];

  if (checks.length === 0) {
    findings.push({
      type: 'recipe-missing',
      checkName: '(no enforced checks)',
      severity: 'warning',
      reason: 'No enforced GitHub checks were discovered for this repository.',
      suggestedFix: 'Verify branch protection/rulesets or switch prePrVerification.source to explicit.',
      requiresAcknowledgement: false,
    });
  }

  for (const checkName of checks) {
    const exception = findRemoteOnlyException(config, checkName);
    const workflow = workflowByCheck.get(checkName);
    const workflowChange = validateWorkflowProvenance(config, checkName, workflow);
    if (workflowChange) {
      findings.push(workflowChange);
      continue;
    }

    if (exception) {
      findings.push({
        type: 'aligned',
        checkName,
        githubJobName: workflow?.name,
        githubWorkflowPath: workflow?.path,
        severity: 'info',
        reason: `Remote-only check acknowledged: ${exception.reason}`,
        suggestedFix: 'Keep this check enforced in GitHub CI; update the acknowledgement if ownership or rationale changes.',
        requiresAcknowledgement: false,
        acknowledged: true,
      });
      continue;
    }

    const explicitCommand = getAcknowledgedCommand(config, checkName);
    if (explicitCommand) {
      findings.push({
        type: commands.includes(explicitCommand) ? 'aligned' : 'recipe-missing',
        checkName,
        localCommand: explicitCommand,
        githubJobName: workflow?.name,
        githubWorkflowPath: workflow?.path,
        severity: commands.includes(explicitCommand) ? 'info' : 'error',
        reason: commands.includes(explicitCommand)
          ? 'Enforced check is explicitly mapped to a local recipe command.'
          : 'Configured check mapping points to a command that is not present in the local recipe.',
        suggestedFix: commands.includes(explicitCommand)
          ? undefined
          : `Add "${explicitCommand}" to prePrVerification.recipe.commands or update mappingAcknowledgements.checks.`,
        requiresAcknowledgement: !commands.includes(explicitCommand),
      });
      continue;
    }

    const mapping = mappings.find((entry) => entry.checkName === checkName);
    const candidates = mapping?.candidates ?? [];
    if (commands.length === 0) {
      findings.push({
        type: 'recipe-missing',
        checkName,
        githubJobName: workflow?.name,
        githubWorkflowPath: workflow?.path,
        severity: 'error',
        reason: 'GitHub enforces this check but no local pre-PR recipe commands are configured.',
        suggestedFix:
          `Add a safe local command for "${checkName}" or declare a remote-only exception with rationale.`,
        requiresAcknowledgement: true,
      });
      continue;
    }

    if (candidates.length === 0) {
      findings.push({
        type: 'unmapped-check',
        checkName,
        githubJobName: workflow?.name,
        githubWorkflowPath: workflow?.path,
        severity: 'error',
        reason: 'No local recipe command could be safely mapped to this enforced GitHub check.',
        suggestedFix:
          `Map "${checkName}" in prePrVerification.mappingAcknowledgements.checks, add a recipe command, or declare a remote-only exception with rationale.`,
        requiresAcknowledgement: true,
      });
      continue;
    }

    const [best, second] = candidates;
    if (
      candidates.length > 1 &&
      (second && best.score - second.score <= MANUAL_REVIEW_SCORE_DELTA)
    ) {
      findings.push({
        type: 'manual-review',
        checkName,
        localCommand: best.command,
        githubJobName: workflow?.name,
        githubWorkflowPath: workflow?.path,
        severity: 'warning',
        reason: `Multiple local commands could map to this check; best candidate is "${best.command}" (${best.reason}).`,
        suggestedFix: `Record the intended mapping in prePrVerification.mappingAcknowledgements.checks["${checkName}"].`,
        requiresAcknowledgement: true,
      });
      continue;
    }

    findings.push({
      type: 'aligned',
      checkName,
      localCommand: best.command,
      githubJobName: workflow?.name,
      githubWorkflowPath: workflow?.path,
      severity: 'info',
      reason: `Mapped to local command by ${best.reason}.`,
      requiresAcknowledgement: false,
    });
  }

  const coveredCheckNames = new Set(checks.map(normalizeForCaseInsensitiveMatch));
  const nonEnforcedJobs = new Set((config.nonEnforcedJobs ?? []).map(normalizeForCaseInsensitiveMatch));
  const remoteOnlyChecks = new Set((config.remoteOnlyExceptions ?? []).map((entry) => (
    normalizeForCaseInsensitiveMatch(entry.checkName)
  )));

  for (const workflowJob of input.localWorkflowJobs ?? []) {
    const normalizedJobName = normalizeForCaseInsensitiveMatch(workflowJob.jobName);
    if (
      coveredCheckNames.has(normalizedJobName) ||
      nonEnforcedJobs.has(normalizedJobName) ||
      remoteOnlyChecks.has(normalizedJobName)
    ) {
      continue;
    }

    findings.push({
      type: 'workflow-uncovered',
      checkName: workflowJob.jobName,
      githubJobName: workflowJob.jobName,
      githubWorkflowPath: workflowJob.workflowPath,
      severity: 'error',
      reason: 'Local workflow scan found a CI job that is not represented in prePrVerification.requiredChecks, remoteOnlyExceptions, or nonEnforcedJobs.',
      suggestedFix:
        `Add "${workflowJob.jobName}" to prePrVerification.requiredChecks with a local mapping, or acknowledge it in remoteOnlyExceptions/nonEnforcedJobs with rationale.`,
      requiresAcknowledgement: true,
    });
  }

  return buildReport(input.repository, timestamp, source, checks, commands, findings);
}

export function buildMappingIndex(
  checks: string[],
  commands: string[],
  config: PrePrVerificationConfigSchema = {},
): CheckMapping[] {
  const commandCandidates = commands.map((command) => ({
    command,
    normalized: normalizeForMatching(command),
    tokens: tokenize(command),
  }));

  return checks.map((checkName) => {
    const acknowledged = getAcknowledgedCommand(config, checkName);
    const candidates = commandCandidates
      .map((candidate) => scoreCandidate(checkName, candidate))
      .filter((candidate) => candidate.score >= MIN_AUTO_MAPPING_SCORE);

    if (acknowledged && commands.includes(acknowledged)) {
      candidates.unshift({
        command: acknowledged,
        score: 1,
        reason: 'explicit acknowledgement',
      });
    }

    return {
      checkName,
      candidates: dedupeCandidates(candidates).sort((a, b) => b.score - a.score),
    };
  });
}

export function validateWorkflowProvenance(
  config: PrePrVerificationConfigSchema,
  checkName: string,
  currentWorkflow?: WorkflowJob,
): DriftFinding | null {
  const expected = getAcknowledgedWorkflow(config, checkName);
  if (!expected) return null;

  if (!currentWorkflow) {
    return {
      type: 'workflow-changed',
      checkName,
      severity: 'warning',
      reason: 'This check has acknowledged workflow provenance, but the matching workflow job was not found in GitHub metadata.',
      suggestedFix: 'Review the workflow rename/removal and update mappingAcknowledgements.checks after confirming the local recipe is still safe.',
      requiresAcknowledgement: true,
    };
  }

  if (
    (expected.jobName && expected.jobName !== currentWorkflow.name) ||
    (expected.workflowPath && expected.workflowPath !== currentWorkflow.path)
  ) {
    return {
      type: 'workflow-changed',
      checkName,
      githubJobName: currentWorkflow.name,
      githubWorkflowPath: currentWorkflow.path,
      severity: 'warning',
      reason:
        `Workflow provenance changed from ${expected.workflowPath ?? '(any workflow)'}/${expected.jobName ?? '(any job)'} ` +
        `to ${currentWorkflow.path}/${currentWorkflow.name}.`,
      suggestedFix:
        'Review the GitHub workflow change manually. Do not execute arbitrary workflow YAML locally; update the local recipe or acknowledgement only after review.',
      requiresAcknowledgement: true,
    };
  }

  return null;
}

export function proposeVerificationMappings(report: VerificationDriftReport): ProposedMapping[] {
  return report.findings
    .filter((finding) => finding.type === 'aligned' || finding.type === 'manual-review')
    .filter((finding) => finding.localCommand)
    .map((finding) => ({
      checkName: finding.checkName,
      localCommand: finding.localCommand,
      confidence: finding.type === 'aligned' ? 1 : 0.6,
      reason: finding.reason,
      requiresManualReview: finding.type === 'manual-review',
    }));
}

export function formatVerificationDriftReport(
  report: VerificationDriftReport,
  options: { proposeMapping?: boolean } = {},
): string {
  const lines: string[] = [];
  lines.push('Verification Contract Drift Report');
  lines.push('==================================');
  lines.push('');
  lines.push(`Repository: ${report.repository}`);
  lines.push(`GitHub Source: ${report.source} (${report.githubChecks.length} checks)`);
  lines.push(`Local Recipe: ${report.localRecipe.length} commands`);
  lines.push('');
  lines.push(report.summary);

  if (report.findings.length > 0) {
    lines.push('');
    lines.push('Findings:');
    for (const finding of report.findings) {
      const marker = finding.severity === 'error' ? 'x' : finding.severity === 'warning' ? '!' : '+';
      const local = finding.localCommand ? ` -> ${finding.localCommand}` : '';
      const ack = finding.acknowledged ? ' (remote-only acknowledged)' : '';
      lines.push(`  ${marker} ${finding.checkName}${local}: ${finding.type}${ack}`);
      lines.push(`    ${finding.reason}`);
      if (finding.suggestedFix) {
        lines.push(`    Fix: ${finding.suggestedFix}`);
      }
    }
  }

  if (options.proposeMapping) {
    const proposals = proposeVerificationMappings(report);
    lines.push('');
    lines.push('Proposed mapping updates:');
    if (proposals.length === 0) {
      lines.push('  (none)');
    } else {
      for (const proposal of proposals) {
        lines.push(
          `  "${proposal.checkName}": "${proposal.localCommand}"` +
            (proposal.requiresManualReview ? ' # manual review required' : ''),
        );
      }
    }
  }

  if (report.hasActionableDrift) {
    lines.push('');
    lines.push('Action required: update the local recipe, record an explicit mapping, or acknowledge a remote-only exception with rationale.');
  }

  return lines.join('\n');
}

function buildReport(
  repository: string,
  timestamp: string,
  source: 'github-enforced' | 'explicit',
  githubChecks: string[],
  localRecipe: string[],
  findings: DriftFinding[],
): VerificationDriftReport {
  const actionable = findings.some((finding) => (
    finding.requiresAcknowledgement ||
    finding.severity === 'error' ||
    finding.type === 'workflow-changed' ||
    finding.type === 'metadata-unavailable'
  ));

  const errorCount = findings.filter((finding) => finding.severity === 'error').length;
  const warningCount = findings.filter((finding) => finding.severity === 'warning').length;
  const alignedCount = findings.filter((finding) => finding.type === 'aligned').length;
  const summary = actionable
    ? `Drift detected: ${errorCount} error(s), ${warningCount} warning(s), ${alignedCount} aligned check(s).`
    : `Aligned: ${alignedCount} enforced check(s) mapped or acknowledged.`;

  return {
    repository,
    timestamp,
    source,
    githubChecks,
    localRecipe,
    findings,
    hasActionableDrift: actionable,
    summary,
  };
}

function scoreCandidate(
  checkName: string,
  candidate: CommandCandidate,
): { command: string; score: number; reason: string } {
  const checkNormalized = normalizeForMatching(checkName);
  const checkTokens = tokenize(checkName);

  if (candidate.normalized === checkNormalized) {
    return { command: candidate.command, score: 1, reason: 'exact normalized name match' };
  }

  if (candidate.normalized.includes(checkNormalized) || checkNormalized.includes(candidate.normalized)) {
    return { command: candidate.command, score: 0.9, reason: 'substring name match' };
  }

  const overlap = intersectionSize(checkTokens, candidate.tokens);
  const union = new Set([...checkTokens, ...candidate.tokens]).size || 1;
  const jaccard = overlap / union;

  const aliases = aliasBoost(checkTokens, candidate.tokens);
  const score = Math.min(0.88, jaccard + aliases);
  return { command: candidate.command, score, reason: 'token similarity' };
}

function aliasBoost(checkTokens: Set<string>, commandTokens: Set<string>): number {
  const pairs: Array<[string, string]> = [
    ['type', 'tsc'],
    ['typescript', 'tsc'],
    ['lint', 'eslint'],
    ['test', 'jest'],
    ['test', 'vitest'],
    ['unit', 'test'],
    ['shell', 'sh'],
    ['format', 'prettier'],
  ];
  let boost = 0;
  for (const [left, right] of pairs) {
    if (
      (checkTokens.has(left) && commandTokens.has(right)) ||
      (checkTokens.has(right) && commandTokens.has(left))
    ) {
      boost += 0.25;
    }
  }
  return Math.min(boost, 0.5);
}

function normalizeForMatching(value: string): string {
  return Array.from(tokenize(value)).join(' ');
}

function tokenize(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .replace(/npm run|npx|tsx|node|yarn|pnpm|tools\//g, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .split(/\s+/)
      .map((token) => token.trim())
      .map((token) => (token === 'tests' ? 'test' : token))
      .filter((token) => token.length > 1 && !['run', 'check', 'ci', 'workflow', 'job'].includes(token)),
  );
}

function intersectionSize<T>(left: Set<T>, right: Set<T>): number {
  let count = 0;
  for (const value of left) {
    if (right.has(value)) count++;
  }
  return count;
}

function dedupeCandidates(
  candidates: Array<{ command: string; score: number; reason: string }>,
): Array<{ command: string; score: number; reason: string }> {
  const byCommand = new Map<string, { command: string; score: number; reason: string }>();
  for (const candidate of candidates) {
    const existing = byCommand.get(candidate.command);
    if (!existing || candidate.score > existing.score) {
      byCommand.set(candidate.command, candidate);
    }
  }
  return Array.from(byCommand.values());
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

function normalizeForCaseInsensitiveMatch(value: string): string {
  return value.trim().toLowerCase();
}

function findRemoteOnlyException(config: PrePrVerificationConfigSchema, checkName: string) {
  return (config.remoteOnlyExceptions ?? []).find(
    (entry) => entry.checkName.toLowerCase() === checkName.toLowerCase(),
  );
}

function getAcknowledgedCommand(
  config: PrePrVerificationConfigSchema,
  checkName: string,
): string | undefined {
  const entry = config.mappingAcknowledgements?.checks?.[checkName];
  if (typeof entry === 'string') return entry;
  return entry?.localCommand;
}

function getAcknowledgedWorkflow(
  config: PrePrVerificationConfigSchema,
  checkName: string,
): { workflowPath?: string; jobName?: string } | undefined {
  const entry = config.mappingAcknowledgements?.checks?.[checkName];
  if (!entry || typeof entry === 'string') return undefined;
  if (!entry.workflowPath && !entry.jobName) return undefined;
  return {
    workflowPath: entry.workflowPath,
    jobName: entry.jobName,
  };
}

function buildWorkflowProvenance(input: VerificationDriftInput): WorkflowJob[] {
  const remoteWorkflows = input.discovery?.workflows ?? [];
  const localWorkflows = (input.localWorkflowJobs ?? []).map((job) => ({
    name: job.jobName,
    path: job.workflowPath,
    triggers: ['local-scan'],
  }));
  return [...remoteWorkflows, ...localWorkflows];
}

function buildWorkflowIndex(workflows: WorkflowJob[], checks: string[]): Map<string, WorkflowJob> {
  const result = new Map<string, WorkflowJob>();
  for (const check of checks) {
    const literal = workflows.find((workflow) => (
      normalizeForCaseInsensitiveMatch(workflow.name) === normalizeForCaseInsensitiveMatch(check)
    ));
    if (literal) {
      result.set(check, literal);
      continue;
    }

    const normalizedCheck = normalizeForMatching(check);
    const exact = workflows.find((workflow) => normalizeForMatching(workflow.name) === normalizedCheck);
    if (exact) {
      result.set(check, exact);
      continue;
    }
    const partial = workflows.find((workflow) => {
      const normalizedJob = normalizeForMatching(workflow.name);
      return normalizedCheck.includes(normalizedJob) || normalizedJob.includes(normalizedCheck);
    });
    if (partial) {
      result.set(check, partial);
    }
  }
  return result;
}
