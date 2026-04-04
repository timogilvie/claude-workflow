import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  detectSinceCommit,
  formatReviewResult,
  parseLogFormat,
} from './review-formatter.ts';
import type { ReviewResult } from './review-runner.ts';

test('parseLogFormat accepts text and json', () => {
  assert.equal(parseLogFormat(undefined), 'text');
  assert.equal(parseLogFormat('text'), 'text');
  assert.equal(parseLogFormat('json'), 'json');
});

test('parseLogFormat rejects invalid values', () => {
  assert.throws(() => parseLogFormat('xml'), /Invalid --log-format value/);
});

test('formatReviewResult includes verdict, findings, and metadata', () => {
  const result: ReviewResult = {
    verdict: 'not_ready',
    codeReviewFindings: [
      {
        severity: 'blocker',
        category: 'correctness',
        location: 'src/app.ts:12',
        description: 'Broken branch condition',
      },
    ],
    uiFindings: [
      {
        severity: 'warning',
        category: 'design',
        location: 'src/app.tsx:4',
        description: 'Spacing is inconsistent',
      },
    ],
    metadata: {
      branch: 'task/example',
      files: ['src/app.ts', 'src/app.tsx'],
      hasUiChanges: true,
      designContextAvailable: true,
      uiVerificationRun: true,
    },
  };

  const output = formatReviewResult(result, false);
  assert.match(output, /Verdict:/);
  assert.match(output, /NOT READY/);
  assert.match(output, /Code Review/);
  assert.match(output, /UI Review/);
  assert.match(output, /task\/example/);
});

test('detectSinceCommit reads selected-task metadata for task branches', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'review-formatter-'));
  const taskDir = join(repoDir, 'features', 'demo-task');
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(
    join(taskDir, 'selected-task.json'),
    JSON.stringify({ reviewBaseCommit: 'abc1234567890' }),
    'utf-8'
  );

  assert.equal(
    detectSinceCommit('task/demo-task', repoDir, false),
    'abc1234567890'
  );
  assert.equal(detectSinceCommit('main', repoDir, false), undefined);
});
