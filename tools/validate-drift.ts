#!/usr/bin/env -S npx tsx

import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runTool, resolveRepoDir } from '../shared/lib/tool-runner.ts';
import { loadWavemillConfig } from '../shared/lib/config.ts';
import {
  detectContractDrift,
  formatDriftReport,
} from '../shared/lib/ci-contract-drift-detector.ts';
import { buildDriftProposal } from '../shared/lib/drift-proposal-builder.ts';

function inferRepo(repoDir: string): string {
  const remote = execSync('git config --get remote.origin.url', {
    cwd: repoDir,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  const match = remote.match(/github\.com[:/]([^/]+\/[^/.]+)(?:\.git)?$/);
  if (!match) {
    throw new Error('Unable to infer GitHub repo. Pass --repo owner/repo.');
  }
  return match[1];
}

function inferBranch(repoDir: string): string {
  const branch = execSync('git rev-parse --abbrev-ref HEAD', {
    cwd: repoDir,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  return branch || 'auto/integration';
}

runTool({
  name: 'validate-drift',
  description: 'Detect drift between enforced GitHub checks and the local pre-PR verification contract',
  options: {
    repo: { type: 'string', description: 'Repository in owner/repo format' },
    branch: { type: 'string', description: 'Branch to inspect for enforced checks' },
    propose: { type: 'boolean', description: 'Write .wavemill/drift-update-proposal.json' },
    'check-name': { type: 'string', description: 'Only show findings for this check name' },
    json: { type: 'boolean', description: 'Output JSON for scripting' },
    verbose: { type: 'boolean', short: 'v', description: 'Show detailed finding context' },
    'no-cache': { type: 'boolean', description: 'Ignore .wavemill/github-checks-cache.json' },
  },
  positional: {
    name: 'repoPath',
    description: 'Repository path (default: current directory)',
  },
  examples: [
    'npx tsx tools/validate-drift.ts',
    'npx tsx tools/validate-drift.ts --repo owner/repo --branch auto/integration',
    'npx tsx tools/validate-drift.ts --propose',
    'npx tsx tools/validate-drift.ts --check-name "test"',
  ],
  additionalHelp: `This command is read-only with respect to .wavemill-config.json.
--propose writes a JSON proposal for maintainers to review; it does not accept or apply mappings.`,
  async run({ args, positional }) {
    const repoDir = resolveRepoDir(positional[0]);
    const repo = args.repo || inferRepo(repoDir);
    const branch = args.branch || inferBranch(repoDir);
    const config = loadWavemillConfig(repoDir);

    const report = await detectContractDrift({
      repoDir,
      repo,
      branch,
      recipe: config.prePrVerification,
      useCache: !args['no-cache'],
    });

    if (args['check-name']) {
      report.findings = report.findings.filter((finding) => finding.checkName === args['check-name']);
      report.checksTotal = report.findings.length;
      report.checksAligned = report.findings.filter((finding) => finding.state === 'ALIGNED').length;
      report.checksUnmapped = report.findings.filter((finding) => finding.state !== 'ALIGNED').length;
      report.checksRemoteOnly = report.findings.filter(
        (finding) => finding.recipeEntry?.type === 'remote-only' && finding.state === 'ALIGNED'
      ).length;
    }

    if (args.propose) {
      const proposal = buildDriftProposal(report);
      const proposalPath = join(repoDir, '.wavemill', 'drift-update-proposal.json');
      mkdirSync(join(repoDir, '.wavemill'), { recursive: true });
      writeFileSync(proposalPath, `${JSON.stringify(proposal, null, 2)}\n`, 'utf-8');
      if (!args.json) {
        console.log(`Wrote proposal: ${proposalPath}`);
      }
    }

    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatDriftReport(report));
      if (args.verbose) {
        console.log('\nFull finding details:');
        console.log(JSON.stringify(report.findings, null, 2));
      }
    }

    process.exitCode = report.status === 'ALIGNED' ? 0 : 1;
  },
});
