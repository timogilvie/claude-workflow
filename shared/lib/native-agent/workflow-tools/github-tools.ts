import {
  githubAddLabelKey,
  githubCreatePrKey,
} from './dedupe.ts';
import {
  type GitHubAddLabelRequest,
  type GitHubAddLabelResult,
  type GitHubCreatePrRequest,
  type GitHubCreatePrResult,
  type GitHubLabelRef,
  type GitHubPullRequestRef,
  type WorkflowPhase,
} from './contracts.ts';
import { isMutationAllowed } from './mutation-policy.ts';
import {
  GitHubClientError,
  createGhGitHubClient,
  type GitHubClient,
} from './github-client.ts';
import type { ToolDescriptor, WavemillToolResult } from '../tools/types.ts';

export interface GitHubToolContext {
  phase: WorkflowPhase;
  client?: GitHubClient;
}

interface RetryOptions {
  attempts?: number;
}

const DEFAULT_RETRY_ATTEMPTS = 3;

function normalizeLabel(label: string): string {
  return label.trim().toLowerCase();
}

function labelUrl(repo: string, label: string): string {
  return `https://github.com/${repo}/labels/${encodeURIComponent(label)}`;
}

function pullRequestRef(number: number, url: string): GitHubPullRequestRef {
  return {
    system: 'github',
    kind: 'pull_request',
    id: String(number),
    number,
    url,
  };
}

function labelRef(
  repo: string,
  targetKind: 'pull_request' | 'issue',
  targetNumber: number,
  label: string,
): GitHubLabelRef {
  return {
    system: 'github',
    kind: 'label',
    id: `${repo}:${targetKind}:${targetNumber}:${normalizeLabel(label)}`,
    url: labelUrl(repo, label),
  };
}

function githubCreatePrError(
  error: 'invalid_input' | 'policy_denied' | 'not_found' | 'external_error' | 'conflict' | 'rate_limited',
  message: string,
): GitHubCreatePrResult {
  return {
    ok: false,
    tool: 'github_create_pr',
    error,
    message,
  };
}

function githubAddLabelError(
  error: 'invalid_input' | 'policy_denied' | 'not_found' | 'external_error' | 'rate_limited',
  message: string,
): GitHubAddLabelResult {
  return {
    ok: false,
    tool: 'github_add_label',
    error,
    message,
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? DEFAULT_RETRY_ATTEMPTS;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!(error instanceof GitHubClientError)) {
        throw error;
      }
      if (!['rate_limited', 'external_error'].includes(error.code) || attempt === attempts) {
        throw error;
      }
    }
  }

  throw lastError;
}

function createPrSuccess(
  key: string,
  outcome: 'created' | 'reused' | 'updated',
  ref: GitHubPullRequestRef,
): GitHubCreatePrResult {
  return {
    ok: true,
    tool: 'github_create_pr',
    idempotency: {
      key,
      outcome,
      ref,
    },
  };
}

function addLabelSuccess(
  key: string,
  outcome: 'created' | 'skipped',
  ref: GitHubLabelRef | null,
  reason?: string,
): GitHubAddLabelResult {
  return {
    ok: true,
    tool: 'github_add_label',
    idempotency: {
      key,
      outcome,
      ref,
      reason,
    },
  };
}

function normalizeClientError(error: unknown): GitHubClientError {
  if (error instanceof GitHubClientError) {
    return error;
  }
  return new GitHubClientError('external_error', error instanceof Error ? error.message : String(error));
}

export async function githubCreatePr(
  req: GitHubCreatePrRequest,
  context: GitHubToolContext,
): Promise<GitHubCreatePrResult> {
  if (
    !isNonEmptyString(req.repo)
    || !isNonEmptyString(req.head)
    || !isNonEmptyString(req.base)
    || !isNonEmptyString(req.headSha)
    || !isNonEmptyString(req.title)
    || typeof req.body !== 'string'
  ) {
    return githubCreatePrError('invalid_input', 'repo, head, base, headSha, title, and body must be valid values');
  }

  const createPolicy = isMutationAllowed(context.phase, 'github_create_pr', 'create_pr');
  if (!createPolicy.allowed) {
    return githubCreatePrError('policy_denied', createPolicy.reason);
  }

  const key = githubCreatePrKey(req);
  const client = context.client ?? createGhGitHubClient();

  try {
    const existing = await withRetry(
      () => client.findOpenPullRequest({ repo: req.repo, head: req.head, base: req.base }),
    );

    if (!existing) {
      const created = await withRetry(() => client.createPullRequest(req));
      return createPrSuccess(key, 'created', pullRequestRef(created.number, created.url));
    }

    if (existing.headSha.trim() === req.headSha.trim()) {
      return createPrSuccess(key, 'reused', pullRequestRef(existing.number, existing.url));
    }

    const updatePolicy = isMutationAllowed(context.phase, 'github_create_pr', 'update_pr');
    if (!updatePolicy.allowed) {
      return githubCreatePrError('policy_denied', updatePolicy.reason);
    }

    const updated = await withRetry(() => client.updatePullRequest({
      repo: req.repo,
      number: existing.number,
      title: req.title,
      body: req.body,
    }));
    return createPrSuccess(key, 'updated', pullRequestRef(updated.number, updated.url));
  } catch (error) {
    const normalized = normalizeClientError(error);
    if (normalized.code === 'not_found') {
      return githubCreatePrError('not_found', normalized.message);
    }
    if (normalized.code === 'conflict') {
      return githubCreatePrError('conflict', normalized.message);
    }
    if (normalized.code === 'rate_limited') {
      return githubCreatePrError('rate_limited', normalized.message);
    }
    return githubCreatePrError('external_error', normalized.message);
  }
}

export async function githubAddLabel(
  req: GitHubAddLabelRequest,
  context: GitHubToolContext,
): Promise<GitHubAddLabelResult> {
  if (
    !isNonEmptyString(req.repo)
    || (req.targetKind !== 'pull_request' && req.targetKind !== 'issue')
    || !isPositiveInteger(req.targetNumber)
    || !isNonEmptyString(req.label)
  ) {
    return githubAddLabelError('invalid_input', 'repo, targetKind, targetNumber, and label must be valid values');
  }

  const policy = isMutationAllowed(context.phase, 'github_add_label', 'add_label');
  if (!policy.allowed) {
    return githubAddLabelError('policy_denied', policy.reason);
  }

  const key = githubAddLabelKey(req);
  const client = context.client ?? createGhGitHubClient();

  try {
    const existingLabels = await withRetry(() => client.listLabels({
      repo: req.repo,
      targetKind: req.targetKind,
      targetNumber: req.targetNumber,
    }));
    const normalizedRequestedLabel = normalizeLabel(req.label);
    if (existingLabels.some((label) => normalizeLabel(label) === normalizedRequestedLabel)) {
      return addLabelSuccess(key, 'skipped', null, 'label already present');
    }

    await withRetry(() => client.addLabel(req));
    return addLabelSuccess(
      key,
      'created',
      labelRef(req.repo, req.targetKind, req.targetNumber, req.label),
    );
  } catch (error) {
    const normalized = normalizeClientError(error);
    if (normalized.code === 'not_found') {
      return githubAddLabelError('not_found', normalized.message);
    }
    if (normalized.code === 'rate_limited') {
      return githubAddLabelError('rate_limited', normalized.message);
    }
    return githubAddLabelError('external_error', normalized.message);
  }
}

interface DescriptorOptions {
  client?: GitHubClient;
  phase?: WorkflowPhase;
}

const githubCreatePrParameters = {
  type: 'object',
  additionalProperties: false,
  required: ['repo', 'head', 'base', 'headSha', 'title', 'body'],
  properties: {
    repo: { type: 'string' },
    head: { type: 'string' },
    base: { type: 'string' },
    headSha: { type: 'string' },
    title: { type: 'string' },
    body: { type: 'string' },
    draft: { type: 'boolean' },
  },
} as const;

const githubAddLabelParameters = {
  type: 'object',
  additionalProperties: false,
  required: ['repo', 'targetKind', 'targetNumber', 'label'],
  properties: {
    repo: { type: 'string' },
    targetKind: { enum: ['pull_request', 'issue'] },
    targetNumber: { type: 'integer' },
    label: { type: 'string' },
  },
} as const;

function createToolContent(text: string): WavemillToolResult<GitHubCreatePrResult | GitHubAddLabelResult>['content'] {
  return [{ type: 'text', text }];
}

export function createGithubCreatePrTool(
  options: DescriptorOptions = {},
): ToolDescriptor<GitHubCreatePrRequest, GitHubCreatePrResult> {
  const phase = options.phase ?? 'review';
  return {
    metadata: {
      name: 'github_create_pr',
      description: 'Create or update a GitHub pull request idempotently for the current review phase.',
      class: 'mutation',
      allowedPhases: ['review'],
      executionMode: 'sequential',
      outputCapPolicy: { strategy: 'none' },
    },
    parameters: githubCreatePrParameters,
    async execute(_toolCallId, params) {
      const result = await githubCreatePr(params, { phase, client: options.client });
      const text = result.ok
        ? `${result.idempotency.outcome} GitHub PR ${result.idempotency.ref?.url ?? ''}`.trim()
        : `github_create_pr failed: ${result.error}: ${result.message}`;
      return {
        content: createToolContent(text),
        details: result,
      };
    },
  };
}

export function createGithubAddLabelTool(
  options: DescriptorOptions = {},
): ToolDescriptor<GitHubAddLabelRequest, GitHubAddLabelResult> {
  const phase = options.phase ?? 'review';
  return {
    metadata: {
      name: 'github_add_label',
      description: 'Add a GitHub label idempotently to a pull request or issue during review.',
      class: 'mutation',
      allowedPhases: ['review'],
      executionMode: 'sequential',
      outputCapPolicy: { strategy: 'none' },
    },
    parameters: githubAddLabelParameters,
    async execute(_toolCallId, params) {
      const result = await githubAddLabel(params, { phase, client: options.client });
      const text = result.ok
        ? `${result.idempotency.outcome} GitHub label ${result.idempotency.ref?.id ?? result.idempotency.reason ?? ''}`.trim()
        : `github_add_label failed: ${result.error}: ${result.message}`;
      return {
        content: createToolContent(text),
        details: result,
      };
    },
  };
}
