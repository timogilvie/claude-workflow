/**
 * Manual-edit attribution backfill audit (HOK-2894).
 *
 * Answers the issue's backfill question: how many historical eval records
 * carry operator commits that were scored as model work because
 * `detectManualEdits` short-circuited to a clean zero on every
 * wavemill-managed branch? Read-only — classifies each record's PR commits
 * against the same recorded agent activity windows / operator-handoff
 * intervals `detectManualEdits` now uses, but never rewrites eval records.
 *
 * A record predating the resolved-handoff artifact (HOK-2894 Phase 1) or
 * whose archived stage results were never written is reported as `unknown`,
 * never guessed at.
 *
 * @module manual-edit-attribution-audit
 */

import { readEvalRecords } from './eval-persistence.ts';
import {
  classifyCommitAttribution,
  deriveAgentActivityWindows,
  fetchPrCommits,
  isAgentCommit,
  readOperatorHandoffIntervals,
  resolveTaskArtifactDirs,
  type PrCommit,
} from './intervention-detector.ts';

export type ManualEditAuditClassification = 'clean' | 'suspect' | 'unknown';

export interface ManualEditAttributionFinding {
  recordId: string;
  issueId?: string;
  prUrl: string;
  prNumber: string;
  agentType?: string;
  classification: ManualEditAuditClassification;
  /** Short SHAs classified as an operator commit (handoff or out-of-window). */
  operatorCommitShas: string[];
  /** Short SHAs that could not be classified at all (no attribution data). */
  unknownCommitShas: string[];
}

export interface ManualEditAttributionAuditSummary {
  audited: number;
  cleanRecords: number;
  suspectRecords: number;
  unknownRecords: number;
  /** Total operator commits found across all audited records. */
  operatorCommits: number;
  findings: ManualEditAttributionFinding[];
}

export interface AuditManualEditAttributionOptions {
  repoDir?: string;
  /** Restrict the audit to a single Linear issue. */
  issueId?: string;
  /** Cap the number of eligible records audited (applied after filtering). */
  limit?: number;
}

export interface ManualEditAttributionAuditDeps {
  fetchPrCommits: (prNumber: string, repoDir?: string) => PrCommit[];
}

const DEFAULT_DEPS: ManualEditAttributionAuditDeps = {
  fetchPrCommits,
};

function parsePrNumber(prUrl: string | undefined): string | undefined {
  return prUrl?.match(/\/pull\/(\d+)/)?.[1];
}

/**
 * Audit historical eval records for operator commits that were scored as
 * model work by the pre-HOK-2894 manual-edit detector. Read-only.
 */
export function auditManualEditAttribution(
  options: AuditManualEditAttributionOptions = {},
  deps: ManualEditAttributionAuditDeps = DEFAULT_DEPS,
): ManualEditAttributionAuditSummary {
  const repoDir = options.repoDir || process.cwd();

  let candidates = readEvalRecords({ repoDir }).filter(
    (record) => Boolean(record.issueId) && Boolean(parsePrNumber(record.prUrl)),
  );
  if (options.issueId) {
    candidates = candidates.filter((record) => record.issueId === options.issueId);
  }
  if (options.limit && options.limit > 0) {
    candidates = candidates.slice(0, options.limit);
  }

  const findings: ManualEditAttributionFinding[] = [];
  let operatorCommits = 0;

  for (const record of candidates) {
    const prNumber = parsePrNumber(record.prUrl)!;
    const dirs = resolveTaskArtifactDirs({ repoDir, issueId: record.issueId });
    const windows = deriveAgentActivityWindows(dirs);
    const intervals = readOperatorHandoffIntervals(dirs);
    const hasAttributionData = windows.length > 0 || intervals.length > 0;

    let commits: PrCommit[];
    try {
      commits = deps.fetchPrCommits(prNumber, repoDir);
    } catch {
      commits = [];
    }

    const operatorShas: string[] = [];
    const unknownShas: string[] = [];
    for (const commit of commits) {
      const subject = commit.message.split('\n')[0];
      const body = commit.message.includes('\n')
        ? commit.message.slice(commit.message.indexOf('\n') + 1)
        : '';
      if (isAgentCommit(subject, commit.author, body)) continue;

      const commitMs = Date.parse(commit.date);
      if (!Number.isFinite(commitMs)) continue;

      const attribution = classifyCommitAttribution(commitMs, windows, intervals, hasAttributionData);
      if (attribution === 'agent') continue;
      if (attribution === 'unknown') {
        unknownShas.push(commit.sha.slice(0, 7));
      } else {
        operatorShas.push(commit.sha.slice(0, 7));
      }
    }

    const classification: ManualEditAuditClassification = operatorShas.length > 0
      ? 'suspect'
      : (!hasAttributionData ? 'unknown' : 'clean');

    operatorCommits += operatorShas.length;
    findings.push({
      recordId: record.id,
      issueId: record.issueId,
      prUrl: record.prUrl!,
      prNumber,
      agentType: record.agentType,
      classification,
      operatorCommitShas: operatorShas,
      unknownCommitShas: unknownShas,
    });
  }

  return {
    audited: findings.length,
    cleanRecords: findings.filter((f) => f.classification === 'clean').length,
    suspectRecords: findings.filter((f) => f.classification === 'suspect').length,
    unknownRecords: findings.filter((f) => f.classification === 'unknown').length,
    operatorCommits,
    findings,
  };
}
