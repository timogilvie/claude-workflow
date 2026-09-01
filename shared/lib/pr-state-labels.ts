import { type PullRequest, addLabelsToPullRequest, getPullRequest, removeLabelFromPullRequest, resolveOwnerRepo } from './github.ts';
import { escapeShellArg, execShellCommand } from './shell-utils.ts';
import { writeMarker, clearMarker, readMarker, validateMarker, type MarkerHandle, type MarkerValidation, type MarkerPayload } from './transient-marker.ts';
import { dirname } from 'path';

export interface PrStateLabelOptions {
  repo?: string;
}

export interface PrLabelWriteArgs {
  headSha: string;
  reason?: string;
}

export interface LabelInitOptions {
  repo?: string;
}

export interface LabelInitResult {
  repo: string;
  created: string[];
  skipped: string[];
}

export const WM_LABELS = {
  wavemill: 'wavemill',
  ready: 'wm:ready',
  blocked: 'wm:blocked',
  merging: 'wm:merging',
  merged: 'wm:merged',
  superseded: 'wm:superseded',
  risky: 'wm:risky',
  migration: 'wm:migration',
  approved: 'wm:approved',
  wrongBase: 'wm:wrong-base',
  metadataInvalid: 'wm:metadata-invalid',
  migrationRequired: 'wm:migration-required',
  riskAcknowledged: 'wm:risk-acknowledged',
  challengeUnresolved: 'wm:challenge-unresolved',
} as const;

interface GithubLabelDefinition {
  name: string;
  color: string;
  description: string;
}

const WM_LABEL_DEFINITIONS: GithubLabelDefinition[] = [
  { name: WM_LABELS.wavemill, color: '#0075ca', description: 'Managed by Wavemill autonomous integration' },
  { name: WM_LABELS.ready, color: '#0e8a16', description: 'Ready for Wavemill merge' },
  { name: WM_LABELS.blocked, color: '#d93f0b', description: 'Blocked from merging' },
  { name: WM_LABELS.merging, color: '#e4e669', description: 'Wavemill merge in progress' },
  { name: WM_LABELS.merged, color: '#6f42c1', description: 'Merged by Wavemill' },
  { name: WM_LABELS.superseded, color: '#aaaaaa', description: 'Superseded by another branch' },
  { name: WM_LABELS.risky, color: '#ee0701', description: 'High-risk change requiring extra review' },
  { name: WM_LABELS.migration, color: '#f9d0c4', description: 'Contains a database migration' },
  { name: WM_LABELS.approved, color: '#0075ca', description: 'Reviewer approved for merge' },
  { name: WM_LABELS.wrongBase, color: '#b60205', description: 'Targets the wrong base branch for autonomous merge' },
  { name: WM_LABELS.metadataInvalid, color: '#d93f0b', description: 'PR metadata is missing or invalid' },
  { name: WM_LABELS.migrationRequired, color: '#fbca04', description: 'Database migration requires Wavemill migration label' },
  { name: WM_LABELS.riskAcknowledged, color: '#5319e7', description: 'High-risk PR has been explicitly acknowledged' },
  { name: WM_LABELS.challengeUnresolved, color: '#d73a4a', description: 'Challenge-mode PR is missing a resolved comparison pair' },
];

const ACTIVE_STATE_LABELS = [WM_LABELS.ready, WM_LABELS.blocked, WM_LABELS.merging];
const ALL_WM_LABELS = WM_LABEL_DEFINITIONS.map((definition) => definition.name);

export const prStateLabelDeps = {
  getPullRequest,
  addLabelsToPullRequest,
  removeLabelFromPullRequest,
  execShellCommand,
  resolveOwnerRepo,
};

export function initGithubLabels(options: LabelInitOptions = {}): LabelInitResult {
  const repo = options.repo || prStateLabelDeps.resolveOwnerRepo();

  if (!repo) {
    throw new Error('Unable to determine GitHub repository. Pass --repo owner/name or run from a GitHub checkout.');
  }

  const existingLabels = new Set(listRepositoryLabels(repo));
  const created: string[] = [];
  const skipped: string[] = [];

  for (const definition of WM_LABEL_DEFINITIONS) {
    if (existingLabels.has(definition.name)) {
      skipped.push(definition.name);
      continue;
    }

    createRepositoryLabel(repo, definition);
    created.push(definition.name);
  }

  return { repo, created, skipped };
}

export function setWavemillReady(prNumber: number | string, args: PrLabelWriteArgs, options: PrStateLabelOptions = {}): PullRequest {
  return transitionPullRequestLabels(prNumber, [WM_LABELS.ready], [WM_LABELS.blocked, WM_LABELS.merging], args, options);
}

export function setWavemillBlocked(prNumber: number | string, args: PrLabelWriteArgs, options: PrStateLabelOptions = {}): PullRequest {
  return transitionPullRequestLabels(prNumber, [WM_LABELS.blocked], [WM_LABELS.ready, WM_LABELS.merging], args, options);
}

export function setWavemillMerging(prNumber: number | string, args: PrLabelWriteArgs, options: PrStateLabelOptions = {}): PullRequest {
  return transitionPullRequestLabels(prNumber, [WM_LABELS.merging], [WM_LABELS.ready, WM_LABELS.blocked], args, options);
}

export function setWavemillMerged(prNumber: number | string, args: PrLabelWriteArgs, options: PrStateLabelOptions = {}): PullRequest {
  return transitionPullRequestLabels(prNumber, [WM_LABELS.merged], ACTIVE_STATE_LABELS, args, options);
}

export function setWavemillSuperseded(prNumber: number | string, args: PrLabelWriteArgs, options: PrStateLabelOptions = {}): PullRequest {
  return transitionPullRequestLabels(prNumber, [WM_LABELS.superseded], ACTIVE_STATE_LABELS, args, options);
}

export function addWavemillBase(prNumber: number | string, options: PrStateLabelOptions = {}): PullRequest {
  return transitionPullRequestLabels(prNumber, [WM_LABELS.wavemill], [], { headSha: '' }, options);
}

export function addWavemillRisky(prNumber: number | string, options: PrStateLabelOptions = {}): PullRequest {
  return transitionPullRequestLabels(prNumber, [WM_LABELS.risky], [], { headSha: '' }, options);
}

export function addWavemillMigration(prNumber: number | string, options: PrStateLabelOptions = {}): PullRequest {
  return transitionPullRequestLabels(prNumber, [WM_LABELS.migration], [], { headSha: '' }, options);
}

export function addWavemillApproved(prNumber: number | string, options: PrStateLabelOptions = {}): PullRequest {
  return transitionPullRequestLabels(prNumber, [WM_LABELS.approved], [], { headSha: '' }, options);
}

export function clearWavemillState(prNumber: number | string, options: PrStateLabelOptions = {}): PullRequest {
  const pr = prStateLabelDeps.getPullRequest(prNumber, options);
  const markerHandle = getPrMarkerHandle(pr.number);
  clearMarker(markerHandle);
  return transitionPullRequestLabels(prNumber, [], ALL_WM_LABELS, { headSha: '' }, options);
}

function transitionPullRequestLabels(
  prNumber: number | string,
  labelsToEnsure: string[],
  labelsToClear: string[],
  args: PrLabelWriteArgs,
  options: PrStateLabelOptions,
): PullRequest {
  const pr = prStateLabelDeps.getPullRequest(prNumber, options);
  const existingLabels = new Set(pr.labels.map((label) => label.name));
  const labelsToAdd = labelsToEnsure.filter((label, index, all) => all.indexOf(label) === index && !existingLabels.has(label));
  const labelsToRemove = labelsToClear.filter((label, index, all) => all.indexOf(label) === index && existingLabels.has(label));

  let currentPr = pr;

  for (const label of labelsToRemove) {
    currentPr = prStateLabelDeps.removeLabelFromPullRequest(pr.number, label, options);
  }

  if (labelsToAdd.length > 0) {
    currentPr = prStateLabelDeps.addLabelsToPullRequest(pr.number, labelsToAdd, options);
  }

  // Write marker with current active state labels
  if (args.headSha) {
    const markerHandle = getPrMarkerHandle(pr.number);
    const activeLabels = currentPr.labels.map((label) => label.name);
    writeMarker(markerHandle, {
      headSha: args.headSha,
      reason: args.reason,
      detail: { activeLabels },
    });
  }

  return currentPr;
}

export async function readPrStateMarker(
  prNumber: number | string,
  args: {
    currentHead: string;
    deriveCondition: (payload: MarkerPayload) => Promise<boolean> | boolean;
  },
): Promise<MarkerValidation<boolean>> {
  const markerHandle = getPrMarkerHandle(prNumber);
  return validateMarker(markerHandle, {
    currentHead: args.currentHead,
    deriveCondition: args.deriveCondition,
  });
}

function getPrMarkerHandle(prNumber: number | string): MarkerHandle {
  return {
    path: `.wavemill/pr-state/${prNumber}.json`,
    kind: 'pr-label',
  };
}

function listRepositoryLabels(repo: string): string[] {
  const output = prStateLabelDeps.execShellCommand(
    `gh api --paginate ${escapeShellArg(`repos/${repo}/labels`)} --jq '.[].name'`,
    { encoding: 'utf-8' },
  ).trim();

  if (!output) {
    return [];
  }

  return output
    .split('\n')
    .map((label) => label.trim())
    .filter((label) => label.length > 0);
}

function createRepositoryLabel(repo: string, definition: GithubLabelDefinition): void {
  const color = definition.color.replace(/^#/, '');
  prStateLabelDeps.execShellCommand(
    [
      'gh',
      'api',
      '--method',
      'POST',
      escapeShellArg(`repos/${repo}/labels`),
      '-f',
      `name=${escapeShellArg(definition.name)}`,
      '-f',
      `color=${escapeShellArg(color)}`,
      '-f',
      `description=${escapeShellArg(definition.description)}`,
    ].join(' '),
    { encoding: 'utf-8' },
  );
}
