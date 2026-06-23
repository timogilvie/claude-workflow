// ---------------------------------------------------------------------------
// Native artifact-reader tool implementations: read_task_packet, read_plan.
// Create descriptors via createArtifactTools(worktreePath).
// ---------------------------------------------------------------------------

import fsPromises from 'node:fs/promises';
import path from 'node:path';
import type { ToolDescriptor, WavemillToolResult } from './types.ts';
import { resolveInsideWorktree, type PathErr } from './read-only.ts';
import { getTaskPacketArtifactPaths, isTaskPacketContent } from '../../task-packet-utils.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_ARTIFACT_BYTES = 256 * 1024;
const FEATURE_ROOTS = ['features', 'bugs'] as const;

// ---------------------------------------------------------------------------
// Parameter types
// ---------------------------------------------------------------------------

export interface ReadTaskPacketParams {
  slug: string;
}

export interface ReadPlanParams {
  slug: string;
}

// ---------------------------------------------------------------------------
// Detail types
// ---------------------------------------------------------------------------

export interface ToolErrorDetails {
  error: string;
  message: string;
}

export interface ReadTaskPacketDetails {
  resolvedPath: string;
  format: 'full' | 'split' | 'header-only';
  truncated: boolean;
}

export interface ReadPlanDetails {
  resolvedPath: string;
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makeError(code: string, message: string): WavemillToolResult<ToolErrorDetails> {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: code, message }) }],
    details: { error: code, message },
  };
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= maxBytes) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return text.slice(0, lo);
}

function looksLikeBinary(buf: Buffer): boolean {
  const checkLen = Math.min(buf.length, 8192);
  for (let i = 0; i < checkLen; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Slug validation
// ---------------------------------------------------------------------------

interface SlugError {
  code: 'invalid_params' | 'path_denied';
  message: string;
}

/**
 * Map a resolveInsideWorktree error to a fatal artifact-reader response, or
 * return null to indicate the artifact is simply absent at this candidate path
 * (so the caller can try the next alias / root).
 *
 * Only 'not_found' is treated as fall-through. Any other code (io_error,
 * permission_denied, path_outside_worktree, invalid_params) is surfaced
 * immediately so genuine filesystem failures are not masked as 'not_found'.
 */
function classifyResolveError(err: PathErr): WavemillToolResult<ToolErrorDetails> | null {
  if (err.code === 'not_found') return null;
  if (err.code === 'path_outside_worktree') return makeError('path_denied', err.message);
  return makeError(err.code, err.message);
}

function validateSlug(slug: unknown): SlugError | null {
  if (!slug || typeof slug !== 'string') {
    return { code: 'invalid_params', message: 'slug must be a non-empty string' };
  }
  if (slug.includes('/') || slug.includes('\\')) {
    return { code: 'path_denied', message: `slug '${slug}' contains a path separator` };
  }
  if (slug === '.' || slug === '..') {
    return { code: 'path_denied', message: `slug '${slug}' is not a valid feature name` };
  }
  if (path.isAbsolute(slug)) {
    return { code: 'path_denied', message: `slug '${slug}' must not be an absolute path` };
  }
  return null;
}

// ---------------------------------------------------------------------------
// File reading helper
// ---------------------------------------------------------------------------

type ReadTextResult =
  | { kind: 'ok'; text: string; truncated: boolean }
  | { kind: 'binary' }
  | { kind: 'io_error'; message: string };

async function readTextFileCapped(absPath: string): Promise<ReadTextResult> {
  let buf: Buffer;
  try {
    buf = await fsPromises.readFile(absPath);
  } catch (err: unknown) {
    return { kind: 'io_error', message: (err as Error).message };
  }
  if (looksLikeBinary(buf)) {
    return { kind: 'binary' };
  }
  const text = buf.toString('utf8');
  if (Buffer.byteLength(text, 'utf8') > MAX_ARTIFACT_BYTES) {
    const truncatedText = truncateUtf8(text, MAX_ARTIFACT_BYTES);
    return { kind: 'ok', text: truncatedText, truncated: true };
  }
  return { kind: 'ok', text, truncated: false };
}

// ---------------------------------------------------------------------------
// read_task_packet executor
// ---------------------------------------------------------------------------

async function executeReadTaskPacket(
  worktreeAbs: string,
  params: ReadTaskPacketParams,
): Promise<WavemillToolResult<ReadTaskPacketDetails | ToolErrorDetails>> {
  const slugErr = validateSlug(params.slug);
  if (slugErr) return makeError(slugErr.code, slugErr.message);
  const slug = params.slug;

  for (const root of FEATURE_ROOTS) {
    const featureDir = path.join(root, slug);
    const artifactPaths = getTaskPacketArtifactPaths(path.join(featureDir, 'task-packet.md'));

    // --- Try full task-packet.md ---
    const fullResolved = await resolveInsideWorktree(worktreeAbs, artifactPaths.full);
    if (fullResolved.kind === 'error') {
      const surfaced = classifyResolveError(fullResolved);
      if (surfaced) return surfaced;
    }

    if (fullResolved.kind === 'ok') {
      const readResult = await readTextFileCapped(fullResolved.absolutePath);
      if (readResult.kind === 'binary') {
        return makeError('malformed', `Task packet '${artifactPaths.full}' appears to be a binary file`);
      }
      if (readResult.kind === 'io_error') {
        return makeError('io_error', `Cannot read task packet: ${readResult.message}`);
      }
      if (!isTaskPacketContent(readResult.text)) {
        return makeError('malformed', `Task packet '${artifactPaths.full}' does not contain structured task packet content`);
      }
      const content = readResult.truncated
        ? readResult.text + `\n[Truncated: ${MAX_ARTIFACT_BYTES} bytes; content may be incomplete]`
        : readResult.text;
      return {
        content: [{ type: 'text', text: content }],
        details: { resolvedPath: fullResolved.relativePath, format: 'full', truncated: readResult.truncated },
      };
    }

    // --- Try split: header + details ---
    const headerResolved = await resolveInsideWorktree(worktreeAbs, artifactPaths.header);
    if (headerResolved.kind === 'error') {
      const surfaced = classifyResolveError(headerResolved);
      if (surfaced) return surfaced;
    }
    const detailsResolved = await resolveInsideWorktree(worktreeAbs, artifactPaths.details);
    if (detailsResolved.kind === 'error') {
      const surfaced = classifyResolveError(detailsResolved);
      if (surfaced) return surfaced;
    }

    if (headerResolved.kind === 'ok' && detailsResolved.kind === 'ok') {
      const headerRead = await readTextFileCapped(headerResolved.absolutePath);
      if (headerRead.kind === 'binary') {
        return makeError('malformed', `Task packet header appears to be a binary file`);
      }
      if (headerRead.kind === 'io_error') {
        return makeError('io_error', `Cannot read task packet header: ${headerRead.message}`);
      }
      const detailsRead = await readTextFileCapped(detailsResolved.absolutePath);
      if (detailsRead.kind === 'binary') {
        return makeError('malformed', `Task packet details appears to be a binary file`);
      }
      if (detailsRead.kind === 'io_error') {
        return makeError('io_error', `Cannot read task packet details: ${detailsRead.message}`);
      }

      const combined = `${headerRead.text}\n\n---\n\n${detailsRead.text}`;
      const combinedBytes = Buffer.byteLength(combined, 'utf8');
      let finalText = combined;
      let truncated = headerRead.truncated || detailsRead.truncated;

      if (combinedBytes > MAX_ARTIFACT_BYTES) {
        finalText = truncateUtf8(combined, MAX_ARTIFACT_BYTES);
        truncated = true;
      }

      if (!isTaskPacketContent(finalText)) {
        return makeError('malformed', `Task packet does not contain structured task packet content`);
      }

      if (truncated) {
        finalText += `\n[Truncated: ${MAX_ARTIFACT_BYTES} bytes; content may be incomplete]`;
      }

      return {
        content: [{ type: 'text', text: finalText }],
        details: { resolvedPath: headerResolved.relativePath, format: 'split', truncated },
      };
    }

    // --- Try header-only ---
    if (headerResolved.kind === 'ok') {
      const headerRead = await readTextFileCapped(headerResolved.absolutePath);
      if (headerRead.kind === 'binary') {
        return makeError('malformed', `Task packet header appears to be a binary file`);
      }
      if (headerRead.kind === 'io_error') {
        return makeError('io_error', `Cannot read task packet header: ${headerRead.message}`);
      }
      if (!isTaskPacketContent(headerRead.text)) {
        return makeError('malformed', `Task packet header does not contain structured task packet content`);
      }
      const content = headerRead.truncated
        ? headerRead.text + `\n[Truncated: ${MAX_ARTIFACT_BYTES} bytes; content may be incomplete]`
        : headerRead.text;
      return {
        content: [{ type: 'text', text: content }],
        details: { resolvedPath: headerResolved.relativePath, format: 'header-only', truncated: headerRead.truncated },
      };
    }
  }

  return makeError('not_found', `No task packet found for feature '${slug}'`);
}

// ---------------------------------------------------------------------------
// read_plan executor
// ---------------------------------------------------------------------------

async function executeReadPlan(
  worktreeAbs: string,
  params: ReadPlanParams,
): Promise<WavemillToolResult<ReadPlanDetails | ToolErrorDetails>> {
  const slugErr = validateSlug(params.slug);
  if (slugErr) return makeError(slugErr.code, slugErr.message);
  const slug = params.slug;

  for (const root of FEATURE_ROOTS) {
    const planRelPath = path.join(root, slug, 'plan.md');

    const resolved = await resolveInsideWorktree(worktreeAbs, planRelPath);
    if (resolved.kind === 'error') {
      const surfaced = classifyResolveError(resolved);
      if (surfaced) return surfaced;
    }

    if (resolved.kind === 'ok') {
      const readResult = await readTextFileCapped(resolved.absolutePath);
      if (readResult.kind === 'binary') {
        return makeError('malformed', `Plan '${planRelPath}' appears to be a binary file`);
      }
      if (readResult.kind === 'io_error') {
        return makeError('io_error', `Cannot read plan: ${readResult.message}`);
      }
      if (!readResult.text.trim()) {
        return makeError('malformed', `Plan '${planRelPath}' is empty`);
      }
      const content = readResult.truncated
        ? readResult.text + `\n[Truncated: ${MAX_ARTIFACT_BYTES} bytes; content may be incomplete]`
        : readResult.text;
      return {
        content: [{ type: 'text', text: content }],
        details: { resolvedPath: resolved.relativePath, truncated: readResult.truncated },
      };
    }
  }

  return makeError('not_found', `No plan found for feature '${slug}'`);
}

// ---------------------------------------------------------------------------
// JSON Schema definitions
// ---------------------------------------------------------------------------

const READ_TASK_PACKET_SCHEMA = {
  type: 'object',
  required: ['slug'],
  properties: {
    slug: {
      type: 'string',
      description: 'Feature slug (the <slug> in features/<slug>/).',
    },
  },
  additionalProperties: false,
};

const READ_PLAN_SCHEMA = {
  type: 'object',
  required: ['slug'],
  properties: {
    slug: {
      type: 'string',
      description: 'Feature slug (the <slug> in features/<slug>/).',
    },
  },
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// Granular factories (mirrors createGitStatusTool / createGitDiffTool)
// ---------------------------------------------------------------------------

export function createReadTaskPacketTool(
  worktreePath: string,
): ToolDescriptor<ReadTaskPacketParams, ReadTaskPacketDetails | ToolErrorDetails> {
  const absWorktree = path.resolve(worktreePath);
  return {
    metadata: {
      name: 'read_task_packet',
      description:
        'Read the task packet for a feature or bug by slug. Resolves features/<slug>/task-packet.md and supported normalized aliases (split header+details, header-only). Returns structured errors for absent, malformed, or path-denied artifacts.',
      class: 'read-only',
      allowedPhases: ['planning', 'coding', 'review'],
      executionMode: 'parallel',
      outputCapPolicy: { strategy: 'truncate', maxBytes: MAX_ARTIFACT_BYTES },
    },
    parameters: READ_TASK_PACKET_SCHEMA,
    async execute(_toolCallId, params, _signal) {
      return executeReadTaskPacket(absWorktree, params as ReadTaskPacketParams);
    },
  };
}

export function createReadPlanTool(
  worktreePath: string,
): ToolDescriptor<ReadPlanParams, ReadPlanDetails | ToolErrorDetails> {
  const absWorktree = path.resolve(worktreePath);
  return {
    metadata: {
      name: 'read_plan',
      description:
        'Read the implementation plan for a feature or bug by slug. Resolves features/<slug>/plan.md (and bugs/<slug>/plan.md). Returns structured errors for absent, malformed, or path-denied artifacts.',
      class: 'read-only',
      allowedPhases: ['planning', 'coding', 'review'],
      executionMode: 'parallel',
      outputCapPolicy: { strategy: 'truncate', maxBytes: MAX_ARTIFACT_BYTES },
    },
    parameters: READ_PLAN_SCHEMA,
    async execute(_toolCallId, params, _signal) {
      return executeReadPlan(absWorktree, params as ReadPlanParams);
    },
  };
}

// ---------------------------------------------------------------------------
// Composite factory
// ---------------------------------------------------------------------------

/**
 * Create the two artifact-reader tool descriptors bound to a specific worktree.
 *
 * Pass the result to createToolRegistry() or register each descriptor
 * individually.
 */
export function createArtifactTools(worktreePath: string): ToolDescriptor[] {
  return [createReadTaskPacketTool(worktreePath), createReadPlanTool(worktreePath)];
}

/** Tool names exported for downstream wiring / policy config. */
export const ARTIFACT_TOOL_NAMES = ['read_task_packet', 'read_plan'] as const;
