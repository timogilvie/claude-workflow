#!/usr/bin/env -S npx tsx
import { isatty } from 'node:tty';
import { resolve } from 'node:path';
import { prompt } from '../shared/lib/cli-prompt.ts';
import { scaffoldMigrateDryrun } from '../shared/lib/scaffold-migrate-dryrun.ts';
import { getToolDirname, runTool } from '../shared/lib/tool-runner.ts';

const DEFAULTS = {
  runnerCmd: 'alembic upgrade head',
  pythonVersion: '3.11',
  dbName: 'app_test',
  requirementsFile: 'requirements.txt',
};

async function promptWithDefault(label: string, defaultValue: string): Promise<string> {
  const value = await prompt(`${label} [${defaultValue}]: `);
  return value || defaultValue;
}

runTool({
  name: 'scaffold-migrate-dryrun',
  description: 'Copy the migration dry-run GitHub Actions workflow into a target repo',
  options: {
    'runner-cmd': { type: 'string', description: 'Migration runner command' },
    'python-version': { type: 'string', description: 'Python version used in CI' },
    'db-name': { type: 'string', description: 'Database name for the Postgres service' },
    'requirements-file': { type: 'string', description: 'Requirements file installed in CI' },
    'verify-reversibility': { type: 'boolean', description: 'Enable downgrade-to-base and re-upgrade verification' },
    force: { type: 'boolean', description: 'Overwrite existing workflow files' },
    'non-interactive': { type: 'boolean', description: 'Skip prompts and use defaults for missing values' },
  },
  positional: {
    name: 'target-repo',
    description: 'Target repository root directory',
    required: true,
  },
  examples: [
    'npx tsx tools/scaffold-migrate-dryrun.ts ../my-service',
    'wavemill scaffold migrate-dryrun ../my-service --verify-reversibility',
  ],
  async run({ args, positional }) {
    const targetDir = resolve(positional[0]);
    const wavemillRoot = resolve(getToolDirname(import.meta.url), '..');
    const interactive = isatty(process.stdin.fd) && !args['non-interactive'];

    const runnerCmd =
      (args['runner-cmd'] as string | undefined) ??
      (interactive
        ? await promptWithDefault('Migration runner command', DEFAULTS.runnerCmd)
        : DEFAULTS.runnerCmd);
    const pythonVersion =
      (args['python-version'] as string | undefined) ??
      (interactive
        ? await promptWithDefault('Python version', DEFAULTS.pythonVersion)
        : DEFAULTS.pythonVersion);
    const dbName =
      (args['db-name'] as string | undefined) ??
      (interactive ? await promptWithDefault('Database name', DEFAULTS.dbName) : DEFAULTS.dbName);
    const requirementsFile =
      (args['requirements-file'] as string | undefined) ??
      (interactive
        ? await promptWithDefault('Requirements file', DEFAULTS.requirementsFile)
        : DEFAULTS.requirementsFile);

    const result = await scaffoldMigrateDryrun({
      targetDir,
      wavemillRoot,
      runnerCmd,
      pythonVersion,
      dbName,
      requirementsFile,
      verifyReversibility: !!args['verify-reversibility'],
      force: !!args.force,
    });

    console.log(`Reusable workflow: ${result.reusablePath}`);
    console.log(`Wrapper workflow: ${result.wrapperPath}`);
    console.log(result.overwritten ? 'Existing workflow files were overwritten.' : 'Workflow files created.');
  },
});
