/**
 * Typed Resource Retrieval API
 *
 * Resolves prompt, memory, and policy resources by typed contract rather than
 * by direct file path. Callers describe what capability they need; this module
 * maps the request to the backing file, reads it, registers it with typed
 * metadata, and returns content plus attribution.
 *
 * File-backed storage is preserved in phase one; the contract layer is a
 * retrieval facade over the same `tools/prompts/` and `.wavemill/` directories.
 *
 * @module resource-retrieval
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ResourceRef } from './resource-registry.ts';
import { registerPromptTemplate, type PromptContractMetadata } from './resource-adapters/prompt-adapter.ts';
import { registerResource, toResourceRef } from './resource-registry.ts';
import { logPromptUsage } from './prompt-registry.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = join(__dirname, '..', '..', 'tools', 'prompts');

// ────────────────────────────────────────────────────────────────
// Typed contracts
// ────────────────────────────────────────────────────────────────

export type ResourceClass = 'prompt' | 'memory' | 'policy';

export type StabilityChannel = 'stable' | 'canary' | 'experimental' | 'optimized';

export type PromptStage =
  | 'planning'
  | 'coding'
  | 'review'
  | 'eval'
  | 'initiative-planning'
  | 'issue-expansion'
  | 'context-update'
  | 'task-packet-validation'
  | 'self-review';

export type PromptRole =
  | 'phase'
  | 'reviewer'
  | 'planner'
  | 'judge'
  | 'writer'
  | 'context-updater'
  | 'validator';

export type MemoryTier = 'hot' | 'cold' | 'concept';

export type PolicyName = 'config' | 'claude-permissions' | 'codex-permissions';

// ────────────────────────────────────────────────────────────────
// Request shapes
// ────────────────────────────────────────────────────────────────

export interface PromptResourceRequest {
  class: 'prompt';
  stage: PromptStage;
  role: PromptRole;
  /** Controls which template variant is selected for mode-sensitive prompts */
  operatingMode?: 'normal' | 'constrained' | 'survival';
  /**
   * Reviewer persona for `stage='review', role='reviewer'`.
   * Defaults to 'general' when omitted.
   */
  persona?: string;
  stability?: StabilityChannel;
  repoDir?: string;
}

export interface MemoryResourceRequest {
  class: 'memory';
  tier: MemoryTier;
  repoDir: string;
  /** Required when tier is 'cold' */
  subsystemId?: string;
  /** Required when tier is 'concept' */
  conceptId?: string;
  stability?: StabilityChannel;
}

export interface PolicyResourceRequest {
  class: 'policy';
  name: PolicyName;
  repoDir: string;
  stability?: StabilityChannel;
}

export type ResourceRequest = PromptResourceRequest | MemoryResourceRequest | PolicyResourceRequest;

// ────────────────────────────────────────────────────────────────
// Result shape
// ────────────────────────────────────────────────────────────────

export interface ResolvedResource {
  content: string;
  /** Absolute path to the backing file */
  path: string;
  resourceRef: ResourceRef | null;
  metadata: Record<string, unknown>;
  request: ResourceRequest;
  selectedStability: StabilityChannel;
}

// ────────────────────────────────────────────────────────────────
// Static prompt catalog
// ────────────────────────────────────────────────────────────────

/**
 * Maps (stage, role, operatingMode, persona) tuples to backing file names.
 *
 * Key format: "stage:role" or "stage:role:mode" or "stage:role:mode:persona"
 * Lookup is tried from most specific to least specific.
 */
const PROMPT_CATALOG: Record<string, string> = {
  // Phase prompts
  'planning:phase': 'planning-phase.md',
  'coding:phase': 'coding-phase.md',
  'review:phase': 'review-phase.md',

  // Reviewer prompts — general persona (mode-sensitive)
  'review:reviewer:normal:general': 'review-general.md',
  'review:reviewer:constrained:general': 'review-general-scoped.md',
  'review:reviewer:survival:general': 'review-general-scoped.md',
  // Reviewer prompts — other personas (mode-insensitive)
  'review:reviewer::security': 'review-security.md',
  'review:reviewer::performance': 'review-performance.md',
  'review:reviewer::correctness': 'review-correctness.md',
  'review:reviewer::design': 'review-design.md',
  // Fallback for reviewer with mode but no persona (treated as general)
  'review:reviewer:normal': 'review-general.md',
  'review:reviewer:constrained': 'review-general-scoped.md',
  'review:reviewer:survival': 'review-general-scoped.md',
  // Fallback for reviewer with no mode and no persona
  'review:reviewer': 'review-general.md',

  // Initiative planning prompts
  'initiative-planning:planner:normal': 'initiative-planner.md',
  'initiative-planning:planner:constrained': 'initiative-planner-compressed.md',
  'initiative-planning:planner:survival': 'initiative-planner-compressed.md',
  'initiative-planning:planner': 'initiative-planner.md',
  // Research phase (used for initiative planning research step)
  'initiative-planning:writer': 'research-phase.md',

  // Issue expansion
  'issue-expansion:writer': 'issue-writer.md',
  'issue-expansion:planner': 'research-phase.md',

  // Task packet validation
  'task-packet-validation:validator': 'task-packet-reviewer.md',

  // Eval
  'eval:judge': 'eval-judge.md',

  // Context update
  'context-update:context-updater': 'context-update-template.md',
  'context-update:writer': 'context-update-template.md',

  // Self review
  'self-review:reviewer': 'self-review-instructions.md',
};

/** Additional catalog entries for less common templates. */
const EXTENDED_PROMPT_CATALOG: Record<string, string> = {
  'context-update:validator': 'subsystem-update-template.md',
  'context-update:planner': 'subsystem-manual-update-template.md',
  'context-update:phase': 'subsystem-spec-template.md',
  'context-update:judge': 'concept-page-template.md',
  'issue-expansion:judge': 'project-context-template.md',
};

/** Policy file paths relative to repoDir. */
const POLICY_CATALOG: Record<PolicyName, string> = {
  'config': '.wavemill-config.json',
  'claude-permissions': '.wavemill/claude-permissions.json',
  'codex-permissions': '.wavemill/codex-permissions.json',
};

// ────────────────────────────────────────────────────────────────
// Internal helpers
// ────────────────────────────────────────────────────────────────

function resolvePromptFileName(request: PromptResourceRequest): string | undefined {
  const mode = request.operatingMode ?? 'normal';
  const persona = request.persona;

  if (persona) {
    // Most specific: stage:role:mode:persona
    const k1 = `${request.stage}:${request.role}:${mode}:${persona}`;
    if (PROMPT_CATALOG[k1]) return PROMPT_CATALOG[k1];
    if (EXTENDED_PROMPT_CATALOG[k1]) return EXTENDED_PROMPT_CATALOG[k1];
    // Without mode: stage:role::persona
    const k2 = `${request.stage}:${request.role}::${persona}`;
    if (PROMPT_CATALOG[k2]) return PROMPT_CATALOG[k2];
    if (EXTENDED_PROMPT_CATALOG[k2]) return EXTENDED_PROMPT_CATALOG[k2];
  }

  // With mode but no persona: stage:role:mode
  const k3 = `${request.stage}:${request.role}:${mode}`;
  if (PROMPT_CATALOG[k3]) return PROMPT_CATALOG[k3];
  if (EXTENDED_PROMPT_CATALOG[k3]) return EXTENDED_PROMPT_CATALOG[k3];

  // Without mode or persona: stage:role
  const k4 = `${request.stage}:${request.role}`;
  if (PROMPT_CATALOG[k4]) return PROMPT_CATALOG[k4];
  if (EXTENDED_PROMPT_CATALOG[k4]) return EXTENDED_PROMPT_CATALOG[k4];

  return undefined;
}

/**
 * Resolve the absolute path to a prompt backing file from the catalog.
 * Returns the path regardless of whether the file exists.
 */
export function resolvePromptPath(request: PromptResourceRequest): string | undefined {
  const fileName = resolvePromptFileName(request);
  if (!fileName) return undefined;
  return join(PROMPTS_DIR, fileName);
}

// ────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────

/**
 * Retrieve a prompt resource by typed contract.
 *
 * Looks up the backing file from the static catalog, reads it, registers it
 * with typed metadata, and returns content plus attribution.
 *
 * @throws If no catalog entry exists for the request fields.
 * @throws If the backing file cannot be read.
 */
export async function resolvePromptResource(
  request: PromptResourceRequest,
): Promise<ResolvedResource> {
  const stability = request.stability ?? 'stable';

  if (stability !== 'stable') {
    throw new Error(
      `Stability channel "${stability}" is not yet supported. ` +
      `Only "stable" is available until HOK-1379 lands. ` +
      `Request: ${JSON.stringify({ stage: request.stage, role: request.role })}`,
    );
  }

  const fileName = resolvePromptFileName(request);
  if (!fileName) {
    const mode = request.operatingMode ?? 'normal';
    const persona = request.persona ? `, persona="${request.persona}"` : '';
    throw new Error(
      `No prompt catalog entry for stage="${request.stage}", role="${request.role}", ` +
      `mode="${mode}"${persona}. ` +
      `Check PROMPT_CATALOG in shared/lib/resource-retrieval.ts.`,
    );
  }

  const filePath = join(PROMPTS_DIR, fileName);
  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch (err) {
    throw new Error(
      `Failed to read prompt resource for stage="${request.stage}", role="${request.role}": ` +
      `${(err as Error).message} (path: ${filePath})`,
    );
  }

  const contractMetadata: PromptContractMetadata = {
    stage: request.stage,
    role: request.role,
    ...(request.operatingMode ? { operatingMode: request.operatingMode } : {}),
    ...(request.persona ? { persona: request.persona } : {}),
    stability,
  };

  const resourceRef = registerPromptTemplate(filePath, content, request.repoDir, contractMetadata);

  // Log to GEPA prompt-registry.jsonl for training attribution.
  // logPromptUsage internally calls registerPromptTemplate without contract metadata;
  // registerResource deduplicates by content hash and returns the existing record on
  // the second call, so the typed metadata written above is not overwritten.
  logPromptUsage(filePath, content);

  const metadata: Record<string, unknown> = {
    path: filePath,
    fileName,
    ...contractMetadata,
  };

  return {
    content,
    path: filePath,
    resourceRef,
    metadata,
    request,
    selectedStability: stability,
  };
}

/**
 * Retrieve a memory resource by typed contract.
 *
 * Returns null when the backing file does not exist (memory resources are
 * optional). Throws on unexpected read errors.
 */
export async function resolveMemoryResource(
  request: MemoryResourceRequest,
): Promise<ResolvedResource | null> {
  const stability = request.stability ?? 'stable';
  const repoRoot = resolve(request.repoDir);
  let filePath: string;

  switch (request.tier) {
    case 'hot':
      filePath = join(repoRoot, '.wavemill', 'project-context.md');
      break;
    case 'cold': {
      if (!request.subsystemId) {
        throw new Error('resolveMemoryResource: subsystemId is required for tier="cold"');
      }
      filePath = join(repoRoot, '.wavemill', 'context', `${request.subsystemId}.md`);
      break;
    }
    case 'concept': {
      if (!request.conceptId) {
        throw new Error('resolveMemoryResource: conceptId is required for tier="concept"');
      }
      filePath = join(repoRoot, '.wavemill', 'context', 'concepts', `${request.conceptId}.md`);
      break;
    }
  }

  if (!existsSync(filePath)) {
    return null;
  }

  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch (err) {
    throw new Error(
      `Failed to read memory resource tier="${request.tier}": ` +
      `${(err as Error).message} (path: ${filePath})`,
    );
  }

  const memoryMetadata: Record<string, unknown> = {
    tier: request.tier,
    path: filePath,
    stability,
    ...(request.subsystemId ? { subsystemId: request.subsystemId } : {}),
    ...(request.conceptId ? { conceptId: request.conceptId } : {}),
  };

  const resourceRef = toResourceRef(registerResource(
    {
      type: 'memory',
      name: buildMemoryResourceName(request),
      content,
      uri: filePath,
      metadata: memoryMetadata,
    },
    { repoDir: repoRoot },
  ));

  return {
    content,
    path: filePath,
    resourceRef,
    metadata: memoryMetadata,
    request,
    selectedStability: stability,
  };
}

/**
 * Retrieve a policy resource by typed contract.
 *
 * @throws If the backing file does not exist or cannot be read.
 */
export async function resolvePolicyResource(
  request: PolicyResourceRequest,
): Promise<ResolvedResource> {
  const stability = request.stability ?? 'stable';
  const repoRoot = resolve(request.repoDir);
  const relativePath = POLICY_CATALOG[request.name];
  const filePath = join(repoRoot, relativePath);

  if (!existsSync(filePath)) {
    throw new Error(
      `Policy resource "${request.name}" not found at: ${filePath}`,
    );
  }

  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch (err) {
    throw new Error(
      `Failed to read policy resource "${request.name}": ` +
      `${(err as Error).message} (path: ${filePath})`,
    );
  }

  const policyMetadata: Record<string, unknown> = {
    policyName: request.name,
    path: filePath,
    stability,
  };

  const resourceRef = toResourceRef(registerResource(
    {
      type: 'agent-config',
      name: `policy:${request.name}`,
      content,
      uri: filePath,
      metadata: policyMetadata,
    },
    { repoDir: repoRoot },
  ));

  return {
    content,
    path: filePath,
    resourceRef,
    metadata: policyMetadata,
    request,
    selectedStability: stability,
  };
}

/**
 * Unified dispatcher — resolve any resource by typed contract.
 */
export async function resolveResource(request: ResourceRequest): Promise<ResolvedResource | null> {
  switch (request.class) {
    case 'prompt':
      return resolvePromptResource(request);
    case 'memory':
      return resolveMemoryResource(request);
    case 'policy':
      return resolvePolicyResource(request);
  }
}

// ────────────────────────────────────────────────────────────────
// Internal utils
// ────────────────────────────────────────────────────────────────

function buildMemoryResourceName(request: MemoryResourceRequest): string {
  switch (request.tier) {
    case 'hot':
      return '.wavemill__project-context';
    case 'cold':
      return `.wavemill__context__${request.subsystemId}`;
    case 'concept':
      return `.wavemill__context__concepts__${request.conceptId}`;
  }
}
