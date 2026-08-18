#!/usr/bin/env -S npx tsx
/**
 * Record and inspect operator intervention artifacts.
 */

import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { runTool } from '../shared/lib/tool-runner.ts';
import {
  buildOperatorInterventionRecord,
  readOperatorInterventions,
  resolveOperatorInterventionTarget,
  writeOperatorIntervention,
  type OperatorInterventionStage,
  type OperatorInterventionSeverity,
} from '../shared/lib/operator-intervention.ts';
import { detectPriorFailedAttempts } from '../shared/lib/intervention-detector.ts';

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value;
}

function parseStage(value: unknown): OperatorInterventionStage | undefined {
  if (value === undefined) return undefined;
  if (value === 'routing' || value === 'planning' || value === 'coding' || value === 'review' || value === 'ready') return value;
  throw new Error('--stage must be one of routing, planning, coding, review, ready');
}

function parseSeverity(value: unknown): OperatorInterventionSeverity {
  if (value === 'minor' || value === 'major') return value;
  throw new Error('--severity must be minor or major');
}

function parseAttempt(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const attempt = Number(value);
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error('--attempt must be a positive integer');
  return attempt;
}

function selectedTaskFields(featureDir: string): { issue?: string; challengePairId?: string } {
  const selected = readJson(join(featureDir, 'selected-task.json'));
  const challenge = readJson(join(featureDir, 'challenge-intent.json'));
  return {
    issue: typeof selected?.taskId === 'string' ? selected.taskId : undefined,
    challengePairId: typeof challenge?.pairId === 'string' ? challenge.pairId : undefined,
  };
}

function archiveFailedResult(featureDir: string, stage: OperatorInterventionStage | undefined, attempt: number | undefined): string {
  if (!stage || stage === 'routing' || stage === 'ready') {
    throw new Error('--archive-failed-result requires --stage planning, coding, or review');
  }
  const resultPath = join(featureDir, `.${stage}-result.json`);
  const result = readJson(resultPath);
  if (result?.status !== 'failed' && result?.status !== 'aborted') {
    throw new Error(`Current ${stage} result is not failed or aborted`);
  }
  const inferredAttempt = attempt ?? (Array.isArray(result.history) ? result.history.length + 1 : 1);
  const sidecar = join(featureDir, `.${stage}-result.attempt-${inferredAttempt}-failed.json`);
  copyFileSync(resultPath, sidecar);
  return sidecar;
}

runTool({
  name: 'operator-intervention',
  description: 'Record or show operator recovery interventions',
  positional: {
    name: 'action target',
    description: 'Action (record/show) followed by a feature dir, slug, or task key',
    multiple: true,
    required: true,
  },
  options: {
    'repo-dir': { type: 'string', description: 'Repository directory' },
    stage: { type: 'string', description: 'Stage: routing, planning, coding, review, ready' },
    attempt: { type: 'string', description: 'Attempt number' },
    severity: { type: 'string', description: 'Severity: minor or major' },
    trigger: { type: 'string', description: 'Free-form trigger tag' },
    summary: { type: 'string', description: 'Short intervention summary' },
    action: { type: 'string', multiple: true, description: 'Action taken; may be repeated' },
    'scoring-note': { type: 'string', description: 'Guidance for eval scoring' },
    'code-written': { type: 'boolean', description: 'Operator wrote code' },
    operator: { type: 'string', description: 'Operator identity/role' },
    'related-commit': { type: 'string', description: 'Related commit SHA' },
    'occurred-at': { type: 'string', description: 'ISO timestamp' },
    replace: { type: 'boolean', description: 'Replace instead of append' },
    json: { type: 'boolean', description: 'Print JSON output' },
    'dry-run': { type: 'boolean', description: 'Print without writing' },
    'archive-failed-result': { type: 'boolean', description: 'Copy current failed stage result to an attempt sidecar' },
  },
  examples: [
    'wavemill intervention record features/my-task --severity major --trigger invalid_artifact --summary "Relaunched after failed coding attempt"',
    'wavemill intervention show HOK-537_c --json',
  ],
  async run({ args, positional }) {
    const [action, target] = positional;
    if (!action || !target) throw new Error('Usage: wavemill intervention <record|show> <target> [flags]');
    if (action !== 'record' && action !== 'show') throw new Error(`Unknown intervention action '${action}'`);

    const repoDir = resolve((args['repo-dir'] as string | undefined) ?? process.cwd());
    const resolved = resolveOperatorInterventionTarget(target, repoDir);

    if (action === 'show') {
      const records = readOperatorInterventions(resolved.featureDir);
      const priorFailed = detectPriorFailedAttempts({ featureDirs: [resolved.featureDir] });
      if (args.json) {
        console.log(JSON.stringify({ featureDir: resolved.featureDir, records, priorFailedAttempts: priorFailed.count }, null, 2));
      } else {
        console.log(`${basename(resolved.featureDir)}: ${records.length} operator intervention(s), ${priorFailed.count} prior failed attempt(s)`);
        for (const record of records) {
          console.log(`- ${record.occurredAt} ${record.severity} ${record.stage ?? ''} ${record.trigger ?? ''} ${record.summary ?? ''}`.trim());
        }
      }
      return;
    }

    const stage = parseStage(args.stage);
    const attempt = parseAttempt(args.attempt);
    const defaults = selectedTaskFields(resolved.featureDir);
    const record = buildOperatorInterventionRecord({
      severity: parseSeverity(args.severity),
      trigger: requireString(args.trigger, '--trigger'),
      summary: requireString(args.summary, '--summary'),
      occurredAt: args['occurred-at'] as string | undefined,
      issue: defaults.issue,
      stage,
      attempt,
      actionsTaken: (args.action as string[] | undefined) ?? [],
      codeWrittenByOperator: Boolean(args['code-written']),
      scoringNote: args['scoring-note'] as string | undefined,
      operator: args.operator as string | undefined,
      relatedCommit: args['related-commit'] as string | undefined,
      challengePairId: defaults.challengePairId,
    });

    const archived = args['archive-failed-result'] ? archiveFailedResult(resolved.featureDir, stage, attempt) : undefined;
    if (!args['dry-run']) writeOperatorIntervention(resolved.featureDir, record, { append: !args.replace });

    if (args.json || args['dry-run']) {
      console.log(JSON.stringify({ featureDir: resolved.featureDir, record, archived }, null, 2));
    } else {
      console.log(`Recorded operator intervention at ${join(resolved.featureDir, '.operator-intervention.json')}`);
      if (archived) console.log(`Archived failed result at ${archived}`);
    }
  },
});

