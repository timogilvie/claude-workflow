/**
 * Repository-agnostic Arbiter S2 survival analysis.
 *
 * This module deliberately knows nothing about wavemill state.  The only
 * inputs are a checked-out repository, GitHub PR metadata, and an integration
 * branch.  Keeping those seams injectable makes scanner extraction possible
 * and lets callers replay a fixed graph without network access.
 */

import {
  HORIZONS,
  buildArbiterSurvivalLabel,
  type ArbiterSurvivalLabelV1,
  type HorizonDays,
  type LineRange,
  type ReasonCode,
  type UndoneBy,
} from './arbiter-survival-label.ts';
import { parseNameStatusOutput } from './cross-pr-revert-detector.ts';
import { escapeShellArg, execShellCommand } from './shell-utils.ts';

export const ARBITER_SURVIVAL_LABELLER_VERSION = '1.0.0';
export const ARBITER_SURVIVAL_NORMALIZATION_VERSION = '1.0.0';

export interface IntegrationCommit {
  sha: string;
  parent: string | null;
  committedAt: string;
  subject: string;
  authorName?: string;
  authorEmail?: string;
}

export interface PullRequestMetadata {
  number: number;
  url: string;
  mergedAt: string | null;
  headSha: string;
  baseSha: string;
  title?: string;
  body?: string;
  /** Provenance supplied by a host-specific adapter, never inferred as survival evidence. */
  preMergeHumanEdit?: boolean;
}

export interface ReferenceEvidence {
  kind: 'linked' | 'redispatch';
  url: string;
  createdAt?: string;
}

/** Git seam.  Implementations may use a local checkout, a remote mirror, or fixtures. */
export interface SurvivalGitRepository {
  firstParentHistory(integrationBranch: string): IntegrationCommit[];
  diff(baseSha: string, headSha: string): string;
  nameStatus(baseSha: string, headSha: string): string;
  fileAt(sha: string, path: string): string | null;
}

/** GitHub seam.  A scanner can replace this with any host adapter that supplies PR identity. */
export interface SurvivalGithubClient {
  /** Optional bulk path; avoids one API call per historical PR during backfill. */
  mergedPullRequests?(owner: string, repo: string): PullRequestMetadata[] | null;
  pullRequest(owner: string, repo: string, number: number): PullRequestMetadata | null;
  referencesForPullRequest?(input: {
    owner: string;
    repo: string;
    pullRequest: PullRequestMetadata;
    until: string;
  }): ReferenceEvidence[];
}

export interface AnalyzeSurvivalOptions {
  owner: string;
  repo: string;
  integrationBranch: string;
  git: SurvivalGitRepository;
  github: SurvivalGithubClient;
  /** Limits output to this stable join key after PR identity is resolved. */
  prUrl?: string;
  horizons?: readonly HorizonDays[];
  /** A replay anchor.  It must be on the selected first-parent integration history. */
  terminalSha?: string;
  /** Injected for reproducible labels; defaults to the current instant. */
  now?: Date;
  /** Injected for byte-equivalent replay output. */
  computedAt?: string;
}

interface ParsedHunk {
  path: string;
  oldPath: string;
  oldStart: number;
  oldLength: number;
  newStart: number;
  newLength: number;
  oldLines: string[];
  newLines: string[];
}

interface NormalizedRange {
  lineRange: LineRange;
  /** Pre-rename path used only to read the old SHA substrate. */
  oldPath: string;
  oldLines: string[];
  newLines: string[];
}

interface TerminalResolution {
  terminal: IntegrationCommit | null;
  missingReason: Extract<ReasonCode, 'missing_horizon' | 'insufficient_history' | 'inaccessible_history'> | null;
}

/**
 * Analyze every PR discoverable from the integration branch.  A label is
 * returned for every requested horizon, including explicit missing rows.
 */
export function analyzeSurvival(options: AnalyzeSurvivalOptions): ArbiterSurvivalLabelV1[] {
  rejectMain(options.integrationBranch);
  const horizons = options.horizons ?? HORIZONS;
  const now = options.now ?? new Date();
  const computedAt = options.computedAt ?? now.toISOString();
  let history: IntegrationCommit[];

  try {
    history = options.git.firstParentHistory(options.integrationBranch);
  } catch {
    return [];
  }
  if (history.length === 0) return [];

  const requestedPrNumber = options.prUrl ? pullRequestNumberFromUrl(options.prUrl) : null;
  const integrationPrs = history
    .map((commit) => ({ commit, number: extractPrNumber(commit.subject) }))
    .filter((entry): entry is { commit: IntegrationCommit; number: number } => entry.number !== null
      && (requestedPrNumber === null || entry.number === requestedPrNumber));
  // A single-PR replay should never need a paginated historical API request.
  const bulkPullRequests = options.prUrl ? undefined : options.github.mergedPullRequests?.(options.owner, options.repo);
  const bulkByNumber = new Map((bulkPullRequests ?? []).map((pr) => [pr.number, pr]));
  const labels: ArbiterSurvivalLabelV1[] = [];

  for (const { commit, number } of integrationPrs) {
    const pr = bulkByNumber.get(number)
      ?? (bulkPullRequests === null || bulkPullRequests === undefined
        ? options.github.pullRequest(options.owner, options.repo, number)
        : null);
    if (!pr || !pr.mergedAt || (options.prUrl && pr.url !== options.prUrl)) continue;

    for (const horizon of horizons) {
      labels.push(analyzePullRequestHorizon({
        options,
        history,
        mergeCommit: commit,
        pullRequest: pr,
        horizon,
        now,
        computedAt,
      }));
    }
  }

  return labels.sort((left, right) => left.prUrl.localeCompare(right.prUrl)
    || left.horizon_days - right.horizon_days);
}

function analyzePullRequestHorizon(input: {
  options: AnalyzeSurvivalOptions;
  history: IntegrationCommit[];
  mergeCommit: IntegrationCommit;
  pullRequest: PullRequestMetadata;
  horizon: HorizonDays;
  now: Date;
  computedAt: string;
}): ArbiterSurvivalLabelV1 {
  const { options, history, mergeCommit, pullRequest: pr, horizon, now, computedAt } = input;
  // The contract defines the cutoff from the integration merge commit's
  // committer time, not API timing such as the PR's `mergedAt` timestamp.
  const terminal = resolveTerminal(history, mergeCommit.sha, mergeCommit.committedAt, horizon, now, options.terminalSha);
  const envelope = {
    labeller_version: ARBITER_SURVIVAL_LABELLER_VERSION,
    normalization_version: ARBITER_SURVIVAL_NORMALIZATION_VERSION,
    pr_head_sha: pr.headSha,
    merge_sha: mergeCommit.sha,
    // The v1 schema requires a SHA even for a missing horizon.  The merge is
    // the only reproducible known tree in that case; outcome fields remain
    // explicitly null and the reason says why no terminal was observed.
    horizon_terminal_sha: terminal.terminal?.sha ?? mergeCommit.sha,
    integration_branch: options.integrationBranch,
    computed_at: computedAt,
  };

  if (terminal.missingReason) {
    return missingLabel(pr.url, horizon, envelope, terminal.missingReason);
  }

  let ranges: NormalizedRange[];
  try {
    ranges = normalizeRanges(options.git, pr.baseSha, pr.headSha);
  } catch {
    return missingLabel(pr.url, horizon, envelope, 'inaccessible_history');
  }
  if (ranges.length === 0) {
    return missingLabel(pr.url, horizon, envelope, 'insufficient_line_range_substrate');
  }

  const terminalSha = terminal.terminal!.sha;
  const scores = ranges.map((range) => scoreRange(options.git, range, pr.baseSha, pr.headSha, terminalSha));
  if (scores.some((score) => score === null)) {
    return missingLabel(pr.url, horizon, envelope, 'inaccessible_history', ranges.map((range) => range.lineRange));
  }
  const concreteScores = scores as RangeScore[];
  const denominator = concreteScores.reduce((total, score) => total + score.weight, 0);
  if (denominator === 0) {
    return missingLabel(pr.url, horizon, envelope, 'insufficient_line_range_substrate', ranges.map((range) => range.lineRange));
  }

  const changes = postMergeChanges(options.git, history, mergeCommit.sha, terminalSha, ranges);
  const references = options.github.referencesForPullRequest?.({
    owner: options.owner,
    repo: options.repo,
    pullRequest: pr,
    until: terminal.terminal!.committedAt,
  }) ?? [];
  const reverted = concreteScores.every((score) => score.exactlyRestored);
  const survivalRatio = round(concreteScores.reduce((total, score) => total + score.surviving, 0) / denominator);
  const hasLineFollowup = changes.length > 0;
  const hasLinkedReference = references.some((reference) => reference.kind === 'linked');
  const hasRedispatch = references.some((reference) => reference.kind === 'redispatch');
  const followup = !reverted && (hasLineFollowup || hasLinkedReference || hasRedispatch || Boolean(pr.preMergeHumanEdit));
  const reasonCodes: ReasonCode[] = reverted
    ? ['exact_revert']
    : [
      ...(hasLineFollowup ? ['line_range_followup' as const] : []),
      ...(hasLinkedReference ? ['linked_issue_or_pr' as const] : []),
      ...(hasRedispatch ? ['task_redispatch' as const] : []),
      ...(pr.preMergeHumanEdit ? ['pre_merge_human_edit' as const] : []),
      ...(survivalRatio < 0.5 ? ['substantial_rewrite' as const] : []),
    ];
  if (reasonCodes.length === 0) reasonCodes.push('no_evidence');
  const undoneBy = reverted || followup ? dominantUndoer(changes, Boolean(pr.preMergeHumanEdit)) : null;

  return buildArbiterSurvivalLabel({
    prUrl: pr.url,
    horizon_days: horizon,
    label_provenance: 'harvested',
    line_ranges: ranges.map((range) => range.lineRange),
    outcome: {
      survived: !(reverted || followup),
      survival_ratio: survivalRatio,
      reverted,
      undone_by: undoneBy,
      followup,
      reason_codes: reasonCodes,
    },
    envelope,
  });
}

function missingLabel(
  prUrl: string,
  horizon: HorizonDays,
  envelope: Parameters<typeof buildArbiterSurvivalLabel>[0]['envelope'],
  reason: Extract<ReasonCode, 'missing_horizon' | 'insufficient_history' | 'inaccessible_history' | 'insufficient_line_range_substrate' | 'ambiguous_change'>,
  lineRanges: LineRange[] = [],
): ArbiterSurvivalLabelV1 {
  return buildArbiterSurvivalLabel({
    prUrl,
    horizon_days: horizon,
    label_provenance: 'harvested',
    line_ranges: lineRanges,
    outcome: {
      survived: null,
      survival_ratio: null,
      reverted: null,
      undone_by: null,
      followup: null,
      reason_codes: [reason],
    },
    envelope,
  });
}

function resolveTerminal(
  history: IntegrationCommit[],
  mergeSha: string,
  mergedAt: string,
  horizon: HorizonDays,
  now: Date,
  terminalOverride?: string,
): TerminalResolution {
  const mergeIndex = history.findIndex((commit) => commit.sha === mergeSha);
  if (mergeIndex < 0) return { terminal: null, missingReason: 'inaccessible_history' };
  if (terminalOverride) {
    const terminalIndex = history.findIndex((commit) => commit.sha === terminalOverride);
    if (terminalIndex < 0 || terminalIndex > mergeIndex) {
      return { terminal: null, missingReason: 'insufficient_history' };
    }
    return { terminal: history[terminalIndex], missingReason: null };
  }
  const mergeTime = new Date(mergedAt);
  if (Number.isNaN(mergeTime.valueOf())) return { terminal: null, missingReason: 'insufficient_history' };
  // Compute cutoff by adding milliseconds to UTC timestamp (not affected by DST).
  const cutoff = new Date(mergeTime.valueOf() + horizon * 24 * 60 * 60 * 1000);
  if (now.valueOf() < cutoff.valueOf()) return { terminal: null, missingReason: 'missing_horizon' };
  const terminal = history.slice(0, mergeIndex + 1).find((commit) => {
    const timestamp = new Date(commit.committedAt);
    return !Number.isNaN(timestamp.valueOf()) && timestamp.valueOf() <= cutoff.valueOf();
  });
  return terminal
    ? { terminal, missingReason: null }
    : { terminal: null, missingReason: 'insufficient_history' };
}

function normalizeRanges(git: SurvivalGitRepository, baseSha: string, headSha: string): NormalizedRange[] {
  const diff = git.diff(baseSha, headSha);
  const renames = new Map(parseNameStatusOutput(git.nameStatus(baseSha, headSha))
    .filter((entry) => entry.status === 'R' && entry.previousPath)
    .map((entry) => [entry.previousPath!, entry.path]));
  const hunks = parseZeroContextDiff(diff).map((hunk) => ({
    ...hunk,
    path: renames.get(hunk.path) ?? hunk.path,
  }));
  if (isMoveOnly(hunks)) return [];
  return hunks
    .filter((hunk) => !isFormatterOnly(hunk))
    .filter((hunk) => hunk.oldLength > 0 || hunk.newLength > 0)
    .map((hunk) => ({
      lineRange: {
        path: hunk.path,
        old: hunk.oldLength > 0 ? { start: hunk.oldStart, end: hunk.oldStart + hunk.oldLength - 1, sha: baseSha } : null,
        new: hunk.newLength > 0 ? { start: hunk.newStart, end: hunk.newStart + hunk.newLength - 1, sha: headSha } : null,
      },
      oldPath: hunk.oldPath === '/dev/null' ? hunk.path : hunk.oldPath,
      oldLines: hunk.oldLines,
      newLines: hunk.newLines,
    }));
}

/** Parses `git diff --unified=0` without relying on a host-specific diff API. */
export function parseZeroContextDiff(diff: string): ParsedHunk[] {
  const hunks: ParsedHunk[] = [];
  let path = '';
  let oldPath = '';
  let current: ParsedHunk | null = null;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('--- ')) {
      oldPath = stripDiffPath(line.slice(4));
      continue;
    }
    if (line.startsWith('+++ ')) {
      const newPath = stripDiffPath(line.slice(4));
      // For file deletions, newPath is '/dev/null'; use oldPath instead to track the deleted file
      path = newPath === '/dev/null' ? oldPath : newPath;
      continue;
    }
    const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (match) {
      current = {
        path,
        oldPath,
        oldStart: Number(match[1]),
        oldLength: Number(match[2] ?? 1),
        newStart: Number(match[3]),
        newLength: Number(match[4] ?? 1),
        oldLines: [],
        newLines: [],
      };
      hunks.push(current);
      continue;
    }
    if (!current || line.startsWith('\\')) continue;
    if (line.startsWith('-')) current.oldLines.push(line.slice(1));
    if (line.startsWith('+')) current.newLines.push(line.slice(1));
  }
  return hunks.filter((hunk) => hunk.path);
}

function stripDiffPath(path: string): string {
  const candidate = path.split('\t')[0] ?? '';
  return candidate.replace(/^[ab]\//, '');
}

function isFormatterOnly(hunk: ParsedHunk): boolean {
  return hunk.oldLines.length === hunk.newLines.length
    && hunk.oldLines.every((line, index) => normalizeLine(line) === normalizeLine(hunk.newLines[index] ?? ''));
}

function isMoveOnly(hunks: ParsedHunk[]): boolean {
  const removed = hunks.flatMap((hunk) => hunk.oldLines.map(normalizeLine)).filter(Boolean).sort();
  const added = hunks.flatMap((hunk) => hunk.newLines.map(normalizeLine)).filter(Boolean).sort();
  return removed.length > 0 && removed.length === added.length
    && removed.every((line, index) => line === added[index]);
}

function normalizeLine(line: string): string {
  return line.replace(/\s+/g, '');
}

interface RangeScore {
  weight: number;
  surviving: number;
  exactlyRestored: boolean;
}

function scoreRange(
  git: SurvivalGitRepository,
  range: NormalizedRange,
  baseSha: string,
  headSha: string,
  terminalSha: string,
): RangeScore | null {
  const { lineRange, oldPath, newLines } = range;
  const terminal = git.fileAt(terminalSha, lineRange.path);
  if (lineRange.new) {
    const head = git.fileAt(headSha, lineRange.path);
    if (head === null) return null;
    const expected = sliceLines(head, lineRange.new.start, lineRange.new.end);
    const actual = terminal === null ? [] : sliceLines(terminal, lineRange.new.start, lineRange.new.end);
    // Terminal formatter churn is normalized away just like PR-side formatter
    // churn.  Exact revert detection below intentionally remains byte-exact.
    const surviving = expected.reduce((count, line, index) => count + Number(normalizeLine(line) === normalizeLine(actual[index] ?? '')), 0);
    const base = lineRange.old ? git.fileAt(baseSha, oldPath) : null;
    if (lineRange.old && base === null) return null;
    const restored = lineRange.old && base !== null
      ? sameLines(sliceLines(base, lineRange.old.start, lineRange.old.end), terminal === null ? [] : sliceLines(terminal, lineRange.old.start, lineRange.old.end))
      : newLines.length > 0 && !containsSequence(linesOf(terminal), newLines);
    return { weight: expected.length, surviving, exactlyRestored: Boolean(restored) };
  }

  if (!lineRange.old) return null;
  const base = git.fileAt(baseSha, oldPath);
  if (base === null) return null;
  const expectedOld = sliceLines(base, lineRange.old.start, lineRange.old.end);
  const restored = sameLines(expectedOld, terminal === null ? [] : sliceLines(terminal, lineRange.old.start, lineRange.old.end));
  return { weight: expectedOld.length, surviving: restored ? 0 : expectedOld.length, exactlyRestored: restored };
}

function postMergeChanges(
  git: SurvivalGitRepository,
  history: IntegrationCommit[],
  mergeSha: string,
  terminalSha: string,
  ranges: NormalizedRange[],
): IntegrationCommit[] {
  const mergeIndex = history.findIndex((commit) => commit.sha === mergeSha);
  const terminalIndex = history.findIndex((commit) => commit.sha === terminalSha);
  if (mergeIndex < 0 || terminalIndex < 0 || terminalIndex >= mergeIndex) return [];
  const changes: IntegrationCommit[] = [];
  for (const commit of history.slice(terminalIndex, mergeIndex)) {
    if (!commit.parent) continue;
    const hunks = parseZeroContextDiff(git.diff(commit.parent, commit.sha)).filter((hunk) => !isFormatterOnly(hunk));
    if (hunks.some((hunk) => ranges.some((range) => hunkIntersectsRange(hunk, range.lineRange)))) {
      changes.push(commit);
    }
  }
  return changes;
}

function hunkIntersectsRange(hunk: ParsedHunk, range: LineRange): boolean {
  if (hunk.path !== range.path && hunk.oldPath !== range.path) return false;
  const anchor = range.new ?? range.old;
  if (!anchor) return false;
  const start = hunk.newLength > 0 ? hunk.newStart : hunk.oldStart;
  const length = hunk.newLength > 0 ? hunk.newLength : hunk.oldLength;
  const end = start + Math.max(length, 1) - 1;
  return start <= anchor.end && end >= anchor.start;
}

function dominantUndoer(changes: IntegrationCommit[], preMergeHumanEdit: boolean): UndoneBy {
  const kinds = new Set(changes.map((commit) => isAgentAuthor(commit) ? 'agent' : 'human'));
  if (preMergeHumanEdit) kinds.add('human');
  return kinds.size === 1 ? [...kinds][0]! : null;
}

function isAgentAuthor(commit: IntegrationCommit): boolean {
  return /\b(bot|agent|codex|claude|openai)\b/i.test(`${commit.authorName ?? ''} ${commit.authorEmail ?? ''}`);
}

function sliceLines(text: string, start: number, end: number): string[] {
  return linesOf(text).slice(start - 1, end);
}

function linesOf(text: string | null): string[] {
  if (text === null || text === '') return [];
  const lines = text.split(/\r?\n/);
  if (text.endsWith('\n')) lines.pop();
  return lines;
}

function sameLines(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((line, index) => line === right[index]);
}

function containsSequence(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0) return true;
  return haystack.some((_, index) => sameLines(haystack.slice(index, index + needle.length), needle));
}

function round(value: number): number {
  return Number(value.toFixed(6));
}

function extractPrNumber(subject: string): number | null {
  const match = subject.match(/merge pull request #(\d+)\b/i) ?? subject.match(/\(#(\d+)\)\s*$/i);
  return match && Number.isInteger(Number(match[1])) ? Number(match[1]) : null;
}

function pullRequestNumberFromUrl(url: string): number | null {
  const match = url.match(/\/pull\/(\d+)\/?$/);
  return match && Number.isInteger(Number(match[1])) ? Number(match[1]) : null;
}

function rejectMain(branch: string): void {
  if (branch === 'main' || branch === 'refs/heads/main' || branch.endsWith('/main')) {
    throw new Error('integrationBranch "main" is unsupported: walk the non-squashed integration branch instead');
  }
}

type ShellRunner = (command: string, options?: { cwd?: string; encoding?: string; env?: NodeJS.ProcessEnv }) => string;

/** Local-checkout adapter used by the CLI; all dynamic shell values are escaped. */
export function createShellGitRepository(repoDir: string, shellRunner: ShellRunner = defaultShellRunner): SurvivalGitRepository {
  const run = (command: string) => shellRunner(command, { cwd: repoDir, encoding: 'utf-8' }).trimEnd();
  return {
    firstParentHistory(integrationBranch) {
      const output = run(`git log --first-parent --format=%H%x09%P%x09%cI%x09%an%x09%ae%x09%s ${escapeShellArg(integrationBranch)}`);
      return output ? output.split(/\r?\n/).map((line) => {
        const [sha, parents = '', committedAt = '', authorName = '', authorEmail = '', subject = ''] = line.split('\t');
        return { sha, parent: parents.split(/\s+/).filter(Boolean)[0] ?? null, committedAt, authorName, authorEmail, subject };
      }).filter((commit) => commit.sha && commit.committedAt) : [];
    },
    diff(baseSha, headSha) {
      return run(`git diff --find-renames --unified=0 ${escapeShellArg(baseSha)} ${escapeShellArg(headSha)}`);
    },
    nameStatus(baseSha, headSha) {
      return run(`git diff --find-renames --name-status ${escapeShellArg(baseSha)} ${escapeShellArg(headSha)}`);
    },
    fileAt(sha, path) {
      try {
        return run(`git show ${escapeShellArg(`${sha}:${path}`)}`);
      } catch {
        return null;
      }
    },
  };
}

/** GitHub CLI adapter.  It depends only on owner/repo/token, never wavemill files. */
export function createGithubCliClient(
  repoDir: string,
  token?: string,
  shellRunner: ShellRunner = defaultShellRunner,
): SurvivalGithubClient {
  const run = (command: string) => shellRunner(command, {
    cwd: repoDir,
    encoding: 'utf-8',
    env: token ? { ...process.env, GH_TOKEN: token } : process.env,
  });
  return {
    mergedPullRequests(owner, repo) {
      try {
        const raw = run(`gh api ${escapeShellArg(`repos/${owner}/${repo}/pulls?state=closed&per_page=100`)} --paginate --slurp`);
        const pages = JSON.parse(raw) as Array<Array<Record<string, unknown>>>;
        return pages.flat().flatMap(parseGithubPullRequest).filter((pr): pr is PullRequestMetadata => pr?.mergedAt !== null);
      } catch {
        return null;
      }
    },
    pullRequest(owner, repo, number) {
      try {
        const raw = run(`gh pr view ${escapeShellArg(String(number))} --repo ${escapeShellArg(`${owner}/${repo}`)} --json number,url,mergedAt,headRefOid,baseRefOid,title,body`);
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        return parseGithubPullRequest(parsed);
      } catch {
        return null;
      }
    },
    referencesForPullRequest(input) {
      const taskIds = `${input.pullRequest.title ?? ''}\n${input.pullRequest.body ?? ''}`.match(/\b[A-Z][A-Z0-9]+-\d+\b/g) ?? [];
      const query = `repo:${input.owner}/${input.repo} "${input.pullRequest.url}" in:body`;
      const refs = searchGithubIssues(run, query, 'linked');
      for (const taskId of new Set(taskIds)) {
        refs.push(...searchGithubIssues(run, `repo:${input.owner}/${input.repo} ${taskId}`, 'redispatch'));
      }
      return refs.filter((reference) => !reference.url.endsWith(`/pull/${input.pullRequest.number}`));
    },
  };
}

function parseGithubPullRequest(parsed: Record<string, unknown>): PullRequestMetadata | null {
  const url = typeof parsed.url === 'string' ? parsed.url : parsed.html_url;
  const headSha = typeof parsed.headRefOid === 'string'
    ? parsed.headRefOid
    : (parsed.head as { sha?: unknown } | undefined)?.sha;
  const baseSha = typeof parsed.baseRefOid === 'string'
    ? parsed.baseRefOid
    : (parsed.base as { sha?: unknown } | undefined)?.sha;
  return typeof url === 'string' && typeof headSha === 'string' && typeof baseSha === 'string' && Number.isInteger(Number(parsed.number))
    ? {
      number: Number(parsed.number), url, mergedAt: typeof parsed.mergedAt === 'string'
        ? parsed.mergedAt
        : (typeof parsed.merged_at === 'string' ? parsed.merged_at : null),
      headSha, baseSha,
      title: typeof parsed.title === 'string' ? parsed.title : undefined,
      body: typeof parsed.body === 'string' ? parsed.body : undefined,
    }
    : null;
}

function searchGithubIssues(run: (command: string) => string, query: string, kind: ReferenceEvidence['kind']): ReferenceEvidence[] {
  try {
    const raw = run(`gh api -X GET search/issues -f q=${escapeShellArg(query)} -f per_page=100`);
    const parsed = JSON.parse(raw) as { items?: Array<{ html_url?: unknown; created_at?: unknown }> };
    return (parsed.items ?? []).flatMap((item) => typeof item.html_url === 'string'
      ? [{ kind, url: item.html_url, createdAt: typeof item.created_at === 'string' ? item.created_at : undefined }]
      : []);
  } catch {
    return [];
  }
}

function defaultShellRunner(command: string, options?: { cwd?: string; encoding?: string; env?: NodeJS.ProcessEnv }): string {
  return String(execShellCommand(command, options));
}
