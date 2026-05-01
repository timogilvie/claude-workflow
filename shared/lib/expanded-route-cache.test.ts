import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  EXPANDED_ROUTE_CACHE_INPUT_VERSION,
  getExpandedRouteCachePath,
  lookupExpandedRouteCache,
  readExpandedPacketContent,
  recordExpandedRouteCache,
} from './expanded-route-cache.ts';

function makeRepo(): string {
  const repoDir = mkdtempSync(path.join(os.tmpdir(), 'expanded-route-cache-'));
  mkdirSync(path.join(repoDir, '.wavemill', 'state'), { recursive: true });
  return repoDir;
}

test('deterministic hash for identical full packet bytes', () => {
  const repoDir = makeRepo();
  const packetFile = path.join(repoDir, 'task-packet.md');
  writeFileSync(packetFile, 'same packet\n');

  const a = readExpandedPacketContent({ packetFile });
  const b = readExpandedPacketContent({ packetFile });
  assert.equal(a.hash, b.hash);

  rmSync(repoDir, { recursive: true, force: true });
});

test('split packet hash changes for content and version changes', () => {
  const repoDir = makeRepo();
  const headerFile = path.join(repoDir, 'task-packet-header.md');
  const detailsFile = path.join(repoDir, 'task-packet-details.md');
  writeFileSync(headerFile, 'header\n');
  writeFileSync(detailsFile, 'details\n');

  const base = readExpandedPacketContent({ headerFile, detailsFile });
  writeFileSync(detailsFile, 'details changed\n');
  const changed = readExpandedPacketContent({ headerFile, detailsFile });
  const differentVersion = readExpandedPacketContent({ headerFile, detailsFile }, `${EXPANDED_ROUTE_CACHE_INPUT_VERSION}-next`);

  assert.notEqual(base.hash, changed.hash);
  assert.notEqual(changed.hash, differentVersion.hash);

  rmSync(repoDir, { recursive: true, force: true });
});

test('cache hit requires operating mode match', async () => {
  const repoDir = makeRepo();
  await recordExpandedRouteCache(repoDir, {
    packet_hash: 'a'.repeat(64),
    decision: {
      planner: 'gpt-5.5',
      coder: 'gpt-5.4',
      reviewer: 'claude-sonnet-4-6',
      planDepth: 'deep',
      codeDepth: 'deep',
      reviewRecommended: 'static+llm',
      expectedSuccess: 0.9,
      expectedCostPlan: 1,
      expectedCostCode: 2,
      expectedCostReview: 1,
      confidence: 0.8,
      reasoning: ['test'],
      signals: {
        taskType: 'feature',
        promptLength: 'medium',
        complexityScore: 3,
        fileTypes: ['ts'],
        riskScore: 3,
      },
    },
    operating_mode: 'normal',
    recorded_at: '2026-05-01T00:00:00.000Z',
    input_version: EXPANDED_ROUTE_CACHE_INPUT_VERSION,
  });

  assert.ok(lookupExpandedRouteCache(repoDir, 'a'.repeat(64), 'normal'));
  assert.equal(lookupExpandedRouteCache(repoDir, 'a'.repeat(64), 'constrained'), null);

  rmSync(repoDir, { recursive: true, force: true });
});

test('corrupt cache file is treated as miss and overwritten on record', async () => {
  const repoDir = makeRepo();
  const cachePath = getExpandedRouteCachePath(repoDir);
  writeFileSync(cachePath, '{\n', 'utf-8');

  assert.equal(lookupExpandedRouteCache(repoDir, 'b'.repeat(64), 'normal'), null);
  await recordExpandedRouteCache(repoDir, {
    packet_hash: 'b'.repeat(64),
    decision: {
      planner: 'gpt-5.5',
      coder: 'gpt-5.4',
      reviewer: 'claude-sonnet-4-6',
      planDepth: 'deep',
      codeDepth: 'deep',
      reviewRecommended: 'static+llm',
      expectedSuccess: 0.9,
      expectedCostPlan: 1,
      expectedCostCode: 2,
      expectedCostReview: 1,
      confidence: 0.8,
      reasoning: ['test'],
      signals: {
        taskType: 'feature',
        promptLength: 'medium',
        complexityScore: 3,
        fileTypes: ['ts'],
        riskScore: 3,
      },
    },
    operating_mode: 'normal',
    recorded_at: '2026-05-01T00:00:00.000Z',
    input_version: EXPANDED_ROUTE_CACHE_INPUT_VERSION,
  });

  const rewritten = JSON.parse(readFileSync(cachePath, 'utf-8')) as { entries: Record<string, unknown> };
  assert.ok(rewritten.entries['b'.repeat(64)]);

  rmSync(repoDir, { recursive: true, force: true });
});

test('cache file stores entries object for constant-time lookup shape', async () => {
  const repoDir = makeRepo();
  const cachePath = getExpandedRouteCachePath(repoDir);
  const entries = Object.fromEntries(
    Array.from({ length: 1000 }, (_, index) => {
      const hash = `${index}`.padStart(64, '0');
      return [hash, {
        packet_hash: hash,
        decision: {
          planner: 'gpt-5.5',
          coder: 'gpt-5.4',
          reviewer: 'claude-sonnet-4-6',
          planDepth: 'deep',
          codeDepth: 'deep',
          reviewRecommended: 'static+llm',
          expectedSuccess: 0.9,
          expectedCostPlan: 1,
          expectedCostCode: 2,
          expectedCostReview: 1,
          confidence: 0.8,
          reasoning: ['test'],
          signals: {
            taskType: 'feature',
            promptLength: 'medium',
            complexityScore: 3,
            fileTypes: ['ts'],
            riskScore: 3,
          },
        },
        operating_mode: 'normal',
        recorded_at: '2026-05-01T00:00:00.000Z',
      }];
    }),
  );
  writeFileSync(cachePath, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, 'utf-8');

  assert.ok(lookupExpandedRouteCache(repoDir, '0'.padStart(64, '0'), 'normal'));

  rmSync(repoDir, { recursive: true, force: true });
});
