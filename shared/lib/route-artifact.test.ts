import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import {
  buildRouteProvenance,
  readBothRouteArtifacts,
  stringifyRouteArtifact,
  validateExpandedRouteArtifact,
  writeRouteArtifact,
} from './route-artifact.ts';

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

function makeFeatureDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'route-artifact-'));
  const featureDir = join(root, 'features', 'demo');
  mkdirSync(featureDir, { recursive: true });
  return featureDir;
}

test('readBothRouteArtifacts returns both snapshots when present', () => {
  const featureDir = makeFeatureDir();
  writeFileSync(join(featureDir, '.initial-route.json'), JSON.stringify({
    planner: 'gpt-5.4',
    coder: 'claude-sonnet-4-6',
    reviewer: 'claude-opus-4-6',
    planDepth: 'deep',
    codeDepth: 'medium',
    reviewMode: 'llm',
  }));
  writeFileSync(join(featureDir, '.post-expansion-route.json'), JSON.stringify({
    coder: 'gpt-5.4',
    reviewer: 'claude-sonnet-4-5-20250929',
    codeDepth: 'deep',
    reviewMode: 'static+llm',
  }));

  const result = readBothRouteArtifacts(featureDir);
  assert.deepEqual(result.bootstrap, {
    planner: 'gpt-5.4',
    coder: 'claude-sonnet-4-6',
    reviewer: 'claude-opus-4-6',
    planDepth: 'deep',
    codeDepth: 'medium',
    reviewMode: 'llm',
    cache_hit: undefined,
    route_source: undefined,
    packet_hash: undefined,
  });
  assert.deepEqual(result.expanded, {
    coder: 'gpt-5.4',
    reviewer: 'claude-sonnet-4-5-20250929',
    codeDepth: 'deep',
    reviewMode: 'static+llm',
    planDepth: undefined,
    planner: undefined,
    cache_hit: undefined,
    route_source: undefined,
    packet_hash: undefined,
  });
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

test('readBothRouteArtifacts reads expanded-only artifacts', () => {
  const featureDir = makeFeatureDir();
  writeFileSync(join(featureDir, '.post-expansion-route.json'), JSON.stringify({
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
  assert.deepEqual(result.expanded, {
    coder: 'gpt-5.4',
    reviewer: 'claude-opus-4-6',
    codeDepth: 'deep',
    reviewMode: 'static',
    planDepth: undefined,
    planner: undefined,
    cache_hit: true,
    route_source: 'cache',
    packet_hash: 'a'.repeat(64),
  });
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
