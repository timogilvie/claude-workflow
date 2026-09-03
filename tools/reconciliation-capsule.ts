/**
 * reconciliation-capsule - CLI for the durable post-PR reconciliation capsule (HOK-2936).
 *
 * Thin wrapper over shared/lib/reconciliation-context.ts so shell callers
 * (wavemill-monitor.sh, agent-adapters.sh) delegate all capsule validation
 * and prompt projection to the shared TypeScript contract.
 *
 * Subcommands (first positional):
 *   build            create/refresh the capsule foundation + review identity
 *   update-incident  replace the volatile incident section
 *   validate         read + strictly validate; prints a typed JSON result
 *   project          print the projected recovery prompt (stable prefix first)
 *   record-attempt   append a bounded attempt record
 *   finalize-attempt update the most recent attempt's outcome/result commit
 *
 * All structured results are single-line JSON on stdout. Typed capsule
 * failures exit 1 with {ok:false, reason, detail} so callers surface
 * needs-user instead of launching an agent.
 */

import { runTool } from '../shared/lib/tool-runner.ts';
import {
  buildFailureFingerprint,
  buildFoundation,
  computeAttemptCost,
  createCapsule,
  normalizeUsage,
  projectCapsulePrompt,
  readCapsule,
  withAttempt,
  withIncident,
  writeCapsule,
  type AttemptOutcome,
  type IncidentClassification,
  type ReconciliationAttempt,
  type ReconciliationCapsule,
  type ReconciliationIncident,
} from '../shared/lib/reconciliation-context.ts';

const CLASSIFICATIONS: IncidentClassification[] = [
  'stale_base_clean',
  'ci_transient',
  'ci_deterministic_safe',
  'merge_conflict',
  'ambiguous',
  'exhausted',
];

const OUTCOMES: AttemptOutcome[] = ['launched', 'commit_pushed', 'no_commit', 'push_failed', 'launch_failed', 'unknown'];

function fail(reason: string, detail: string): never {
  console.log(JSON.stringify({ ok: false, reason, detail }));
  process.exit(1);
}

function parseJsonArg<T>(raw: string | undefined, label: string, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    fail('invalid_argument', `${label} is not valid JSON: ${String(error)}`);
  }
}

function requireArg(value: string | undefined, label: string): string {
  if (!value || !value.trim()) fail('invalid_argument', `--${label} is required`);
  return value.trim();
}

function readValidCapsule(featureDir: string): ReconciliationCapsule {
  const read = readCapsule(featureDir);
  if (!read.ok) fail(read.reason, read.detail);
  return read.capsule;
}

runTool({
  name: 'reconciliation-capsule',
  description: 'Manage the durable post-PR reconciliation capsule (HOK-2936)',
  positional: { name: 'subcommand', description: 'build|update-incident|validate|project|record-attempt|finalize-attempt', required: true },
  options: {
    'feature-dir': { type: 'string', description: 'Feature directory holding the capsule' },
    'task-id': { type: 'string', description: 'build: task/issue id' },
    title: { type: 'string', description: 'build: task title' },
    slug: { type: 'string', description: 'build: task slug' },
    branch: { type: 'string', description: 'build: PR branch' },
    'base-branch': { type: 'string', description: 'build: base branch' },
    pr: { type: 'string', description: 'build: PR number' },
    'review-head': { type: 'string', description: 'build: head SHA the current review verdict covers' },
    'review-verdict': { type: 'string', description: 'build: recorded review verdict' },
    'task-packet': { type: 'string', description: 'build: task packet path (digest recorded)' },
    scope: { type: 'string', description: 'build: bounded original-scope summary' },
    classification: { type: 'string', description: 'update-incident: incident classification' },
    head: { type: 'string', description: 'update-incident/record-attempt: current head SHA' },
    base: { type: 'string', description: 'update-incident: current base SHA' },
    detail: { type: 'string', description: 'update-incident: bounded incident detail' },
    'failing-checks-json': { type: 'string', description: 'update-incident: JSON array of failing-check evidence' },
    'conflict-files-json': { type: 'string', description: 'update-incident: JSON array of conflicted files' },
    'evidence-gaps-json': { type: 'string', description: 'update-incident: JSON array of typed evidence gaps' },
    fingerprint: { type: 'string', description: 'update-incident: explicit stable failure fingerprint' },
    agent: { type: 'string', description: 'record-attempt: agent command' },
    model: { type: 'string', description: 'record-attempt: model id' },
    provider: { type: 'string', description: 'record-attempt: provider id' },
    'launch-mode': { type: 'string', description: 'record-attempt: fresh|resume', default: 'fresh' },
    outcome: { type: 'string', description: 'record/finalize-attempt: attempt outcome', default: 'launched' },
    'result-commit': { type: 'string', description: 'finalize-attempt: pushed commit SHA' },
    'usage-json': { type: 'string', description: 'record/finalize-attempt: JSON usage metrics' },
    'cost-usd': { type: 'string', description: 'record-attempt: computed cost in USD when known' },
  },
  examples: [
    'npx tsx tools/reconciliation-capsule.ts validate --feature-dir features/my-task',
    'npx tsx tools/reconciliation-capsule.ts project --feature-dir features/my-task',
  ],
  async run({ args, positional }) {
    const subcommand = positional[0];
    const featureDir = requireArg(args['feature-dir'], 'feature-dir');

    switch (subcommand) {
      case 'build': {
        const existing = readCapsule(featureDir);
        const reviewHead = args['review-head']?.trim() || null;
        const reviewResultPath = `${featureDir}/.review-result.json`;
        const reviewVerdict = args['review-verdict']?.trim() || null;
        let capsule: ReconciliationCapsule;
        if (existing.ok) {
          // Foundation is immutable once written; refresh only review identity.
          capsule = {
            ...existing.capsule,
            review: {
              reviewHeadSha: reviewHead ?? existing.capsule.review.reviewHeadSha,
              reviewResultPath,
              verdict: reviewVerdict ?? existing.capsule.review.verdict,
              recordedAt: new Date().toISOString(),
            },
            updatedAt: new Date().toISOString(),
          };
        } else {
          const foundation = buildFoundation({
            taskId: requireArg(args['task-id'], 'task-id'),
            taskTitle: args.title ?? '',
            slug: requireArg(args.slug, 'slug'),
            branch: requireArg(args.branch, 'branch'),
            baseBranch: requireArg(args['base-branch'], 'base-branch'),
            prNumber: Number(requireArg(args.pr, 'pr')),
            taskPacketPath: args['task-packet'] || null,
            executionContractPath: `${featureDir}/.phase-config.json`,
            executionContractStage: 'coding',
            scopeSummary: args.scope || null,
          });
          capsule = createCapsule({ foundation, reviewHeadSha: reviewHead, reviewResultPath, reviewVerdict });
        }
        const write = writeCapsule(featureDir, capsule);
        if (!write.ok) fail(write.reason, write.detail);
        console.log(JSON.stringify({ ok: true, path: write.path, foundationDigest: capsule.foundationDigest }));
        return;
      }

      case 'update-incident': {
        const capsule = readValidCapsule(featureDir);
        const classification = requireArg(args.classification, 'classification') as IncidentClassification;
        if (!CLASSIFICATIONS.includes(classification)) {
          fail('invalid_argument', `unknown classification ${classification}`);
        }
        const failingChecks = parseJsonArg<ReconciliationIncident['failingChecks']>(
          args['failing-checks-json'],
          '--failing-checks-json',
          undefined,
        );
        const conflictFiles = parseJsonArg<string[] | undefined>(args['conflict-files-json'], '--conflict-files-json', undefined);
        const evidenceGaps = parseJsonArg<string[] | undefined>(args['evidence-gaps-json'], '--evidence-gaps-json', undefined);
        const fingerprint =
          args.fingerprint?.trim() ||
          buildFailureFingerprint([
            classification,
            ...(failingChecks ?? []).map((check) => `${check.name}:${check.failingJob ?? ''}`),
            ...(conflictFiles ?? []),
          ]);
        const incident: ReconciliationIncident = {
          classification,
          headSha: requireArg(args.head, 'head'),
          baseSha: args.base?.trim() || null,
          failureFingerprint: fingerprint,
          detail: args.detail ?? '',
          observedAt: new Date().toISOString(),
          ...(failingChecks ? { failingChecks } : {}),
          ...(conflictFiles ? { conflictFiles } : {}),
          ...(evidenceGaps ? { evidenceGaps } : {}),
        };
        const next = withIncident(capsule, incident);
        const write = writeCapsule(featureDir, next);
        if (!write.ok) fail(write.reason, write.detail);
        console.log(
          JSON.stringify({
            ok: true,
            classification,
            failureFingerprint: fingerprint,
            incidentFingerprint: next.incidentFingerprint,
          }),
        );
        return;
      }

      case 'validate': {
        const read = readCapsule(featureDir);
        if (!read.ok) fail(read.reason, read.detail);
        console.log(
          JSON.stringify({
            ok: true,
            foundationDigest: read.capsule.foundationDigest,
            incidentFingerprint: read.capsule.incidentFingerprint ?? null,
            classification: read.capsule.incident?.classification ?? null,
            failureFingerprint: read.capsule.incident?.failureFingerprint ?? null,
            reviewHeadSha: read.capsule.review.reviewHeadSha,
            attemptCount: read.capsule.attempts.length,
          }),
        );
        return;
      }

      case 'project': {
        const capsule = readValidCapsule(featureDir);
        process.stdout.write(projectCapsulePrompt(capsule).text);
        return;
      }

      case 'record-attempt': {
        const capsule = readValidCapsule(featureDir);
        const outcome = (args.outcome ?? 'launched') as AttemptOutcome;
        if (!OUTCOMES.includes(outcome)) fail('invalid_argument', `unknown outcome ${outcome}`);
        const launchMode = args['launch-mode'] === 'resume' ? 'resume' : 'fresh';
        const usage = normalizeUsage(
          parseJsonArg<Partial<Record<string, unknown>> | null>(args['usage-json'], '--usage-json', null) as never,
        );
        const costUsd = args['cost-usd'] !== undefined ? Number(args['cost-usd']) : NaN;
        const attempt: ReconciliationAttempt = {
          attemptNumber: capsule.attempts.length + 1,
          classification: capsule.incident?.classification ?? 'ambiguous',
          failureFingerprint: capsule.incident?.failureFingerprint ?? 'unknown',
          headSha: args.head?.trim() || capsule.incident?.headSha || 'unknown',
          agent: args.agent?.trim() || null,
          model: args.model?.trim() || null,
          provider: args.provider?.trim() || null,
          launchMode,
          startedAt: new Date().toISOString(),
          finishedAt: null,
          usage,
          cost: Number.isFinite(costUsd) ? { available: true, usd: costUsd } : computeAttemptCost(usage),
          outcome,
          resultCommitSha: args['result-commit']?.trim() || null,
        };
        const write = writeCapsule(featureDir, withAttempt(capsule, attempt));
        if (!write.ok) fail(write.reason, write.detail);
        console.log(JSON.stringify({ ok: true, attemptNumber: attempt.attemptNumber, launchMode, outcome }));
        return;
      }

      case 'finalize-attempt': {
        const capsule = readValidCapsule(featureDir);
        const last = capsule.attempts[capsule.attempts.length - 1];
        if (!last) fail('invalid_argument', 'no attempt recorded to finalize');
        const outcome = (args.outcome ?? 'unknown') as AttemptOutcome;
        if (!OUTCOMES.includes(outcome)) fail('invalid_argument', `unknown outcome ${outcome}`);
        const usage = normalizeUsage(
          parseJsonArg<Partial<Record<string, unknown>> | null>(args['usage-json'], '--usage-json', null) as never,
        );
        const finalized: ReconciliationAttempt = {
          ...last,
          finishedAt: new Date().toISOString(),
          outcome,
          resultCommitSha: args['result-commit']?.trim() || last.resultCommitSha,
          usage: usage ?? last.usage,
          cost: usage ? computeAttemptCost(usage) : last.cost,
        };
        const next: ReconciliationCapsule = {
          ...capsule,
          attempts: [...capsule.attempts.slice(0, -1), finalized],
          updatedAt: new Date().toISOString(),
        };
        const write = writeCapsule(featureDir, next);
        if (!write.ok) fail(write.reason, write.detail);
        console.log(JSON.stringify({ ok: true, attemptNumber: finalized.attemptNumber, outcome }));
        return;
      }

      default:
        fail('invalid_argument', `unknown subcommand ${String(subcommand)}`);
    }
  },
});
