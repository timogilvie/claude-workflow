#!/usr/bin/env -S npx tsx

/**
 * Emit repository-agnostic Arbiter S2 survival labels as JSONL.
 *
 * The current directory (or --repo-dir) is only the Git object source.  No
 * `.wavemill` file is read and PR identity is resolved from owner/repo via gh.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { runTool, resolveRepoDir } from '../shared/lib/tool-runner.ts';
import {
  analyzeSurvival,
  createGithubCliClient,
  createShellGitRepository,
} from '../shared/lib/arbiter-survival-analyzer.ts';
import { HORIZONS, canonicalSerialize, type HorizonDays } from '../shared/lib/arbiter-survival-label.ts';

export function parseHorizons(value?: string): HorizonDays[] {
  if (!value) return [...HORIZONS];
  const parsed = value.split(',').map((entry) => Number(entry.trim()));
  if (parsed.length === 0 || parsed.some((day) => !HORIZONS.includes(day as HorizonDays))) {
    throw new Error('--horizons must be a comma-separated subset of 14,30,60');
  }
  return [...new Set(parsed)] as HorizonDays[];
}

function validateRequired(name: string, value: string | undefined): string {
  if (!value?.trim()) throw new Error(`--${name} is required`);
  return value;
}

function schemaValidator() {
  const schemaPath = new URL('../shared/schemas/arbiter-survival-label.schema.json', import.meta.url);
  const schema = JSON.parse(readFileSync(schemaPath, 'utf-8'));
  return new Ajv2020({ allErrors: true, strict: false, validateFormats: false }).compile(schema);
}

function printBaseRates(labels: ReturnType<typeof analyzeSurvival>, owner: string, repo: string): void {
  for (const horizon of HORIZONS) {
    const rows = labels.filter((label) => label.horizon_days === horizon);
    const observed = rows.filter((label) => label.outcome.survived !== null);
    const survived = observed.filter((label) => label.outcome.survived).length;
    const rate = observed.length === 0 ? 'n/a' : `${((survived / observed.length) * 100).toFixed(1)}%`;
    console.error(`${owner}/${repo} horizon=${horizon}d rows=${rows.length} observed=${observed.length} survived=${rate}`);
  }
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);

if (isMainModule) {
  runTool({
    name: 'backfill-survival',
    description: 'Emit repo-agnostic Arbiter S2 survival labels as JSONL',
    options: {
      owner: { type: 'string', description: 'GitHub repository owner (required)' },
      repo: { type: 'string', description: 'GitHub repository name (required)' },
      'integration-branch': { type: 'string', description: 'Non-main branch to walk first-parent (default: auto/integration)' },
      token: { type: 'string', description: 'GitHub token (defaults to GH_TOKEN)' },
      'repo-dir': { type: 'string', description: 'Local checkout supplying Git history (default: cwd)' },
      'pr-url': { type: 'string', description: 'Emit only this PR URL' },
      horizons: { type: 'string', description: 'Comma-separated horizons: 14,30,60' },
      'terminal-sha': { type: 'string', description: 'Fixed first-parent terminal SHA for deterministic replay' },
      'as-of': { type: 'string', description: 'Fixed observation timestamp used to decide elapsed horizons' },
      'computed-at': { type: 'string', description: 'Fixed ISO timestamp for byte-equivalent replay' },
    },
    examples: [
      'npx tsx tools/backfill-survival.ts --owner hokusai --repo wavemill --integration-branch auto/integration',
      'npx tsx tools/backfill-survival.ts --owner octocat --repo Hello-World --repo-dir /tmp/hello --pr-url https://github.com/octocat/Hello-World/pull/1',
    ],
    async run({ args }) {
      const owner = validateRequired('owner', args.owner);
      const repo = validateRequired('repo', args.repo);
      const integrationBranch = args['integration-branch'] || 'auto/integration';
      const repoDir = resolveRepoDir(args['repo-dir']);
      const now = args['as-of'] ? new Date(args['as-of']) : undefined;
      if (now && Number.isNaN(now.valueOf())) throw new Error('--as-of must be an ISO timestamp');
      const labels = analyzeSurvival({
        owner,
        repo,
        integrationBranch,
        git: createShellGitRepository(repoDir),
        github: createGithubCliClient(repoDir, args.token),
        prUrl: args['pr-url'],
        horizons: parseHorizons(args.horizons),
        terminalSha: args['terminal-sha'],
        now,
        computedAt: args['computed-at'],
      });
      const validate = schemaValidator();
      for (const label of labels) {
        if (!validate(label)) {
          throw new Error(`Survival label failed schema validation: ${JSON.stringify(validate.errors)}`);
        }
        process.stdout.write(`${canonicalSerialize(label)}\n`);
      }
      printBaseRates(labels, owner, repo);
    },
  });
}
