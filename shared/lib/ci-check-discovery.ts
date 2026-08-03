import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export interface DiscoveredRequiredCheck {
  checkName: string;
  sourceRule: 'branch-protection' | 'ruleset';
  workflowFile?: string;
  jobName?: string;
}

export interface DraftRecipeCommand {
  name: string;
  run: string;
  proposed: true;
}

export interface DiscoveryResult {
  status: 'ok' | 'permission-unavailable' | 'gh-missing' | 'no-remote';
  requiredChecks?: DiscoveredRequiredCheck[];
  draftRecipe?: DraftRecipeCommand[];
  error?: string;
}

interface WorkflowJob {
  jobKey: string;
  name: string;
  runs: string[];
  workflowFile: string;
}

function gh(args: string[], repoDir: string): { ok: true; stdout: string } | { ok: false; status: number | null; stderr: string } {
  try {
    const stdout = execFileSync('gh', args, { cwd: repoDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, stdout };
  } catch (error) {
    const err = error as { status?: number; stderr?: Buffer | string; code?: string };
    if (err.code === 'ENOENT') {
      return { ok: false, status: null, stderr: 'gh command not found' };
    }
    const stderr = Buffer.isBuffer(err.stderr) ? err.stderr.toString('utf8') : String(err.stderr ?? '');
    return { ok: false, status: err.status ?? 1, stderr };
  }
}

function repoSlug(repoDir: string): string | null {
  try {
    const remote = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: repoDir, encoding: 'utf8' }).trim();
    const match = remote.match(/github\.com[:/]([^/]+\/[^/.]+)(?:\.git)?$/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function parseStatusChecks(payload: string): string[] {
  const parsed = JSON.parse(payload) as { required_status_checks?: { contexts?: unknown; checks?: unknown } };
  const contexts = Array.isArray(parsed.required_status_checks?.contexts)
    ? parsed.required_status_checks.contexts.filter((value): value is string => typeof value === 'string')
    : [];
  const checks = Array.isArray(parsed.required_status_checks?.checks)
    ? parsed.required_status_checks.checks
      .map((value) => typeof value === 'object' && value !== null ? (value as { context?: unknown }).context : undefined)
      .filter((value): value is string => typeof value === 'string')
    : [];
  return [...new Set([...contexts, ...checks])];
}

function parseRulesetChecks(payload: string): string[] {
  const parsed = JSON.parse(payload) as unknown[];
  const checks: string[] = [];
  const walk = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    if (record.type === 'required_status_checks' && Array.isArray(record.parameters)) {
      walk(record.parameters);
    }
    if (Array.isArray(record.required_status_checks)) {
      for (const check of record.required_status_checks) {
        if (check && typeof check === 'object') {
          const context = (check as { context?: unknown }).context;
          if (typeof context === 'string') checks.push(context);
        }
      }
    }
    for (const child of Object.values(record)) walk(child);
  };
  walk(parsed);
  return [...new Set(checks)];
}

function workflowFiles(repoDir: string): string[] {
  const dir = path.join(repoDir, '.github', 'workflows');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /\.(ya?ml)$/i.test(name))
    .map((name) => path.join(dir, name));
}

export function parseWorkflowJobs(repoDir: string): WorkflowJob[] {
  const jobs: WorkflowJob[] = [];
  for (const file of workflowFiles(repoDir)) {
    const rel = path.relative(repoDir, file).split(path.sep).join('/');
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    let inJobs = false;
    let current: WorkflowJob | null = null;
    let inSteps = false;
    for (const line of lines) {
      if (/^jobs:\s*$/.test(line)) {
        inJobs = true;
        continue;
      }
      if (!inJobs) continue;
      const jobMatch = line.match(/^  ([A-Za-z0-9_-]+):\s*$/);
      if (jobMatch) {
        if (current) jobs.push(current);
        current = { jobKey: jobMatch[1], name: jobMatch[1], runs: [], workflowFile: rel };
        inSteps = false;
        continue;
      }
      if (!current) continue;
      const nameMatch = line.match(/^    name:\s*['"]?(.+?)['"]?\s*$/);
      if (nameMatch) {
        current.name = nameMatch[1];
        continue;
      }
      if (/^    steps:\s*$/.test(line)) {
        inSteps = true;
        continue;
      }
      if (inSteps) {
        const runMatch = line.match(/^      -?\s*run:\s*['"]?(.+?)['"]?\s*$/);
        if (runMatch) current.runs.push(runMatch[1]);
      }
    }
    if (current) jobs.push(current);
  }
  return jobs;
}

function annotateChecks(checks: DiscoveredRequiredCheck[], repoDir: string): { requiredChecks: DiscoveredRequiredCheck[]; draftRecipe: DraftRecipeCommand[] } {
  const jobs = parseWorkflowJobs(repoDir);
  const draftRecipe: DraftRecipeCommand[] = [];
  const requiredChecks = checks.map((check) => {
    const job = jobs.find((candidate) => candidate.name === check.checkName || candidate.jobKey === check.checkName);
    if (job) {
      for (const run of job.runs) {
        draftRecipe.push({ name: job.name, run, proposed: true });
      }
      return { ...check, workflowFile: job.workflowFile, jobName: job.name };
    }
    return check;
  });
  return { requiredChecks, draftRecipe };
}

export async function discoverCiChecks(repoDir: string, branch: string, explicitRepo?: string): Promise<DiscoveryResult> {
  const repo = explicitRepo ?? repoSlug(repoDir);
  if (!repo) return { status: 'no-remote', error: 'No GitHub origin remote was found' };

  const requiredChecks: DiscoveredRequiredCheck[] = [];
  const protection = gh(['api', `repos/${repo}/branches/${branch}/protection`], repoDir);
  if (!protection.ok) {
    if (protection.status === null) return { status: 'gh-missing', error: protection.stderr };
    if (protection.status === 401 || protection.status === 403 || /forbidden|permission|requires authentication/i.test(protection.stderr)) {
      return { status: 'permission-unavailable', error: 'GitHub branch protection metadata is unavailable; required administration/read permissions are missing' };
    }
    if (protection.status !== 404) {
      return { status: 'permission-unavailable', error: protection.stderr || `GitHub branch protection API failed with ${protection.status}` };
    }
  } else {
    for (const checkName of parseStatusChecks(protection.stdout)) {
      requiredChecks.push({ checkName, sourceRule: 'branch-protection' });
    }
  }

  const rulesets = gh(['api', `repos/${repo}/rulesets`], repoDir);
  if (!rulesets.ok) {
    if (rulesets.status === null) return { status: 'gh-missing', error: rulesets.stderr };
    if (rulesets.status === 401 || rulesets.status === 403 || /forbidden|permission|requires authentication/i.test(rulesets.stderr)) {
      return { status: 'permission-unavailable', error: 'GitHub ruleset metadata is unavailable; required administration/read permissions are missing' };
    }
  } else {
    for (const checkName of parseRulesetChecks(rulesets.stdout)) {
      if (!requiredChecks.some((check) => check.checkName === checkName)) {
        requiredChecks.push({ checkName, sourceRule: 'ruleset' });
      }
    }
  }

  return { status: 'ok', ...annotateChecks(requiredChecks, repoDir) };
}
