import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { parsePrMetadata, renderPrMetadata, validatePrMetadata, type PrMetadata } from '../shared/lib/pr-metadata.ts';
import { buildNativeCodingHandoff, buildPrBody, firstNonEmpty, resolveBaseBranch } from './launch-native-review.ts';

describe('launch-native-review helpers', () => {
  it('ignores blank launcher context so required defaults remain available', () => {
    assert.equal(firstNonEmpty('', '   ', undefined, 'main'), 'main');
    assert.equal(firstNonEmpty('', undefined), undefined);
  });

  it('resolves the review base branch from mill config before falling back to main', () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'native-review-base-'));
    try {
      writeFileSync(
        join(repoDir, '.wavemill-config.json'),
        JSON.stringify({ mill: { baseBranch: 'auto/integration' } }, null, 2),
      );

      // Configured base wins when the launcher passed nothing.
      assert.equal(resolveBaseBranch(undefined, undefined, repoDir), 'auto/integration');
      // Blank env must not mask the configured value.
      assert.equal(resolveBaseBranch('', '   ', repoDir), 'auto/integration');
      // Explicit inputs still take precedence, in order.
      assert.equal(resolveBaseBranch('release/1.x', 'env-branch', repoDir), 'release/1.x');
      assert.equal(resolveBaseBranch(undefined, 'env-branch', repoDir), 'env-branch');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('falls back to main when no base branch is configured anywhere', () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'native-review-base-empty-'));
    try {
      assert.equal(resolveBaseBranch(undefined, undefined, repoDir), 'main');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('builds a compact native coding handoff from completion artifacts', () => {
    const featureDir = mkdtempSync(join(tmpdir(), 'native-review-feature-'));
    try {
      writeFileSync(join(featureDir, '.coding-result.json'), JSON.stringify({
        stage: 'coding',
        status: 'completed',
        artifacts: {
          type: 'coding',
          filesChanged: 2,
          commitCount: 1,
        },
      }, null, 2));
      writeFileSync(join(featureDir, '.coding-complete'), '{"stage":"coding","confidence":"high"}\n');

      const handoff = buildNativeCodingHandoff(featureDir);

      assert.match(handoff, /Coding Stage Result/);
      assert.match(handoff, /"status": "completed"/);
      assert.match(handoff, /"commitCount": 1/);
      assert.match(handoff, /Coding Completion Marker/);
      assert.match(handoff, /Confidence: high/);
      assert.match(handoff, /```json/);
      assert.match(handoff, /"confidence":"high"/);
    } finally {
      rmSync(featureDir, { recursive: true, force: true });
    }
  });

  it('includes blocked-completion handoff details when present', () => {
    const featureDir = mkdtempSync(join(tmpdir(), 'native-review-feature-'));
    try {
      writeFileSync(join(featureDir, '.coding-blocked-completion.json'), JSON.stringify({
        schemaVersion: 1,
        stage: 'coding',
        status: 'blocked',
        reason: 'verification_blocked',
      }, null, 2));

      const handoff = buildNativeCodingHandoff(featureDir);

      assert.match(handoff, /Blocked Completion Handoff/);
      assert.match(handoff, /verification_blocked/);
    } finally {
      rmSync(featureDir, { recursive: true, force: true });
    }
  });

  it('builds PR body metadata using only registered fields', () => {
    const body = buildPrBody({
      issue: 'HOK-2948_c',
      title: 'Ready and Tend disagree on invalid wavemill-meta',
      reviewerModel: 'gpt-5.5',
      baseBranch: 'auto/integration',
      headBranch: 'task/hok-2948-c',
    });

    const validation = validatePrMetadata(body);
    assert.equal(validation.status, 'valid');
    if (validation.status !== 'valid') {
      return;
    }

    assert.deepEqual(validation.metadata, { task: 'HOK-2948_c' });
    const parsed = parsePrMetadata(body);
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.equal(parsed.bodyWithoutBlock.includes('review-infrastructure-note:'), false);
    }
  });

  it('fails before PR body emission when unknown metadata writer input is attempted', () => {
    assert.throws(
      () => renderPrMetadata({
        task: 'HOK-2948_c',
        'review-infrastructure-note': 'native-context-window-exceeded',
      } as PrMetadata & Record<string, string>),
      /Unknown wavemill-meta field: review-infrastructure-note/,
    );
  });
});
