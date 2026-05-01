import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { WorkflowRouteDecision } from './workflow-router.ts';

export type RouteSource =
  | 'bootstrap'
  | 'expanded'
  | 'startup-cache'
  | 'batch-cache'
  | 'live'
  | 'heuristic-fallback';

export type RouteInputKind = 'issue' | 'task-packet' | 'cache' | 'heuristic';

export interface RouteProvenance {
  source: RouteSource;
  inputKind: RouteInputKind;
  inputPath: string;
  inputHash: string;
  routedAt: string;
  routerMode: 'normal' | 'constrained' | 'survival';
}

export interface RouteDecisionWithProvenance extends WorkflowRouteDecision {
  provenance?: RouteProvenance;
}

export interface BuildRouteProvenanceParams {
  source: RouteSource;
  inputKind: RouteInputKind;
  inputPath?: string;
  inputBytes?: string | Buffer;
  routerMode: 'normal' | 'constrained' | 'survival';
  routedAt?: string;
}

export function buildRouteProvenance(params: BuildRouteProvenanceParams): RouteProvenance {
  const hasInputBytes = typeof params.inputBytes !== 'undefined';
  const isHeuristicFallbackWithoutInput = params.source === 'heuristic-fallback' && !hasInputBytes;
  const bytes = hasInputBytes
    ? (Buffer.isBuffer(params.inputBytes) ? params.inputBytes : Buffer.from(params.inputBytes, 'utf-8'))
    : null;

  return {
    source: params.source,
    inputKind: isHeuristicFallbackWithoutInput ? 'heuristic' : params.inputKind,
    inputPath: isHeuristicFallbackWithoutInput ? '' : (params.inputPath || ''),
    inputHash: bytes ? createHash('sha256').update(bytes).digest('hex') : '',
    routedAt: params.routedAt || new Date().toISOString(),
    routerMode: params.routerMode,
  };
}

export function withRouteProvenance<T extends WorkflowRouteDecision>(decision: T, provenance: RouteProvenance): T & {
  provenance: RouteProvenance;
} {
  return {
    ...decision,
    provenance,
  };
}

export function stringifyRouteArtifact(value: unknown): string {
  const serialized = JSON.stringify(value, null, 2);
  if (typeof serialized !== 'string') {
    throw new TypeError('Route artifact must serialize to a JSON document');
  }

  JSON.parse(serialized);
  return `${serialized}\n`;
}

export function writeRouteArtifact(path: string, value: unknown): void {
  const tmpPath = join(dirname(path), `.tmp-route-artifact-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  try {
    writeFileSync(tmpPath, stringifyRouteArtifact(value), 'utf-8');
    renameSync(tmpPath, path);
  } catch (error) {
    rmSync(tmpPath, { force: true });
    throw error;
  }
}

export interface NormalizedExpandedRouteArtifact {
  coder: string;
  codeDepth: string;
  reviewer: string;
  reviewMode: string;
}

export interface RouteArtifactSnapshot extends NormalizedExpandedRouteArtifact {
  planDepth?: string;
  planner?: string;
}

export type ExpandedRouteValidation = {
  valid: boolean;
  missing: string[];
  invalid: string[];
  normalized?: NormalizedExpandedRouteArtifact;
};

export function validateExpandedRouteArtifact(value: unknown): ExpandedRouteValidation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      valid: false,
      missing: [],
      invalid: ['artifact'],
    };
  }

  const artifact = value as Record<string, unknown>;
  const missing: string[] = [];
  const invalid: string[] = [];

  const readStringField = (field: 'coder' | 'codeDepth' | 'reviewer'): string | undefined => {
    const raw = artifact[field];
    if (typeof raw === 'undefined') {
      missing.push(field);
      return undefined;
    }
    if (typeof raw !== 'string' || raw.trim() === '') {
      invalid.push(field);
      return undefined;
    }
    return raw;
  };

  const coder = readStringField('coder');
  const codeDepth = readStringField('codeDepth');
  const reviewer = readStringField('reviewer');

  const reviewModeCandidate = artifact.reviewMode ?? artifact.reviewRecommended;
  let reviewMode: string | undefined;
  if (typeof reviewModeCandidate === 'undefined') {
    missing.push('reviewMode');
  } else if (typeof reviewModeCandidate !== 'string' || reviewModeCandidate.trim() === '') {
    invalid.push('reviewMode');
  } else {
    reviewMode = reviewModeCandidate;
  }

  if (missing.length > 0 || invalid.length > 0 || !coder || !codeDepth || !reviewer || !reviewMode) {
    return {
      valid: false,
      missing,
      invalid,
    };
  }

  return {
    valid: true,
    missing: [],
    invalid: [],
    normalized: {
      coder,
      codeDepth,
      reviewer,
      reviewMode,
    },
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function parseBootstrapRouteArtifact(value: unknown): RouteArtifactSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const artifact = value as Record<string, unknown>;
  const coder = readString(artifact.coder);
  const codeDepth = readString(artifact.codeDepth);
  const reviewer = readString(artifact.reviewer);
  const reviewMode = readString(artifact.reviewMode ?? artifact.reviewRecommended);

  if (!coder || !codeDepth || !reviewer || !reviewMode) {
    return null;
  }

  return {
    coder,
    codeDepth,
    reviewer,
    reviewMode,
    planDepth: readString(artifact.planDepth),
    planner: readString(artifact.planner),
  };
}

function loadJson(filePath: string): unknown | null {
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

export function readBothRouteArtifacts(featureDir: string): {
  bootstrap: RouteArtifactSnapshot | null;
  expanded: RouteArtifactSnapshot | null;
} {
  const bootstrapRaw = loadJson(join(featureDir, '.initial-route.json'));
  const expandedRaw = loadJson(join(featureDir, '.post-expansion-route.json'));

  const bootstrap = parseBootstrapRouteArtifact(bootstrapRaw);

  let expanded: RouteArtifactSnapshot | null = null;
  if (expandedRaw !== null) {
    const validation = validateExpandedRouteArtifact(expandedRaw);
    if (validation.valid && validation.normalized) {
      const artifact = expandedRaw as Record<string, unknown>;
      expanded = {
        ...validation.normalized,
        planDepth: readString(artifact.planDepth),
        planner: readString(artifact.planner),
      };
    }
  }

  return {
    bootstrap,
    expanded,
  };
}
