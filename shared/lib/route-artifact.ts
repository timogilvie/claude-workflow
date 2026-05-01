import { createHash } from 'node:crypto';
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

export interface NormalizedExpandedRouteArtifact {
  coder: string;
  codeDepth: string;
  reviewer: string;
  reviewMode: string;
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
