#!/usr/bin/env -S npx tsx

import { fileURLToPath } from 'node:url';
import { WM_LABELS, setWavemillReady } from '../shared/lib/pr-state-labels.ts';
import { runTool } from '../shared/lib/tool-runner.ts';

export const setPrReadyLabelDeps = {
  setWavemillReady,
  log: console.log,
};

export function setPrReadyLabel(prNumber: string, repo?: string, markerRoot?: string): void {
  if (!prNumber) {
    throw new Error('PR number is required');
  }

  const pr = setPrReadyLabelDeps.setWavemillReady(prNumber, {
    ...(repo ? { repo } : {}),
    ...(markerRoot ? { markerRoot } : {}),
  });

  // Verify the write actually landed before claiming success.
  //
  // A label mutation can report success while changing nothing -- `gh pr edit
  // --add-label` fails on a Projects-classic GraphQL deprecation, and the mill
  // has logged "Restored ready labels for PR #N" on consecutive polls while the
  // PR stayed wm:blocked. A log line that lies about the outcome turns a
  // one-line fix into a long diagnosis, so fail loudly instead.
  //
  // setWavemillReady re-fetches after mutating, so these labels are post-write
  // state rather than the values we asked for.
  const labels = new Set(pr.labels.map((label) => label.name));
  const missing = labels.has(WM_LABELS.ready) ? [] : [`missing ${WM_LABELS.ready}`];
  const lingering = [WM_LABELS.blocked, WM_LABELS.merging]
    .filter((label) => labels.has(label))
    .map((label) => `still has ${label}`);
  const problems = [...missing, ...lingering];

  if (problems.length > 0) {
    const observed = [...labels].sort().join(', ') || '(none)';
    throw new Error(
      `Ready label reconciliation failed for PR #${pr.number}: ${problems.join('; ')}. Observed labels: [${observed}]`,
    );
  }

  setPrReadyLabelDeps.log(`Canonicalized ready labels for PR #${pr.number}`);
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);

const config = {
  name: 'set-pr-ready-label',
  description: 'Canonicalize the Wavemill ready labels on a GitHub pull request',
  options: {
    repo: {
      type: 'string',
      description: 'Repository in owner/repo format (defaults to current repo)',
    },
    'marker-root': {
      type: 'string',
      description: 'Shared repository root for the PR-state marker sidecar',
    },
  },
  positional: {
    name: 'pr-number',
    description: 'Pull request number',
    required: true,
  },
  examples: [
    'npx tsx tools/set-pr-ready-label.ts 229',
    'npx tsx tools/set-pr-ready-label.ts 229 --repo owner/repo',
  ],
  async run({ args, positional }) {
    setPrReadyLabel(positional[0], args.repo, args['marker-root']);
  },
} as const;

if (isMainModule) {
  runTool(config);
}
