#!/usr/bin/env -S npx tsx

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runTool, resolveRepoDir } from '../shared/lib/tool-runner.ts';
import { loadWavemillConfig } from '../shared/lib/config.ts';
import {
  discoverGitHubRequiredChecks,
  getWorkflowJobs,
  type GitHubDiscoveryResult,
} from '../shared/lib/github-ci-discovery.ts';
import {
  reportDriftViolations,
  validateVerificationDrift,
} from '../shared/lib/pre-pr-verification-drift-validator.ts';

interface FixtureShape extends Partial<GitHubDiscoveryResult> {
  error?: string;
}

runTool({
  name: 'check-ci-verification',
  description: 'Check drift between enforced GitHub checks and the local pre-PR verification recipe',
  options: {
    repo: {
      type: 'string',
      description: 'Target repository directory (default: current directory)',
    },
    branch: {
      type: 'string',
      description: 'GitHub branch to inspect (default: configured integration branch or auto/integration)',
    },
    fix: {
      type: 'boolean',
      description: 'Reserved for future maintainer-assisted updates; never auto-accepts mappings',
    },
    'propose-mapping': {
      type: 'boolean',
      description: 'Print proposed mapping updates without applying them',
    },
    json: {
      type: 'boolean',
      description: 'Output JSON for automation',
    },
    'discovery-fixture': {
      type: 'string',
      description: 'Read discovery metadata from a fixture JSON file instead of GitHub',
    },
  },
  examples: [
    'npx tsx tools/check-ci-verification.ts',
    'npx tsx tools/check-ci-verification.ts --repo /path/to/repo --propose-mapping',
    'npx tsx tools/check-ci-verification.ts --json',
  ],
  additionalHelp: `Description:
  Compares discovered enforced GitHub check names and workflow job provenance
  against prePrVerification.recipe. Workflow YAML is never executed locally.

Exit Codes:
  0 - No blocking validation errors
  1 - Blocking drift validation errors or unavailable metadata`,
  async run({ args }) {
    const repoDir = resolveRepoDir(args.repo);
    const config = loadWavemillConfig(repoDir);
    const prePrVerification = config.prePrVerification ?? {};
    const repository = resolveGitHubRepository(repoDir);
    const branch = args.branch ?? config.integration?.integrationBranch ?? 'auto/integration';

    if (args.fix && !args.json) {
      console.warn('--fix is intentionally non-mutating for this diagnostic. Use --propose-mapping and update config explicitly.');
    }

    let discovery: GitHubDiscoveryResult | null = null;
    let metadataError: Error | string | null = null;

    if (args['discovery-fixture']) {
      const fixture = readDiscoveryFixture(resolve(repoDir, args['discovery-fixture']));
      discovery = fixture.discovery;
      metadataError = fixture.error;
    } else if (prePrVerification.source === 'github-enforced') {
      try {
        discovery = await discoverGitHubRequiredChecks(repository, branch);
        try {
          discovery.workflows = await getWorkflowJobs(repository);
        } catch {
          // Workflow job provenance is useful for review, but required check
          // names are enough to detect unmapped and remote-only drift. Keep the
          // diagnostic non-blocking and never execute workflow YAML locally.
        }
      } catch (err) {
        metadataError = err as Error;
      }
    } else {
      discovery = {
        checks: prePrVerification.requiredChecks ?? [],
        source: 'protection',
        timestamp: new Date().toISOString(),
      };
    }

    const result = validateVerificationDrift({
      repository,
      discovery,
      config: prePrVerification,
      metadataError,
    });

    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(reportDriftViolations(result, { proposeMapping: Boolean(args['propose-mapping']) }));
    }

    if (!result.passed) {
      process.exitCode = 1;
    }
  },
});

function readDiscoveryFixture(filePath: string): { discovery: GitHubDiscoveryResult | null; error: string | null } {
  const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as FixtureShape;
  if (raw.error) {
    return { discovery: null, error: raw.error };
  }

  return {
    discovery: {
      checks: raw.checks ?? [],
      source: raw.source ?? 'protection',
      timestamp: raw.timestamp ?? new Date().toISOString(),
      workflows: raw.workflows,
    },
    error: null,
  };
}

function resolveGitHubRepository(repoDir: string): string {
  try {
    const remote = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: repoDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const match = remote.match(/github\.com[:/](.+?\/.+?)(?:\.git)?$/);
    if (match) return match[1];
  } catch {
    // Fall through to cwd basename for fixture/local explicit mode.
  }

  return repoDir.split('/').filter(Boolean).slice(-2).join('/') || repoDir;
}
