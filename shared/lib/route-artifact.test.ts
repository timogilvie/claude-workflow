import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildRouteProvenance } from './route-artifact.ts';

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
