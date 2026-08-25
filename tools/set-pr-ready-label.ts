#!/usr/bin/env -S npx tsx

import { fileURLToPath } from 'node:url';
import { setWavemillReady, WM_LABELS } from '../shared/lib/pr-state-labels.ts';
import { runTool } from '../shared/lib/tool-runner.ts';

export const setPrReadyLabelDeps = {
  setWavemillReady,
  log: console.log,
};

export function setPrReadyLabel(prNumber: string, repo?: string): void {
  if (!prNumber) {
    throw new Error('PR number is required');
  }

  const pr = setPrReadyLabelDeps.setWavemillReady(prNumber, { repo });
  const labels = new Set(pr.labels.map((label) => label.name));
  if (!labels.has(WM_LABELS.ready) || labels.has(WM_LABELS.blocked)) {
    const labelSummary = [...labels].sort().join(', ') || '(none)';
    throw new Error(`Ready label reconciliation failed for PR #${pr.number}: labels=[${labelSummary}]`);
  }
  setPrReadyLabelDeps.log(`Restored ready labels for PR #${pr.number}`);
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);

const config = {
  name: 'set-pr-ready-label',
  description: 'Restore the canonical Wavemill ready labels on a GitHub pull request',
  options: {
    repo: {
      type: 'string',
      description: 'Repository in owner/repo format (defaults to current repo)',
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
    setPrReadyLabel(positional[0], args.repo);
  },
} as const;

if (isMainModule) {
  runTool(config);
}
