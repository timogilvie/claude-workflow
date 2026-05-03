import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';

export interface ScaffoldOptions {
  targetDir: string;
  wavemillRoot: string;
  runnerCmd?: string;
  pythonVersion?: string;
  dbName?: string;
  requirementsFile?: string;
  verifyReversibility?: boolean;
  force?: boolean;
}

export interface ScaffoldResult {
  reusablePath: string;
  wrapperPath: string;
  overwritten: boolean;
}

const DEFAULT_RUNNER_CMD = 'alembic upgrade head';
const DEFAULT_PYTHON_VERSION = '3.11';
const DEFAULT_DB_NAME = 'app_test';
const DEFAULT_REQUIREMENTS_FILE = 'requirements.txt';

function ensureExistingDirectory(dirPath: string): void {
  if (!existsSync(dirPath)) {
    throw new Error(`Target directory is not a directory: ${dirPath}`);
  }

  const stats = statSync(dirPath);
  if (!stats.isDirectory()) {
    throw new Error(`Target directory is not a directory: ${dirPath}`);
  }
}

function assertWithinWorkflowsDir(filePath: string, workflowsDir: string): void {
  const relativePath = relative(workflowsDir, filePath);
  if (relativePath.startsWith('..') || relativePath === '') {
    throw new Error(`Refusing to write outside workflow directory: ${filePath}`);
  }
}

function yamlSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function buildWrapperWorkflow(options: {
  runnerCmd: string;
  pythonVersion: string;
  dbName: string;
  requirementsFile: string;
  verifyReversibility: boolean;
}): string {
  const lines = [
    'name: Migration Dry-Run',
    '',
    'on:',
    '  pull_request:',
    '',
    'jobs:',
    '  dryrun:',
    '    uses: ./.github/workflows/_migrate-dryrun.yml',
    '    with:',
    `      migration-runner-cmd: ${yamlSingleQuoted(options.runnerCmd)}`,
    `      python-version: ${yamlSingleQuoted(options.pythonVersion)}`,
    `      db-name: ${yamlSingleQuoted(options.dbName)}`,
    `      requirements-file: ${yamlSingleQuoted(options.requirementsFile)}`,
  ];

  if (options.verifyReversibility) {
    lines.push('      verify-reversibility: true');
  }

  return `${lines.join('\n')}\n`;
}

export async function scaffoldMigrateDryrun(
  options: ScaffoldOptions
): Promise<ScaffoldResult> {
  const targetDir = resolve(options.targetDir);
  const wavemillRoot = resolve(options.wavemillRoot);
  ensureExistingDirectory(targetDir);

  const workflowsDir = resolve(targetDir, '.github', 'workflows');
  const reusablePath = resolve(workflowsDir, '_migrate-dryrun.yml');
  const wrapperPath = resolve(workflowsDir, 'migrate-dryrun.yml');

  assertWithinWorkflowsDir(reusablePath, workflowsDir);
  assertWithinWorkflowsDir(wrapperPath, workflowsDir);

  const reusableExists = existsSync(reusablePath);
  const wrapperExists = existsSync(wrapperPath);
  if ((reusableExists || wrapperExists) && !options.force) {
    throw new Error(
      `Workflow files already exist. Use --force to overwrite: ${[
        reusableExists ? reusablePath : null,
        wrapperExists ? wrapperPath : null,
      ]
        .filter(Boolean)
        .join(', ')}`
    );
  }

  const templatePath = join(wavemillRoot, 'templates', 'migrate-dryrun.yml');
  const reusableContent = readFileSync(templatePath, 'utf-8');
  const wrapperContent = buildWrapperWorkflow({
    runnerCmd: options.runnerCmd ?? DEFAULT_RUNNER_CMD,
    pythonVersion: options.pythonVersion ?? DEFAULT_PYTHON_VERSION,
    dbName: options.dbName ?? DEFAULT_DB_NAME,
    requirementsFile: options.requirementsFile ?? DEFAULT_REQUIREMENTS_FILE,
    verifyReversibility: options.verifyReversibility ?? false,
  });

  mkdirSync(workflowsDir, { recursive: true });
  writeFileSync(reusablePath, reusableContent, 'utf-8');
  writeFileSync(wrapperPath, wrapperContent, 'utf-8');

  return {
    reusablePath,
    wrapperPath,
    overwritten: reusableExists || wrapperExists,
  };
}
