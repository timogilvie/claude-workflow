import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tailBytes } from './ci-failure-classifier.ts';
import type { NormalizedCheckSummary } from './ready-watchdog.ts';

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const MAX_ANNOTATIONS = 20;

type ExecFileAsync = (
  file: string,
  args: string[],
  options: {
    cwd: string;
    encoding: 'utf-8';
    timeout: number;
    maxBuffer: number;
  },
) => Promise<{ stdout: string; stderr?: string }>;

export interface FailedJobRef {
  owner: string;
  repo: string;
  runId: string;
  jobId: string;
}

export interface EnrichedCheckContent {
  text?: string;
  annotations?: string[];
}

export interface CiLogFetchOptions {
  repoDir: string;
  maxBytes: number;
  timeoutMs?: number;
  execFile?: ExecFileAsync;
}

export function parseGitHubActionsJobRef(detailsUrl: string | undefined): FailedJobRef | null {
  if (!detailsUrl) {
    return null;
  }
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/actions\/runs\/([^/?#]+)\/job\/([^/?#]+)(?:[?#].*)?$/.exec(detailsUrl);
  if (!match) {
    return null;
  }
  const [, owner, repo, runId, jobId] = match;
  return { owner, repo, runId, jobId };
}

export async function fetchFailedJobLogTail(
  ref: FailedJobRef,
  options: CiLogFetchOptions,
): Promise<string | null> {
  try {
    const exec = options.execFile ?? (execFileAsync as ExecFileAsync);
    const { stdout } = await exec(
      'gh',
      ['run', 'view', ref.runId, '--log-failed', '--job', ref.jobId, '--repo', `${ref.owner}/${ref.repo}`],
      execOptions(options),
    );
    return tailBytes(stdout, normalizeMaxBytes(options.maxBytes));
  } catch {
    return null;
  }
}

export async function fetchCheckRunAnnotations(
  ref: FailedJobRef,
  checkRunId: number,
  options: CiLogFetchOptions,
): Promise<string[] | null> {
  try {
    const exec = options.execFile ?? (execFileAsync as ExecFileAsync);
    const { stdout } = await exec(
      'gh',
      ['api', `repos/${ref.owner}/${ref.repo}/check-runs/${checkRunId}/annotations`],
      execOptions(options),
    );
    const parsed = JSON.parse(stdout) as unknown;
    if (!Array.isArray(parsed)) {
      return null;
    }
    return boundAnnotations(
      parsed.slice(0, MAX_ANNOTATIONS).map(formatAnnotation).filter(Boolean),
      normalizeMaxBytes(options.maxBytes),
    );
  } catch {
    return null;
  }
}

export async function enrichFailingChecks(
  checks: NormalizedCheckSummary[],
  options: CiLogFetchOptions,
): Promise<NormalizedCheckSummary[]> {
  return Promise.all(checks.map(async (check) => {
    if (check.status !== 'failure') {
      return check;
    }
    const ref = parseGitHubActionsJobRef(check.detailsUrl);
    if (!ref) {
      return check;
    }

    try {
      const results = await Promise.allSettled([
        fetchFailedJobLogTail(ref, options),
        typeof check.databaseId === 'number'
          ? fetchCheckRunAnnotations(ref, check.databaseId, options)
          : Promise.resolve(null),
      ]);
      const text = results[0].status === 'fulfilled' ? results[0].value : null;
      const annotations = results[1].status === 'fulfilled' ? results[1].value : null;
      if (!text && (!annotations || annotations.length === 0)) {
        return check;
      }
      return {
        ...check,
        text: text ? mergeText(check.text, text, options.maxBytes) : check.text,
        annotations: annotations && annotations.length > 0
          ? [...(check.annotations ?? []), ...annotations]
          : check.annotations,
      };
    } catch {
      return check;
    }
  }));
}

function execOptions(options: CiLogFetchOptions): Parameters<ExecFileAsync>[2] {
  return {
    cwd: options.repoDir,
    encoding: 'utf-8',
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER_BYTES,
  };
}

function normalizeMaxBytes(value: number): number {
  return Number.isInteger(value) && value > 0 ? value : 20_000;
}

function mergeText(existing: string | undefined, fetched: string, maxBytes: number): string {
  return tailBytes([existing, fetched].filter(Boolean).join('\n'), normalizeMaxBytes(maxBytes));
}

function formatAnnotation(annotation: unknown): string {
  if (typeof annotation !== 'object' || annotation === null) {
    return '';
  }
  const entry = annotation as Record<string, unknown>;
  const path = typeof entry.path === 'string' ? entry.path : '';
  const line = typeof entry.start_line === 'number' ? String(entry.start_line) : '';
  const level = typeof entry.annotation_level === 'string' ? entry.annotation_level : '';
  const message = typeof entry.message === 'string' ? entry.message.trim() : '';
  const location = [path, line].filter(Boolean).join(':');
  return tailBytes([location, level, message].filter(Boolean).join(' '), 240);
}

function boundAnnotations(annotations: string[], maxBytes: number): string[] {
  const bounded: string[] = [];
  let used = 0;
  for (const annotation of annotations) {
    const annotationBytes = Buffer.byteLength(annotation, 'utf-8');
    if (used + annotationBytes > maxBytes) {
      if (bounded.length === 0) {
        bounded.push(tailBytes(annotation, maxBytes));
      }
      break;
    }
    bounded.push(annotation);
    used += annotationBytes;
  }
  return bounded;
}
