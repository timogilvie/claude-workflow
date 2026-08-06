import { readFileSync } from 'node:fs';
import path, { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getReadyFailureClassifierConfig } from '../shared/lib/config.ts';
import { lookupLocalCommand } from '../shared/lib/ci-failure-classifier.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const defaultRepoRoot = join(__dirname, '..');

const NO_LOCAL_RECIPE = new Set([
  'Shell and Unit Tests',
  'Check Lifecycle Paths',
]);

export interface CiCommandMapDriftResult {
  ok: boolean;
  checkedJobs: string[];
  skippedJobs: string[];
  unmappedJobs: string[];
}

interface WorkflowJob {
  name: string;
  matrix: Record<string, string[]>;
}

export function checkCiCommandMapDrift(repoDir = defaultRepoRoot): CiCommandMapDriftResult {
  const workflowPath = path.join(repoDir, '.github', 'workflows', 'ci.yml');
  const workflow = readFileSync(workflowPath, 'utf-8');
  const jobs = expandWorkflowJobNames(parseWorkflowJobs(workflow));
  const localCommandMap = getReadyFailureClassifierConfig(repoDir).localCommandMap;
  const skippedJobs = jobs.filter((job) => NO_LOCAL_RECIPE.has(job));
  const checkedJobs = jobs.filter((job) => !NO_LOCAL_RECIPE.has(job));
  const unmappedJobs = checkedJobs.filter((job) => lookupLocalCommand(job, localCommandMap) === undefined);

  return {
    ok: unmappedJobs.length === 0,
    checkedJobs,
    skippedJobs,
    unmappedJobs,
  };
}

export function formatCiCommandMapDrift(result: CiCommandMapDriftResult): string {
  if (result.ok) {
    return `ci-command-map-drift: ok (${result.checkedJobs.length} mapped, ${result.skippedJobs.length} skipped)`;
  }

  const lines = [
    'ci-command-map-drift: unmapped CI jobs found:',
    ...result.unmappedJobs.map((job, index) => `${index + 1}. ${job}`),
    '',
    'Add a runnable recipe for each job to ready.localCommandMap in .wavemill-config.json,',
    'or add non-runnable aggregator/filter jobs to the explicit NO_LOCAL_RECIPE allowlist.',
  ];
  return lines.join('\n');
}

function parseWorkflowJobs(workflow: string): WorkflowJob[] {
  const jobsBlock = workflow.match(/^jobs:\n(?<body>[\s\S]*)$/m)?.groups?.body;
  if (!jobsBlock) {
    return [];
  }

  const jobMatches = [...jobsBlock.matchAll(/^  ([A-Za-z0-9_-]+):\s*$/gm)];
  return jobMatches.flatMap((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = index + 1 < jobMatches.length ? jobMatches[index + 1].index ?? jobsBlock.length : jobsBlock.length;
    const block = jobsBlock.slice(start, end);
    const name = readJobName(block);
    if (!name) {
      return [];
    }
    return [{ name, matrix: readMatrix(block) }];
  });
}

function readJobName(block: string): string | null {
  const raw = block.match(/^    name:\s*(.+?)\s*$/m)?.[1];
  return raw ? stripYamlQuotes(raw) : null;
}

function readMatrix(block: string): Record<string, string[]> {
  const matrix: Record<string, string[]> = {};
  const matcher = /^        ([A-Za-z_][A-Za-z0-9_-]*):\s*\[(.*?)\]\s*$/gm;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(block))) {
    matrix[match[1]] = match[2]
      .split(',')
      .map((value) => stripYamlQuotes(value.trim()))
      .filter(Boolean);
  }
  return matrix;
}

function expandWorkflowJobNames(jobs: WorkflowJob[]): string[] {
  return jobs.flatMap((job) => {
    const variables = [...job.name.matchAll(/\$\{\{\s*matrix\.([A-Za-z_][A-Za-z0-9_-]*)\s*\}\}/g)]
      .map((match) => match[1]);
    const uniqueVariables = [...new Set(variables)];
    if (uniqueVariables.length === 0) {
      return [job.name];
    }

    const expansions = expandMatrixValues(uniqueVariables, job.matrix);
    return expansions.map((values) => {
      let expanded = job.name;
      for (const [key, value] of Object.entries(values)) {
        expanded = expanded.replace(new RegExp(`\\$\\{\\{\\s*matrix\\.${escapeRegExp(key)}\\s*\\}\\}`, 'g'), value);
      }
      return expanded;
    });
  });
}

function expandMatrixValues(keys: string[], matrix: Record<string, string[]>): Record<string, string>[] {
  return keys.reduce<Record<string, string>[]>((acc, key) => {
    const values = matrix[key] ?? [];
    if (values.length === 0) {
      return acc;
    }
    return acc.flatMap((current) => values.map((value) => ({ ...current, [key]: value })));
  }, [{}]);
}

function stripYamlQuotes(value: string): string {
  return value.replace(/^['"]|['"]$/g, '');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

if (process.argv[1] === __filename) {
  const result = checkCiCommandMapDrift(process.argv[2] ?? defaultRepoRoot);
  const message = formatCiCommandMapDrift(result);
  if (!result.ok) {
    console.error(message);
    process.exit(1);
  }
  console.log(message);
}
