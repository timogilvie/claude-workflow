#!/usr/bin/env tsx
import { discoverCiChecks } from '../shared/lib/ci-check-discovery.ts';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const repoDir = arg('--worktree') ?? arg('--repo-dir') ?? process.cwd();
const branch = arg('--branch') ?? 'main';
const repo = arg('--repo');
const format = arg('--format') ?? 'json';

const result = await discoverCiChecks(repoDir, branch, repo);

if (format === 'markdown') {
  console.log(`# CI Check Discovery`);
  console.log(``);
  console.log(`Status: ${result.status}`);
  if (result.error) console.log(`Error: ${result.error}`);
  console.log(``);
  console.log(`Required checks:`);
  for (const check of result.requiredChecks ?? []) {
    console.log(`- ${check.checkName} (${check.sourceRule}${check.workflowFile ? `, ${check.workflowFile}` : ''})`);
  }
  if ((result.draftRecipe ?? []).length > 0) {
    console.log(``);
    console.log(`Draft local steps:`);
    console.log(`NOTE: These are suggestions based on workflow file parsing, NOT to be executed without manual review.`);
    for (const command of result.draftRecipe ?? []) {
      console.log(`- ${command.run}`);
    }
  }
} else {
  console.log(JSON.stringify({
    ...result,
    note: 'Draft recipe entries are suggestions based on workflow file parsing, NOT execution authority.',
  }, null, 2));
}

if (result.status === 'ok') process.exit(0);
if (result.status === 'permission-unavailable') process.exit(3);
process.exit(2);
