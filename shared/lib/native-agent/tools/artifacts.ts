// ---------------------------------------------------------------------------
// Native artifact reader tool implementations: read_task_packet, read_plan.
// Create descriptors via createArtifactTools(worktreePath) so each executor
// closes over the resolved worktree root.
//
// Security model:
//   - slug is validated as a single safe path segment before path assembly.
//   - Candidate paths undergo lexical containment before any filesystem access.
//   - For existing paths, realpath is used to detect symlink escapes.
//   - Absent paths are reported as 'absent' only after lexical containment succeeds.
// ---------------------------------------------------------------------------

import fsPromises from 'node:fs/promises';
import path from 'node:path';
import {
  getTaskPacketArtifactPaths,
  isTaskPacketContent,
} from '../../task-packet-utils.ts';
import type { ToolDescriptor, WavemillToolResult } from './types.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_ARTIFACT_BYTES = 256 * 1024;

// ---------------------------------------------------------------------------
// Parameter types
// ---------------------------------------------------------------------------

export interface ArtifactReaderParams {
  slug: string;
}

// ---------------------------------------------------------------------------
// Detail types
// ---------------------------------------------------------------------------

export type ArtifactErrorKind = 'absent' | 'malformed' | 'path-denied';

export type ArtifactToolName = 'read_task_packet' | 'read_plan';

export interface ReadTaskPacketSuccessDetails {
  ok: true;
  tool: 'read_task_packet';
  slug: string;
  path: string;
  artifact: 'full' | 'header';
  detailsPath?: string;
  detailsExists?: boolean;
}

export interface ReadPlanSuccessDetails {
  ok: true;
  tool: 'read_plan';
  slug: string;
  path: string;
  artifact: 'plan';
}

export interface ArtifactToolErrorDetails {
  ok: false;
  tool: ArtifactToolName;
  slug: string;
  error: {
    kind: ArtifactErrorKind;
    code: string;
    message: string;
    candidates?: string[];
  };
}

export type ReadTaskPacketDetails = ReadTaskPacketSuccessDetails | ArtifactToolErrorDetails;
export type ReadPlanDetails = ReadPlanSuccessDetails | ArtifactToolErrorDetails;

// ---------------------------------------------------------------------------
// Slug validation
// ---------------------------------------------------------------------------

function validateSlugSegment(
  slug: unknown,
): { ok: true; slug: string } | { ok: false; message: string } {
  if (typeof slug !== 'string' || slug.trim() === '') {
    return { ok: false, message: 'slug must be a non-empty string' };
  }

  // Reject POSIX or Windows path separators (disallows subdirectory traversal)
  if (slug.includes('/') || slug.includes('\\')) {
    return {
      ok: false,
      message: `slug '${slug}' must be a single path segment (no separators)`,
    };
  }

  // Reject dot-only segments
  if (slug === '.' || slug === '..') {
    return { ok: false, message: `slug '${slug}' is not a valid slug` };
  }

  // Reject Windows drive-qualified paths (e.g. 'C:')
  if (/^[A-Za-z]:/.test(slug)) {
    return { ok: false, message: `slug '${slug}' appears to be an absolute path` };
  }

  // Defense-in-depth: reject slugs that change under posix normalization
  if (path.posix.normalize(slug) !== slug) {
    return { ok: false, message: `slug '${slug}' is not a normalized path segment` };
  }

  return { ok: true, slug };
}

// ---------------------------------------------------------------------------
// Artifact path resolution
// ---------------------------------------------------------------------------

type ResolveResult =
  | { kind: 'ok'; absolutePath: string; relativePath: string }
  | { kind: 'absent' }
  | { kind: 'path-denied'; message: string }
  | { kind: 'io-error'; message: string };

async function resolveArtifactPath(
  worktreeAbsolute: string,
  relativePath: string,
): Promise<ResolveResult> {
  const candidate = path.resolve(worktreeAbsolute, relativePath);

  // Lexical containment check (no filesystem access)
  const sep = path.sep;
  const withSep = worktreeAbsolute.endsWith(sep) ? worktreeAbsolute : worktreeAbsolute + sep;
  if (candidate !== worktreeAbsolute && !candidate.startsWith(withSep)) {
    return {
      kind: 'path-denied',
      message: `'${relativePath}' resolves outside the worktree`,
    };
  }

  // Check existence via stat (follows symlinks to detect if target exists)
  let statResult: Awaited<ReturnType<typeof fsPromises.stat>> | null | Error;
  try {
    statResult = await fsPromises.stat(candidate);
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') {
      statResult = null;
    } else if (e.code === 'EACCES' || e.code === 'EPERM') {
      return {
        kind: 'path-denied',
        message: `Cannot access '${relativePath}': permission denied`,
      };
    } else {
      return {
        kind: 'io-error',
        message: `Cannot access '${relativePath}': ${e.message}`,
      };
    }
  }

  if (statResult === null) {
    return { kind: 'absent' };
  }

  // Realpath to detect symlink escapes (only for paths that exist)
  let realCandidate: string;
  try {
    realCandidate = await fsPromises.realpath(candidate);
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'EACCES' || e.code === 'EPERM') {
      return {
        kind: 'path-denied',
        message: `Cannot access '${relativePath}': permission denied`,
      };
    }
    return {
      kind: 'io-error',
      message: `Cannot access '${relativePath}': ${e.message}`,
    };
  }

  let realWorktree: string;
  try {
    realWorktree = await fsPromises.realpath(worktreeAbsolute);
  } catch {
    realWorktree = worktreeAbsolute;
  }

  const realWithSep = realWorktree.endsWith(sep) ? realWorktree : realWorktree + sep;
  if (realCandidate !== realWorktree && !realCandidate.startsWith(realWithSep)) {
    return {
      kind: 'path-denied',
      message: `'${relativePath}' escapes the worktree via symlink`,
    };
  }

  const rel = path.relative(realWorktree, realCandidate) || '.';
  return { kind: 'ok', absolutePath: realCandidate, relativePath: rel };
}

async function readTextArtifact(
  absolutePath: string,
  signal?: AbortSignal,
): Promise<{ ok: true; text: string } | { ok: false; message: string }> {
  try {
    const buf = await fsPromises.readFile(absolutePath, { signal });
    return { ok: true, text: buf.toString('utf8') };
  } catch (err: unknown) {
    return { ok: false, message: (err as Error).message };
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function truncateUtf8(text: string, maxBytes: number): string {
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

function makeArtifactError(
  tool: ArtifactToolName,
  slug: string,
  kind: ArtifactErrorKind,
  message: string,
  candidates?: string[],
): WavemillToolResult<ArtifactToolErrorDetails> {
  const errorPayload = {
    kind,
    code: kind,
    message,
    ...(candidates !== undefined ? { candidates } : {}),
  };
  const details: ArtifactToolErrorDetails = {
    ok: false,
    tool,
    slug,
    error: errorPayload,
  };
  return {
    content: [{ type: 'text', text: JSON.stringify(errorPayload) }],
    details,
  };
}

// ---------------------------------------------------------------------------
// read_task_packet executor
// ---------------------------------------------------------------------------

async function executeReadTaskPacket(
  worktreeAbsolute: string,
  _toolCallId: string,
  params: ArtifactReaderParams,
  signal?: AbortSignal,
): Promise<WavemillToolResult<ReadTaskPacketDetails>> {
  const validated = validateSlugSegment(params.slug);
  if (!validated.ok) {
    return makeArtifactError('read_task_packet', String(params.slug ?? ''), 'path-denied', validated.message);
  }

  const { slug } = validated;
  const canonicalRelative = path.join('features', slug, 'task-packet.md');

  // Derive split-packet paths from the canonical path using the shared utility
  const absoluteCanonical = path.join(worktreeAbsolute, canonicalRelative);
  const artifactPaths = getTaskPacketArtifactPaths(absoluteCanonical);
  const headerRelative = path.relative(worktreeAbsolute, artifactPaths.header);
  const detailsRelative = path.relative(worktreeAbsolute, artifactPaths.details);

  // --- Try canonical full packet ---
  const canonicalResolved = await resolveArtifactPath(worktreeAbsolute, canonicalRelative);

  if (canonicalResolved.kind === 'path-denied') {
    return makeArtifactError('read_task_packet', slug, 'path-denied', canonicalResolved.message, [
      canonicalRelative,
    ]);
  }
  if (canonicalResolved.kind === 'io-error') {
    return makeArtifactError('read_task_packet', slug, 'absent', canonicalResolved.message, [
      canonicalRelative,
    ]);
  }

  if (canonicalResolved.kind === 'ok') {
    const read = await readTextArtifact(canonicalResolved.absolutePath, signal);
    if (!read.ok) {
      return makeArtifactError('read_task_packet', slug, 'absent', read.message, [
        canonicalRelative,
      ]);
    }
    if (!isTaskPacketContent(read.text)) {
      return makeArtifactError(
        'read_task_packet',
        slug,
        'malformed',
        `'${canonicalRelative}' exists but does not appear to be a valid task packet`,
        [canonicalRelative],
      );
    }
    return {
      content: [{ type: 'text', text: truncateUtf8(read.text, MAX_ARTIFACT_BYTES) }],
      details: {
        ok: true,
        tool: 'read_task_packet',
        slug,
        path: canonicalResolved.relativePath,
        artifact: 'full',
      },
    };
  }

  // --- Canonical absent: try header ---
  const headerResolved = await resolveArtifactPath(worktreeAbsolute, headerRelative);

  if (headerResolved.kind === 'path-denied') {
    return makeArtifactError('read_task_packet', slug, 'path-denied', headerResolved.message, [
      canonicalRelative,
      headerRelative,
    ]);
  }

  if (headerResolved.kind === 'ok') {
    const read = await readTextArtifact(headerResolved.absolutePath, signal);
    if (!read.ok) {
      return makeArtifactError('read_task_packet', slug, 'absent', read.message, [
        canonicalRelative,
        headerRelative,
      ]);
    }
    if (!isTaskPacketContent(read.text)) {
      return makeArtifactError(
        'read_task_packet',
        slug,
        'malformed',
        `'${headerRelative}' exists but does not appear to be a valid task packet`,
        [canonicalRelative, headerRelative],
      );
    }

    // Check details file (best-effort; does not fail the overall read)
    const detailsResolved = await resolveArtifactPath(worktreeAbsolute, detailsRelative);
    const detailsExists = detailsResolved.kind === 'ok';

    return {
      content: [{ type: 'text', text: truncateUtf8(read.text, MAX_ARTIFACT_BYTES) }],
      details: {
        ok: true,
        tool: 'read_task_packet',
        slug,
        path: headerResolved.relativePath,
        artifact: 'header',
        detailsPath: detailsExists ? detailsResolved.relativePath : undefined,
        detailsExists,
      },
    };
  }

  // --- Both canonical and header are absent ---
  return makeArtifactError(
    'read_task_packet',
    slug,
    'absent',
    `No task packet found for slug '${slug}'. Checked: ${canonicalRelative}, ${headerRelative}`,
    [canonicalRelative, headerRelative],
  );
}

// ---------------------------------------------------------------------------
// read_plan executor
// ---------------------------------------------------------------------------

async function executeReadPlan(
  worktreeAbsolute: string,
  _toolCallId: string,
  params: ArtifactReaderParams,
  signal?: AbortSignal,
): Promise<WavemillToolResult<ReadPlanDetails>> {
  const validated = validateSlugSegment(params.slug);
  if (!validated.ok) {
    return makeArtifactError('read_plan', String(params.slug ?? ''), 'path-denied', validated.message);
  }

  const { slug } = validated;
  const planRelative = path.join('features', slug, 'plan.md');

  const resolved = await resolveArtifactPath(worktreeAbsolute, planRelative);

  if (resolved.kind === 'path-denied') {
    return makeArtifactError('read_plan', slug, 'path-denied', resolved.message, [planRelative]);
  }
  if (resolved.kind === 'io-error') {
    return makeArtifactError('read_plan', slug, 'absent', resolved.message, [planRelative]);
  }
  if (resolved.kind === 'absent') {
    return makeArtifactError(
      'read_plan',
      slug,
      'absent',
      `No plan found for slug '${slug}'. Checked: ${planRelative}`,
      [planRelative],
    );
  }

  const read = await readTextArtifact(resolved.absolutePath, signal);
  if (!read.ok) {
    return makeArtifactError('read_plan', slug, 'absent', read.message, [planRelative]);
  }

  if (read.text.trim() === '') {
    return makeArtifactError(
      'read_plan',
      slug,
      'malformed',
      `'${planRelative}' exists but is empty`,
      [planRelative],
    );
  }

  return {
    content: [{ type: 'text', text: truncateUtf8(read.text, MAX_ARTIFACT_BYTES) }],
    details: {
      ok: true,
      tool: 'read_plan',
      slug,
      path: resolved.relativePath,
      artifact: 'plan',
    },
  };
}

// ---------------------------------------------------------------------------
// JSON Schema definitions
// ---------------------------------------------------------------------------

const ARTIFACT_READER_SCHEMA = {
  type: 'object',
  required: ['slug'],
  properties: {
    slug: {
      type: 'string',
      description:
        'Feature slug (single path segment, no separators) identifying the feature directory, e.g. "my-feature-slug".',
    },
  },
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// afterToolCall hook
// ---------------------------------------------------------------------------

interface ArtifactAfterToolCallContext {
  toolCall: { name: string };
  result: { details: unknown };
}

interface ArtifactAfterToolCallResult {
  isError?: boolean;
}

/**
 * Mark artifact tool results with ok: false as loop errors.
 *
 * Wire this into runWavemillLoop({ afterToolCall }) alongside other
 * family-specific hooks. Returns undefined for unrelated tool names.
 */
export async function artifactAfterToolCall(
  context: ArtifactAfterToolCallContext,
): Promise<ArtifactAfterToolCallResult | undefined> {
  if (
    context.toolCall.name !== 'read_task_packet' &&
    context.toolCall.name !== 'read_plan'
  ) {
    return undefined;
  }
  const details = context.result.details as { ok?: boolean } | undefined;
  if (!details || typeof details !== 'object' || !('ok' in details)) {
    return undefined;
  }
  return details.ok ? undefined : { isError: true };
}

// ---------------------------------------------------------------------------
// Named tool factories
// ---------------------------------------------------------------------------

export function createReadTaskPacketTool(
  worktreePath: string,
): ToolDescriptor<ArtifactReaderParams, ReadTaskPacketDetails> {
  const absWorktree = path.resolve(worktreePath);
  return {
    metadata: {
      name: 'read_task_packet',
      description:
        'Read the task packet for a feature slug. Returns task-packet.md if present and valid; falls back to task-packet-header.md (progressive disclosure format) when the canonical file is absent. Returns structured errors distinguishing absent, malformed, and path-denied cases.',
      class: 'read-only',
      allowedPhases: ['planning', 'coding', 'review'],
      executionMode: 'parallel',
      outputCapPolicy: { strategy: 'truncate', maxBytes: MAX_ARTIFACT_BYTES },
    },
    parameters: ARTIFACT_READER_SCHEMA,
    async execute(toolCallId, params, signal) {
      return executeReadTaskPacket(absWorktree, toolCallId, params, signal);
    },
  };
}

export function createReadPlanTool(
  worktreePath: string,
): ToolDescriptor<ArtifactReaderParams, ReadPlanDetails> {
  const absWorktree = path.resolve(worktreePath);
  return {
    metadata: {
      name: 'read_plan',
      description:
        'Read the implementation plan for a feature slug. Returns features/<slug>/plan.md content when present and non-empty. Returns structured errors distinguishing absent (file missing), malformed (empty content), and path-denied cases.',
      class: 'read-only',
      allowedPhases: ['planning', 'coding', 'review'],
      executionMode: 'parallel',
      outputCapPolicy: { strategy: 'truncate', maxBytes: MAX_ARTIFACT_BYTES },
    },
    parameters: ARTIFACT_READER_SCHEMA,
    async execute(toolCallId, params, signal) {
      return executeReadPlan(absWorktree, toolCallId, params, signal);
    },
  };
}

/**
 * Create both artifact reader tool descriptors bound to a specific worktree.
 *
 * Pass the result to createToolRegistry() or register each descriptor
 * individually.
 */
export function createArtifactTools(worktreePath: string): readonly ToolDescriptor[] {
  return [createReadTaskPacketTool(worktreePath), createReadPlanTool(worktreePath)];
}
