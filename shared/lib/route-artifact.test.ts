import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { clearConfigCache } from './config.ts';
import {
  buildRouteLifecycleProvenance,
  deriveRouteDecisionSource,
  formatRouteArtifactSignature,
  buildRouteProvenance,
  hasValidPostExpansionRoute,
  readBothRouteArtifacts,
  readRouteLifecycleArtifacts,
  resolveRouteDecisionBudget,
  routeChangedMaterially,
  stringifyRouteArtifact,
  validateExpandedRouteArtifact,
  withResolvedRouteBudget,
  writeRouteArtifact,
} from './route-artifact.ts';
import type { WorkflowRouteDecision } from './workflow-router.ts';

function minimalDecision(overrides: Partial<WorkflowRouteDecision> = {}): WorkflowRouteDecision {
  return {
    planner: 'claude-sonnet-4-6',
    coder: 'gpt-5.4',
    reviewer: 'claude-sonnet-4-6',
    planDepth: 'light',
    codeDepth: 'medium',
    reviewRecommended: 'static',
    expectedSuccess: 0.8,
    expectedCostPlan: 0.1,
    expectedCostCode: 0.2,
    expectedCostReview: 0.1,
    confidence: 0.7,
    reasoning: [],
    signals: {
      taskType: 'feature',
      promptLength: 'medium',
      complexityScore: 0.5,
      fileTypes: [],
      riskScore: 0.2,
    },
    ...overrides,
  };
}

test('same input bytes produce same sha256', () => {
  const a = buildRouteProvenance({
    source: 'expanded',
    inputKind: 'task-packet',
    inputPath: 'features/a/task-packet.md',
    inputBytes: 'same bytes',
    routerMode: 'normal',
    routedAt: '2026-04-30T00:00:00.000Z',
  });
  const b = buildRouteProvenance({
    source: 'expanded',
    inputKind: 'task-packet',
    inputPath: 'features/a/task-packet.md',
    inputBytes: 'same bytes',
    routerMode: 'normal',
    routedAt: '2026-04-30T00:00:00.000Z',
  });
  assert.equal(a.inputHash, b.inputHash);
});

test('changed input bytes produce different hash', () => {
  const a = buildRouteProvenance({
    source: 'expanded',
    inputKind: 'task-packet',
    inputBytes: 'a',
    routerMode: 'normal',
  });
  const b = buildRouteProvenance({
    source: 'expanded',
    inputKind: 'task-packet',
    inputBytes: 'b',
    routerMode: 'normal',
  });
  assert.notEqual(a.inputHash, b.inputHash);
});

test('sha256 of hello matches known digest', () => {
  const item = buildRouteProvenance({
    source: 'live',
    inputKind: 'issue',
    inputBytes: 'hello',
    routerMode: 'normal',
  });
  assert.equal(item.inputHash, '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
});

test('routedAt is iso-8601 utc by default', () => {
  const item = buildRouteProvenance({
    source: 'live',
    inputKind: 'issue',
    inputBytes: 'hello',
    routerMode: 'normal',
  });
  assert.match(item.routedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test('heuristic fallback convention uses empty hash/path without input', () => {
  const item = buildRouteProvenance({
    source: 'heuristic-fallback',
    inputKind: 'issue',
    inputPath: '/tmp/input.txt',
    routerMode: 'survival',
  });
  assert.equal(item.inputKind, 'heuristic');
  assert.equal(item.inputPath, '');
  assert.equal(item.inputHash, '');
});

test('validateExpandedRouteArtifact accepts execution fields', () => {
  const result = validateExpandedRouteArtifact({
    coder: 'gpt-5.4',
    codeDepth: 'deep',
    reviewer: 'claude-sonnet-4-6',
    reviewMode: 'static+llm',
    cache_hit: true,
    route_source: 'batch',
    packet_hash: 'a'.repeat(64),
    extra: true,
  });

  assert.equal(result.valid, true);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.invalid, []);
  assert.deepEqual(result.normalized, {
    coder: 'gpt-5.4',
    codeDepth: 'deep',
    reviewer: 'claude-sonnet-4-6',
    reviewMode: 'static+llm',
  });
});

test('validateExpandedRouteArtifact falls back from reviewRecommended', () => {
  const result = validateExpandedRouteArtifact({
    coder: 'gpt-5.4',
    codeDepth: 'medium',
    reviewer: 'claude-sonnet-4-6',
    reviewRecommended: 'llm',
  });

  assert.equal(result.valid, true);
  assert.equal(result.normalized?.reviewMode, 'llm');
});

test('validateExpandedRouteArtifact reports missing required fields', () => {
  const result = validateExpandedRouteArtifact({
    coder: 'gpt-5.4',
  });

  assert.equal(result.valid, false);
  assert.deepEqual(result.missing.sort(), ['codeDepth', 'reviewMode', 'reviewer']);
  assert.deepEqual(result.invalid, []);
});

test('validateExpandedRouteArtifact rejects non-object values', () => {
  const result = validateExpandedRouteArtifact(null);

  assert.equal(result.valid, false);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.invalid, ['artifact']);
});

test('validateExpandedRouteArtifact rejects blank execution fields', () => {
  const result = validateExpandedRouteArtifact({
    coder: '',
    codeDepth: 'medium',
    reviewer: 'claude-sonnet-4-6',
    reviewMode: 'static',
  });

  assert.equal(result.valid, false);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.invalid, ['coder']);
});

test('validateExpandedRouteArtifact rejects malformed optional metadata', () => {
  const result = validateExpandedRouteArtifact({
    coder: 'gpt-5.4',
    codeDepth: 'deep',
    reviewer: 'claude-sonnet-4-6',
    reviewMode: 'static+llm',
    cache_hit: 'yes',
    route_source: 'live',
    packet_hash: 'abc123',
  });

  assert.equal(result.valid, false);
  assert.deepEqual(result.invalid.sort(), ['cache_hit', 'packet_hash', 'route_source']);
});

test('stringifyRouteArtifact returns strict JSON with trailing newline', () => {
  const output = stringifyRouteArtifact({ coder: 'gpt-5.4', nested: { ok: true } });

  assert.match(output, /^\{/);
  assert.match(output, /\n$/);
  assert.doesNotThrow(() => JSON.parse(output));
});

test('writeRouteArtifact writes strict JSON bytes parseable as-is', () => {
  const dir = mkdtempSync(join(tmpdir(), 'route-artifact-'));
  try {
    const target = join(dir, '.routing-complete');
    writeRouteArtifact(target, { coder: 'gpt-5.4', reviewMode: 'llm' });

    const written = readFileSync(target, 'utf-8');
    assert.equal(written.trimStart().startsWith('{'), true);
    assert.doesNotThrow(() => JSON.parse(written));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeRouteArtifact rejects non-serializable top-level payloads', () => {
  assert.throws(() => writeRouteArtifact(join(tmpdir(), 'unused.json'), undefined), /serialize to a JSON document/);
});

test('resolveRouteDecisionBudget preserves explicit zero over defaults', () => {
  const dir = mkdtempSync(join(tmpdir(), 'route-artifact-budget-'));
  try {
    writeFileSync(join(dir, '.wavemill-config.json'), JSON.stringify({
      mill: { defaultMaxCostUsd: 25 },
    }));
    clearConfigCache(dir);
    assert.equal(
      resolveRouteDecisionBudget(minimalDecision({ constraints: { maxCostUsd: 4 } }), {
        explicitMaxCostUsd: 0,
        repoDir: dir,
      }),
      0,
    );
  } finally {
    clearConfigCache(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('withResolvedRouteBudget writes constraints and top-level budget from config default', () => {
  const dir = mkdtempSync(join(tmpdir(), 'route-artifact-budget-'));
  try {
    writeFileSync(join(dir, '.wavemill-config.json'), JSON.stringify({
      mill: { defaultMaxCostUsd: 12.5 },
    }));
    clearConfigCache(dir);

    const decision = withResolvedRouteBudget(minimalDecision(), { repoDir: dir });

    assert.equal(decision.maxCostUsd, 12.5);
    assert.equal(decision.constraints?.maxCostUsd, 12.5);
  } finally {
    clearConfigCache(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('withResolvedRouteBudget writes top-level null when no budget is available', () => {
  const dir = mkdtempSync(join(tmpdir(), 'route-artifact-budget-'));
  try {
    writeFileSync(join(dir, '.wavemill-config.json'), JSON.stringify({ router: { enabled: false } }));
    clearConfigCache(dir);

    const decision = withResolvedRouteBudget(minimalDecision(), { repoDir: dir });

    assert.equal(decision.maxCostUsd, null);
    assert.equal(decision.constraints, undefined);
  } finally {
    clearConfigCache(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeFeatureDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'route-artifact-'));
  const featureDir = join(root, 'features', 'demo');
  mkdirSync(featureDir, { recursive: true });
  return featureDir;
}

test('readBothRouteArtifacts returns both snapshots when present', () => {
  const featureDir = makeFeatureDir();
  const bootstrapPath = join(featureDir, '.initial-route.json');
  const expandedPath = join(featureDir, '.post-expansion-route.json');
  writeFileSync(bootstrapPath, JSON.stringify({
    planner: 'gpt-5.4',
    coder: 'claude-sonnet-4-6',
    reviewer: 'claude-opus-4-6',
    planDepth: 'deep',
    codeDepth: 'medium',
    reviewMode: 'llm',
  }));
  writeFileSync(expandedPath, JSON.stringify({
    coder: 'gpt-5.4',
    reviewer: 'claude-sonnet-4-5-20250929',
    codeDepth: 'deep',
    reviewMode: 'static+llm',
  }));

  const result = readBothRouteArtifacts(featureDir);
  assert.equal(result.bootstrap?.planner, 'gpt-5.4');
  assert.equal(result.bootstrap?.coder, 'claude-sonnet-4-6');
  assert.equal(result.bootstrap?.reviewer, 'claude-opus-4-6');
  assert.equal(result.bootstrap?.planDepth, 'deep');
  assert.equal(result.bootstrap?.codeDepth, 'medium');
  assert.equal(result.bootstrap?.reviewMode, 'llm');
  assert.equal(result.bootstrap?.cache_hit, undefined);
  assert.equal(result.bootstrap?.route_source, undefined);
  assert.equal(result.bootstrap?.packet_hash, undefined);
  assert.equal(result.bootstrap?.artifactPath, bootstrapPath);
  assert.match(result.bootstrap?.artifactHash || '', /^[0-9a-f]{64}$/);

  assert.equal(result.expanded?.coder, 'gpt-5.4');
  assert.equal(result.expanded?.reviewer, 'claude-sonnet-4-5-20250929');
  assert.equal(result.expanded?.codeDepth, 'deep');
  assert.equal(result.expanded?.reviewMode, 'static+llm');
  assert.equal(result.expanded?.planner, undefined);
  assert.equal(result.expanded?.planDepth, undefined);
  assert.equal(result.expanded?.cache_hit, undefined);
  assert.equal(result.expanded?.artifactPath, expandedPath);
  assert.match(result.expanded?.artifactHash || '', /^[0-9a-f]{64}$/);
});

test('readBothRouteArtifacts exposes expanded route as authoritative when snapshots conflict', () => {
  const featureDir = makeFeatureDir();
  writeFileSync(join(featureDir, '.initial-route.json'), JSON.stringify({
    coder: 'bootstrap-coder',
    reviewer: 'bootstrap-reviewer',
    codeDepth: 'shallow',
    reviewMode: 'static',
  }));
  writeFileSync(join(featureDir, '.post-expansion-route.json'), JSON.stringify({
    coder: 'expanded-coder',
    reviewer: 'expanded-reviewer',
    codeDepth: 'deep',
    reviewMode: 'static+llm',
  }));

  const result = readBothRouteArtifacts(featureDir);
  assert.equal(result.bootstrap?.coder, 'bootstrap-coder');
  assert.equal(result.bootstrap?.codeDepth, 'shallow');
  assert.equal(result.expanded?.coder, 'expanded-coder');
  assert.equal(result.expanded?.codeDepth, 'deep');
  assert.notEqual(result.bootstrap?.coder, result.expanded?.coder);
});

test('readBothRouteArtifacts returns null for missing sides independently', () => {
  const featureDir = makeFeatureDir();
  writeFileSync(join(featureDir, '.initial-route.json'), JSON.stringify({
    coder: 'claude-sonnet-4-6',
    reviewer: 'claude-opus-4-6',
    codeDepth: 'medium',
    reviewMode: 'llm',
  }));

  const result = readBothRouteArtifacts(featureDir);
  assert.equal(result.bootstrap?.coder, 'claude-sonnet-4-6');
  assert.equal(result.expanded, null);
});

test('readBothRouteArtifacts normalizes expanded reviewRecommended to reviewMode', () => {
  const featureDir = makeFeatureDir();
  writeFileSync(join(featureDir, '.post-expansion-route.json'), JSON.stringify({
    coder: 'gpt-5.4',
    reviewer: 'claude-sonnet-4-6',
    codeDepth: 'deep',
    reviewRecommended: 'static+llm',
  }));

  const result = readBothRouteArtifacts(featureDir);
  assert.equal(result.expanded?.reviewMode, 'static+llm');
});

test('readBothRouteArtifacts reads expanded-only artifacts', () => {
  const featureDir = makeFeatureDir();
  const expandedPath = join(featureDir, '.post-expansion-route.json');
  writeFileSync(expandedPath, JSON.stringify({
    coder: 'gpt-5.4',
    reviewer: 'claude-opus-4-6',
    codeDepth: 'deep',
    reviewRecommended: 'static',
    cache_hit: true,
    route_source: 'cache',
    packet_hash: 'a'.repeat(64),
  }));

  const result = readBothRouteArtifacts(featureDir);
  assert.equal(result.bootstrap, null);
  assert.equal(result.expanded?.coder, 'gpt-5.4');
  assert.equal(result.expanded?.reviewer, 'claude-opus-4-6');
  assert.equal(result.expanded?.codeDepth, 'deep');
  assert.equal(result.expanded?.reviewMode, 'static');
  assert.equal(result.expanded?.cache_hit, true);
  assert.equal(result.expanded?.route_source, 'cache');
  assert.equal(result.expanded?.packet_hash, 'a'.repeat(64));
  assert.equal(result.expanded?.planner, undefined);
  assert.equal(result.expanded?.planDepth, undefined);
  assert.equal(result.expanded?.artifactPath, expandedPath);
  assert.match(result.expanded?.artifactHash || '', /^[0-9a-f]{64}$/);
});

test('readBothRouteArtifacts returns null for malformed artifacts without throwing', () => {
  const featureDir = makeFeatureDir();
  writeFileSync(join(featureDir, '.initial-route.json'), '{');
  writeFileSync(join(featureDir, '.post-expansion-route.json'), JSON.stringify({
    coder: '',
    reviewer: 'claude-opus-4-6',
    codeDepth: 'deep',
    reviewMode: 'static',
  }));

  const result = readBothRouteArtifacts(featureDir);
  assert.equal(result.bootstrap, null);
  assert.equal(result.expanded, null);
});

test('readBothRouteArtifacts ignores malformed expanded snapshot while keeping bootstrap snapshot', () => {
  const featureDir = makeFeatureDir();
  writeFileSync(join(featureDir, '.initial-route.json'), JSON.stringify({
    coder: 'bootstrap-coder',
    reviewer: 'bootstrap-reviewer',
    codeDepth: 'medium',
    reviewMode: 'static',
  }));
  writeFileSync(join(featureDir, '.post-expansion-route.json'), '{');

  const result = readBothRouteArtifacts(featureDir);
  assert.equal(result.bootstrap?.coder, 'bootstrap-coder');
  assert.equal(result.expanded, null);
});

test('readBothRouteArtifacts keeps normalized expanded fields and surfaces provenance metadata', () => {
  const featureDir = makeFeatureDir();
  const expandedPath = join(featureDir, '.post-expansion-route.json');
  writeFileSync(expandedPath, JSON.stringify({
    planner: 'expanded-planner',
    coder: 'gpt-5.4',
    reviewer: 'claude-sonnet-4-6',
    planDepth: 'deep',
    codeDepth: 'deep',
    reviewMode: 'static+llm',
    cache_hit: true,
    route_source: 'batch',
    packet_hash: 'b'.repeat(64),
    expectedSuccess: 0.82,
    confidence: 0.7,
    expectedCostPlan: 0.1,
    expectedCostCode: 0.4,
    expectedCostReview: 0.05,
    provenance: {
      source: 'expanded',
      inputHash: 'ignored-in-snapshot',
      routerMode: 'normal',
    },
  }));

  const result = readBothRouteArtifacts(featureDir);
  assert.equal(result.expanded?.planner, 'expanded-planner');
  assert.equal(result.expanded?.coder, 'gpt-5.4');
  assert.equal(result.expanded?.reviewer, 'claude-sonnet-4-6');
  assert.equal(result.expanded?.planDepth, 'deep');
  assert.equal(result.expanded?.codeDepth, 'deep');
  assert.equal(result.expanded?.reviewMode, 'static+llm');
  assert.equal(result.expanded?.cache_hit, true);
  assert.equal(result.expanded?.route_source, 'batch');
  assert.equal(result.expanded?.packet_hash, 'b'.repeat(64));
  assert.equal(result.expanded?.routerMode, 'normal');
  assert.equal(result.expanded?.artifactSource, 'expanded');
  assert.equal(result.expanded?.expectedSuccess, 0.82);
  assert.equal(result.expanded?.confidence, 0.7);
  assert.equal(result.expanded?.expectedCostPlan, 0.1);
  assert.equal(result.expanded?.expectedCostCode, 0.4);
  assert.equal(result.expanded?.expectedCostReview, 0.05);
  assert.equal(result.expanded?.artifactPath, expandedPath);
  assert.match(result.expanded?.artifactHash || '', /^[0-9a-f]{64}$/);
  // Nested provenance object remains internal — we surface fields, not the raw map.
  assert.equal('provenance' in (result.expanded as object), false);
});

test('formatRouteArtifactSignature renders compact operator-facing route ids', () => {
  assert.equal(
    formatRouteArtifactSignature({
      coder: 'gpt-5.4',
      codeDepth: 'deep',
      reviewer: 'claude-sonnet-4-6',
      reviewMode: 'static+llm',
    }),
    'coder=gpt-5.4,codeDepth=deep,reviewer=claude-sonnet-4-6,reviewMode=static+llm',
  );
});

test('routeChangedMaterially tracks coder/reviewer class and depth changes', () => {
  const result = routeChangedMaterially(
    {
      coder: 'claude-sonnet-4-6',
      codeDepth: 'medium',
      reviewer: 'claude-opus-4-6',
      reviewMode: 'llm',
    },
    {
      coder: 'gpt-5.4',
      codeDepth: 'deep',
      reviewer: 'claude-sonnet-4-6',
      reviewMode: 'llm',
    },
  );

  assert.equal(result.changed, true);
  assert.deepEqual(result.reasons.sort(), ['code_depth', 'coder_class', 'reviewer_class']);
});

test('readRouteLifecycleArtifacts falls back to archived bootstrap and active route files', () => {
  const featureDir = makeFeatureDir();
  const archiveDir = join(dirname(featureDir), 'archive');
  mkdirSync(archiveDir, { recursive: true });

  writeFileSync(join(archiveDir, 'initial-route.json'), JSON.stringify({
    coder: 'bootstrap-coder',
    reviewer: 'bootstrap-reviewer',
    codeDepth: 'medium',
    reviewMode: 'static',
  }));
  writeFileSync(join(archiveDir, 'routing-complete.json'), JSON.stringify({
    coder: 'active-coder',
    reviewer: 'active-reviewer',
    codeDepth: 'deep',
    reviewMode: 'llm',
  }));
  writeFileSync(join(archiveDir, 'post-expansion-route.json'), JSON.stringify({
    coder: 'expanded-coder',
    reviewer: 'expanded-reviewer',
    codeDepth: 'deep',
    reviewMode: 'llm',
    cache_hit: true,
    route_source: 'cache',
    packet_hash: 'c'.repeat(64),
  }));

  const result = readRouteLifecycleArtifacts(undefined, archiveDir);
  assert.equal(result.bootstrap?.coder, 'bootstrap-coder');
  assert.equal(result.expanded?.coder, 'expanded-coder');
  assert.equal(result.active?.coder, 'active-coder');
});

test('deriveRouteDecisionSource returns preserved when active route stays bootstrap', () => {
  const decisionSource = deriveRouteDecisionSource({
    bootstrap: {
      coder: 'claude-sonnet-4-6',
      codeDepth: 'medium',
      reviewer: 'claude-opus-4-6',
      reviewMode: 'llm',
    },
    expanded: {
      coder: 'gpt-5.4',
      codeDepth: 'deep',
      reviewer: 'claude-sonnet-4-6',
      reviewMode: 'static',
    },
    active: {
      coder: 'claude-sonnet-4-6',
      codeDepth: 'medium',
      reviewer: 'claude-opus-4-6',
      reviewMode: 'llm',
    },
  });

  assert.equal(decisionSource, 'preserved');
});

test('buildRouteLifecycleProvenance preserves planner/depth and route identity per route', () => {
  const provenance = buildRouteLifecycleProvenance({
    bootstrap: {
      planner: 'claude-opus-4-6',
      coder: 'claude-sonnet-4-6',
      codeDepth: 'medium',
      planDepth: 'shallow',
      reviewer: 'claude-opus-4-6',
      reviewMode: 'llm',
      artifactPath: '/repo/features/demo/.initial-route.json',
      artifactHash: 'a'.repeat(64),
      routerMode: 'normal',
      artifactSource: 'bootstrap',
      expectedSuccess: 0.78,
      confidence: 0.6,
      expectedCostPlan: 0.05,
      expectedCostCode: 0.2,
      expectedCostReview: 0.05,
    },
    expanded: {
      planner: 'claude-opus-4-6',
      coder: 'gpt-5.4',
      codeDepth: 'deep',
      planDepth: 'deep',
      reviewer: 'claude-sonnet-4-6',
      reviewMode: 'static',
      cache_hit: true,
      route_source: 'cache',
      packet_hash: 'd'.repeat(64),
      routerMode: 'normal',
      artifactSource: 'expanded',
      expectedSuccess: 0.84,
      confidence: 0.72,
      expectedCost: 0.6,
      expectedCostPlan: 0.1,
      expectedCostCode: 0.4,
      expectedCostReview: 0.1,
      artifactPath: '/repo/features/demo/.post-expansion-route.json',
      artifactHash: 'b'.repeat(64),
    },
    active: {
      coder: 'gpt-5.4',
      codeDepth: 'deep',
      reviewer: 'claude-sonnet-4-6',
      reviewMode: 'static',
      artifactPath: '/repo/features/demo/.routing-complete',
      artifactHash: 'c'.repeat(64),
    },
  });

  assert.equal(provenance?.decisionSource, 'expanded');
  assert.equal(provenance?.routeChanged, true);
  assert.equal(provenance?.expandedCacheHit, true);
  assert.equal(provenance?.packetHash, 'd'.repeat(64));
  assert.equal(provenance?.routeSource, 'cache');

  assert.deepEqual(provenance?.bootstrapRoute, {
    planner: 'claude-opus-4-6',
    coder: 'claude-sonnet-4-6',
    codeDepth: 'medium',
    planDepth: 'shallow',
    reviewer: 'claude-opus-4-6',
    reviewMode: 'llm',
    routerMode: 'normal',
    artifactSource: 'bootstrap',
    expectedSuccess: 0.78,
    confidence: 0.6,
    expectedCostPlan: 0.05,
    expectedCostCode: 0.2,
    expectedCostReview: 0.05,
    artifactPath: '/repo/features/demo/.initial-route.json',
    artifactHash: 'a'.repeat(64),
  });

  assert.deepEqual(provenance?.expandedRoute, {
    planner: 'claude-opus-4-6',
    coder: 'gpt-5.4',
    codeDepth: 'deep',
    planDepth: 'deep',
    reviewer: 'claude-sonnet-4-6',
    reviewMode: 'static',
    packetHash: 'd'.repeat(64),
    cacheHit: true,
    routeSource: 'cache',
    routerMode: 'normal',
    artifactSource: 'expanded',
    expectedSuccess: 0.84,
    confidence: 0.72,
    expectedCost: 0.6,
    expectedCostPlan: 0.1,
    expectedCostCode: 0.4,
    expectedCostReview: 0.1,
    artifactPath: '/repo/features/demo/.post-expansion-route.json',
    artifactHash: 'b'.repeat(64),
  });

  assert.deepEqual(provenance?.activeRoute, {
    coder: 'gpt-5.4',
    codeDepth: 'deep',
    reviewer: 'claude-sonnet-4-6',
    reviewMode: 'static',
    artifactPath: '/repo/features/demo/.routing-complete',
    artifactHash: 'c'.repeat(64),
  });
});

test('buildRouteLifecycleProvenance returns minimal view for legacy snapshots without optional fields', () => {
  const provenance = buildRouteLifecycleProvenance({
    bootstrap: {
      coder: 'claude-sonnet-4-6',
      codeDepth: 'medium',
      reviewer: 'claude-opus-4-6',
      reviewMode: 'llm',
    },
    expanded: null,
    active: null,
  });

  assert.deepEqual(provenance, {
    bootstrapRoute: {
      coder: 'claude-sonnet-4-6',
      codeDepth: 'medium',
      reviewer: 'claude-opus-4-6',
      reviewMode: 'llm',
    },
    activeRoute: {
      coder: 'claude-sonnet-4-6',
      codeDepth: 'medium',
      reviewer: 'claude-opus-4-6',
      reviewMode: 'llm',
    },
    routeChanged: false,
    decisionSource: 'bootstrap',
  });
});

test('buildRouteLifecycleProvenance returns null when no artifacts are present', () => {
  const provenance = buildRouteLifecycleProvenance({
    bootstrap: null,
    expanded: null,
    active: null,
  });

  assert.equal(provenance, null);
});

test('buildRouteLifecycleProvenance attaches when only bootstrap artifact exists', () => {
  const provenance = buildRouteLifecycleProvenance({
    bootstrap: {
      planner: 'gpt-5.5',
      coder: 'gpt-5.4',
      codeDepth: 'medium',
      reviewer: 'claude-sonnet-4-6',
      reviewMode: 'static',
      planDepth: 'light',
      routerMode: 'normal',
      artifactSource: 'bootstrap',
    },
    expanded: null,
    active: null,
  });

  assert.equal(provenance?.decisionSource, 'bootstrap');
  assert.equal(provenance?.bootstrapRoute?.planner, 'gpt-5.5');
  assert.equal(provenance?.bootstrapRoute?.planDepth, 'light');
  assert.equal(provenance?.bootstrapRoute?.routerMode, 'normal');
  assert.equal(provenance?.expandedRoute, undefined);
  assert.equal(provenance?.activeRoute?.coder, 'gpt-5.4');
});

test('readRouteLifecycleArtifacts surfaces artifactPath and artifactHash for archived files', () => {
  const featureDir = makeFeatureDir();
  const archiveDir = join(dirname(featureDir), 'archive2');
  mkdirSync(archiveDir, { recursive: true });

  const archivedBootstrap = join(archiveDir, 'initial-route.json');
  const archivedExpanded = join(archiveDir, 'post-expansion-route.json');
  writeFileSync(archivedBootstrap, JSON.stringify({
    planner: 'archived-planner',
    coder: 'archived-coder',
    reviewer: 'archived-reviewer',
    codeDepth: 'medium',
    reviewMode: 'static',
    planDepth: 'shallow',
    provenance: { source: 'bootstrap', routerMode: 'constrained' },
  }));
  writeFileSync(archivedExpanded, JSON.stringify({
    planner: 'archived-expanded',
    coder: 'archived-coder',
    reviewer: 'archived-reviewer',
    codeDepth: 'deep',
    reviewMode: 'llm',
    cache_hit: false,
    route_source: 'single',
    packet_hash: 'e'.repeat(64),
  }));

  const result = readRouteLifecycleArtifacts(undefined, archiveDir);
  assert.equal(result.bootstrap?.planner, 'archived-planner');
  assert.equal(result.bootstrap?.planDepth, 'shallow');
  assert.equal(result.bootstrap?.routerMode, 'constrained');
  assert.equal(result.bootstrap?.artifactSource, 'bootstrap');
  assert.equal(result.bootstrap?.artifactPath, archivedBootstrap);
  assert.match(result.bootstrap?.artifactHash || '', /^[0-9a-f]{64}$/);

  assert.equal(result.expanded?.cache_hit, false);
  assert.equal(result.expanded?.route_source, 'single');
  assert.equal(result.expanded?.packet_hash, 'e'.repeat(64));
  assert.equal(result.expanded?.artifactPath, archivedExpanded);
  assert.match(result.expanded?.artifactHash || '', /^[0-9a-f]{64}$/);
});

test('hasValidPostExpansionRoute returns missing when file is absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'route-artifact-'));
  try {
    assert.deepEqual(hasValidPostExpansionRoute(dir), { ok: false, reason: 'missing' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hasValidPostExpansionRoute returns invalid-json for malformed file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'route-artifact-'));
  try {
    writeFileSync(join(dir, '.post-expansion-route.json'), '{');
    assert.deepEqual(hasValidPostExpansionRoute(dir), { ok: false, reason: 'invalid-json' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hasValidPostExpansionRoute reports missing required fields', () => {
  const dir = mkdtempSync(join(tmpdir(), 'route-artifact-'));
  try {
    writeFileSync(join(dir, '.post-expansion-route.json'), JSON.stringify({ reviewer: 'claude' }));
    const result = hasValidPostExpansionRoute(dir);
    assert.equal(result.ok, false);
    assert.match(result.reason || '', /^missing-required-field:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hasValidPostExpansionRoute returns ok for valid artifact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'route-artifact-'));
  try {
    writeFileSync(join(dir, '.post-expansion-route.json'), JSON.stringify({
      coder: 'gpt-5.4',
      codeDepth: 'medium',
      reviewer: 'claude-sonnet-4-6',
      reviewMode: 'llm',
    }));
    assert.deepEqual(hasValidPostExpansionRoute(dir), { ok: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
