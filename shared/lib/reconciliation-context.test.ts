import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  MAX_CAPSULE_BYTES,
  buildFailureFingerprint,
  buildFoundation,
  canonicalJson,
  capsulePath,
  computeAttemptCost,
  computeFoundationDigest,
  computeIncidentFingerprint,
  createCapsule,
  normalizeUsage,
  projectCapsulePrompt,
  readCapsule,
  redactText,
  withAttempt,
  withIncident,
  writeCapsule,
  type ReconciliationAttempt,
  type ReconciliationCapsule,
  type ReconciliationIncident,
} from './reconciliation-context.ts';

function tempDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'recon-capsule-test-'));
}

function fixtureCapsule(featureDir: string): ReconciliationCapsule {
  const packetPath = path.join(featureDir, 'task-packet.md');
  writeFileSync(packetPath, '# Task packet\nDo the thing.\n');
  const foundation = buildFoundation({
    taskId: 'HOK-2936',
    taskTitle: 'Persist a durable post-PR reconciliation capsule',
    slug: 'persist-capsule',
    branch: 'task/persist-capsule',
    baseBranch: 'auto/integration',
    prNumber: 42,
    taskPacketPath: packetPath,
    executionContractPath: path.join(featureDir, '.phase-config.json'),
    scopeSummary: 'Reconcile CI failures and conflicts only; no new features.',
    createdAt: '2026-09-01T00:00:00.000Z',
  });
  return createCapsule({
    foundation,
    reviewHeadSha: 'aaa1110000000000000000000000000000000000',
    reviewResultPath: path.join(featureDir, '.review-result.json'),
    reviewVerdict: 'ready',
    now: '2026-09-01T00:00:01.000Z',
  });
}

function incidentFor(classification: ReconciliationIncident['classification']): ReconciliationIncident {
  const base: ReconciliationIncident = {
    classification,
    headSha: 'aaa1110000000000000000000000000000000000',
    baseSha: 'bbb2220000000000000000000000000000000000',
    failureFingerprint: buildFailureFingerprint([`check-${classification}`]),
    detail: `incident for ${classification}`,
    observedAt: new Date().toISOString(),
  };
  if (classification === 'ci_deterministic_safe') {
    base.failingChecks = [{ name: 'Unit Tests', failingJob: 'unit-2', localCommand: 'bash tests/run-unit-tests.sh' }];
  }
  if (classification === 'merge_conflict') {
    base.conflictFiles = ['shared/lib/foo.ts'];
  }
  return base;
}

test('canonical digest is stable under key reordering and changes with scope', () => {
  const a = { taskId: 'X', slug: 's', nested: { b: 1, a: 2 } };
  const b = { nested: { a: 2, b: 1 }, slug: 's', taskId: 'X' };
  assert.equal(canonicalJson(a), canonicalJson(b));

  const dir = tempDir();
  try {
    const capsule = fixtureCapsule(dir);
    const changedScope = {
      ...capsule.foundation,
      scopeSummary: 'A different scope',
    };
    assert.notEqual(computeFoundationDigest(capsule.foundation), computeFoundationDigest(changedScope));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('REQ-F1/REQ-F2: foundation digest and projected prefix are byte-stable across three incident updates', () => {
  const dir = tempDir();
  try {
    let capsule = fixtureCapsule(dir);
    const digests: string[] = [];
    const prefixes: string[] = [];
    const incidentFingerprints: string[] = [];
    for (const classification of ['ci_transient', 'ci_deterministic_safe', 'merge_conflict'] as const) {
      capsule = withIncident(capsule, incidentFor(classification));
      const write = writeCapsule(dir, capsule);
      assert.equal(write.ok, true);
      const read = readCapsule(dir);
      assert.equal(read.ok, true);
      if (!read.ok) return;
      digests.push(read.capsule.foundationDigest);
      incidentFingerprints.push(read.capsule.incidentFingerprint as string);
      prefixes.push(projectCapsulePrompt(read.capsule).prefix);
    }
    assert.equal(new Set(digests).size, 1, 'foundation digest must not change across incidents');
    assert.equal(new Set(prefixes).size, 1, 'projected prefix must be byte-stable across incidents');
    assert.equal(new Set(incidentFingerprints).size, 3, 'each incident must have a distinct fingerprint');

    const read = readCapsule(dir);
    assert.equal(read.ok, true);
    if (read.ok) {
      assert.equal(read.capsule.schemaVersion, 1);
      assert.equal(read.capsule.foundation.prNumber, 42);
      assert.match(read.capsule.foundation.taskPacketDigest as string, /^[0-9a-f]{64}$/);
      assert.equal(read.capsule.review.reviewHeadSha, 'aaa1110000000000000000000000000000000000');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('REQ-F4: missing, malformed, oversized, version-mismatched, and tampered capsules return typed reasons', () => {
  const dir = tempDir();
  try {
    assert.deepEqual(readCapsule(dir).ok, false);
    assert.equal((readCapsule(dir) as { reason: string }).reason, 'capsule_missing');

    writeFileSync(capsulePath(dir), '{not json');
    assert.equal((readCapsule(dir) as { reason: string }).reason, 'capsule_malformed');

    writeFileSync(capsulePath(dir), `{"schemaVersion":1,"pad":"${'x'.repeat(MAX_CAPSULE_BYTES)}"}`);
    assert.equal((readCapsule(dir) as { reason: string }).reason, 'capsule_oversized');

    writeFileSync(capsulePath(dir), JSON.stringify({ schemaVersion: 99 }));
    assert.equal((readCapsule(dir) as { reason: string }).reason, 'capsule_schema_version_unsupported');

    const capsule = fixtureCapsule(dir);
    const write = writeCapsule(dir, capsule);
    assert.equal(write.ok, true);
    const tampered = JSON.parse(readFileSync(capsulePath(dir), 'utf-8'));
    tampered.foundation.taskTitle = 'tampered';
    writeFileSync(capsulePath(dir), JSON.stringify(tampered));
    assert.equal((readCapsule(dir) as { reason: string }).reason, 'capsule_digest_mismatch');

    // Schema-invalid but parseable content is malformed, not a crash.
    writeFileSync(capsulePath(dir), JSON.stringify({ schemaVersion: 1, foundation: {} }));
    assert.equal((readCapsule(dir) as { reason: string }).reason, 'capsule_malformed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeCapsule refuses oversized capsules and leaves no partial files', () => {
  const dir = tempDir();
  try {
    let capsule = fixtureCapsule(dir);
    const bigChecks = Array.from({ length: 50 }, (_, i) => ({
      name: `check-${i}`,
      logExcerpt: 'e'.repeat(4000),
    }));
    capsule = withIncident(capsule, { ...incidentFor('ci_deterministic_safe'), failingChecks: bigChecks });
    const write = writeCapsule(dir, capsule);
    assert.equal(write.ok, false);
    if (!write.ok) assert.equal(write.reason, 'capsule_oversized');
    const leftovers = readdirSync(dir).filter((name) => name.includes('.reconciliation-context.json'));
    assert.deepEqual(leftovers, [], 'no capsule or tmp file may remain after a refused write');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('REQ-F8: secrets are redacted and large logs bounded; projection stays under 64 KiB', () => {
  assert.equal(redactText('LINEAR_API_KEY=lin_api_supersecret1234 more'), 'LINEAR_API_KEY=[REDACTED] more');
  assert.ok(!redactText('Authorization: Bearer abcdefghijklmnop').includes('abcdefghijklmnop'));
  assert.ok(!redactText('token ghp_1234567890abcdef').includes('ghp_1234567890abcdef'));

  const dir = tempDir();
  try {
    let capsule = fixtureCapsule(dir);
    const hugeLog = `LINEAR_API_KEY=secretvalue\n${'log line\n'.repeat(12_000)}`; // > 100 KiB
    capsule = withIncident(capsule, {
      ...incidentFor('ci_deterministic_safe'),
      detail: 'failed with LINEAR_API_KEY=secretvalue in env',
      failingChecks: [{ name: 'Unit Tests', logExcerpt: hugeLog }],
    });
    const write = writeCapsule(dir, capsule);
    assert.equal(write.ok, true);
    const raw = readFileSync(capsulePath(dir), 'utf-8');
    assert.ok(!raw.includes('secretvalue'), 'raw secret must not be persisted');
    assert.ok(Buffer.byteLength(raw, 'utf-8') <= MAX_CAPSULE_BYTES);

    const read = readCapsule(dir);
    assert.equal(read.ok, true);
    if (read.ok) {
      const projection = projectCapsulePrompt(read.capsule);
      assert.ok(!projection.text.includes('secretvalue'));
      assert.ok(Buffer.byteLength(projection.text, 'utf-8') <= MAX_CAPSULE_BYTES);
      const prefixEnd = projection.text.indexOf('## Current incident');
      assert.ok(prefixEnd > 0, 'stable foundation must precede the incident delta');
      assert.ok(projection.text.indexOf('## Task foundation') < prefixEnd);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('REQ-F7: usage normalization keeps null (not zero) and cost records unavailable reasons', () => {
  assert.equal(normalizeUsage(null), null);
  assert.equal(normalizeUsage({}), null);
  const usage = normalizeUsage({ inputTokens: 1200, outputTokens: 300 });
  assert.deepEqual(usage, { inputTokens: 1200, outputTokens: 300, cacheReadTokens: null, cacheWriteTokens: null });

  assert.deepEqual(computeAttemptCost(null), { available: false, reason: 'usage_unavailable' });
  assert.deepEqual(computeAttemptCost(usage), { available: false, reason: 'pricing_unavailable' });
  const cost = computeAttemptCost(usage, { inputPerMTok: 3, outputPerMTok: 15 });
  assert.deepEqual(cost, { available: true, usd: 0.0081 });
});

test('non-functional: read + validate + project completes under 100ms with 100 attempts', () => {
  const dir = tempDir();
  try {
    let capsule = fixtureCapsule(dir);
    capsule = withIncident(capsule, incidentFor('ci_deterministic_safe'));
    for (let i = 1; i <= 120; i++) {
      const attempt: ReconciliationAttempt = {
        attemptNumber: i,
        classification: 'ci_deterministic_safe',
        failureFingerprint: buildFailureFingerprint([`check-${i % 5}`]),
        headSha: 'aaa1110000000000000000000000000000000000',
        agent: 'claude',
        model: 'claude-sonnet-5',
        provider: 'anthropic',
        launchMode: 'fresh',
        startedAt: new Date().toISOString(),
        usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: null, cacheWriteTokens: null },
        cost: { available: false, reason: 'pricing_unavailable' },
        outcome: 'no_commit',
        resultCommitSha: null,
      };
      capsule = withAttempt(capsule, attempt);
    }
    assert.equal(capsule.attempts.length, 100, 'attempt history is bounded to 100 entries');
    assert.equal(writeCapsule(dir, capsule).ok, true);

    // Warm the schema validator once; the budget covers steady-state reads.
    readCapsule(dir);
    const start = process.hrtime.bigint();
    const read = readCapsule(dir);
    assert.equal(read.ok, true);
    if (read.ok) projectCapsulePrompt(read.capsule);
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    assert.ok(elapsedMs < 100, `read/validate/project took ${elapsedMs.toFixed(1)}ms (budget 100ms)`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('incident fingerprint ignores volatile fields but tracks failure identity', () => {
  const one = incidentFor('ci_transient');
  const two = { ...one, observedAt: '2030-01-01T00:00:00.000Z', detail: 'different narrative' };
  assert.equal(computeIncidentFingerprint(one), computeIncidentFingerprint(two));
  const three = { ...one, failureFingerprint: buildFailureFingerprint(['another-check']) };
  assert.notEqual(computeIncidentFingerprint(one), computeIncidentFingerprint(three));
});
