import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { reviewEngineTestUtils } from './review-engine.ts';
import type { ReviewContext } from './review-context-gatherer.ts';

describe('review-engine scoped mode', () => {
  afterEach(() => {
    reviewEngineTestUtils.resetDeps();
  });

  it('uses the scoped general prompt in degraded modes', () => {
    const normalPath = reviewEngineTestUtils.getPersonaPromptPath('general', 'normal');
    const survivalPath = reviewEngineTestUtils.getPersonaPromptPath('general', 'survival');

    assert.match(normalPath, /review-general\.md$/);
    assert.match(survivalPath, /review-general-scoped\.md$/);

    const normalPrompt = reviewEngineTestUtils.loadPersonaPromptTemplate('general', 'normal');
    const survivalPrompt = reviewEngineTestUtils.loadPersonaPromptTemplate('general', 'survival');

    assert.notEqual(normalPrompt, survivalPrompt);
    assert.match(survivalPrompt, /needs_stronger_reviewer/);
  });

  it('documents the scoped four-bucket checklist and stronger reviewer flag', () => {
    const promptPath = reviewEngineTestUtils.getPersonaPromptPath('general', 'constrained');
    const prompt = readFileSync(promptPath, 'utf-8');

    assert.match(prompt, /Syntax \/ compilation/);
    assert.match(prompt, /Contract violations/);
    assert.match(prompt, /Obvious regressions/);
    assert.match(prompt, /Test-coverage gaps/);
    assert.match(prompt, /needs_stronger_reviewer/);
    assert.match(prompt, /stronger_reviewer_reason/);
    assert.match(prompt, /Reverts #N/);
    assert.match(prompt, /auto\/integration/);
  });

  it('documents cross-PR revert protection in the normal general prompt', () => {
    const prompt = reviewEngineTestUtils.loadPersonaPromptTemplate('general', 'normal');

    assert.match(prompt, /Intentionally reverts #N/);
    assert.match(prompt, /auto\/integration/);
    assert.match(prompt, /merge base/);
  });

  it('enables native review only when enabled and review phase are both configured', () => {
    const cases = [
      { config: { nativeAgent: { enabled: true, allowedPhases: ['review'] } }, expected: true },
      { config: { nativeAgent: { enabled: true } }, expected: false },
      { config: { nativeAgent: { allowedPhases: ['review'] } }, expected: false },
      { config: {}, expected: false },
    ];

    for (const [index, testCase] of cases.entries()) {
      const repoDir = mkdtempSync(join(tmpdir(), `review-engine-native-${index}-`));
      try {
        writeFileSync(
          join(repoDir, '.wavemill-config.json'),
          JSON.stringify(testCase.config),
          'utf-8',
        );
        assert.equal(reviewEngineTestUtils.isNativeReviewOptedIn(repoDir), testCase.expected);
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    }
  });

  it('dispatches to the native review loader when review phase is opted in', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'review-engine-native-dispatch-'));
    const context = makeReviewContext();

    writeFileSync(
      join(repoDir, '.wavemill-config.json'),
      JSON.stringify({ nativeAgent: { enabled: true, allowedPhases: ['review'] } }),
      'utf-8',
    );

    let loaderCalls = 0;
    reviewEngineTestUtils.setLoadNativeReviewModule(async () => {
      loaderCalls += 1;
      return {
        async runNativeReview() {
          return {
            verdict: 'ready',
            codeReviewFindings: [],
            metadata: {
              branch: context.metadata.branch,
              files: context.metadata.files,
              hasUiChanges: false,
              designContextAvailable: false,
              uiVerificationRun: false,
            },
          };
        },
      };
    });

    try {
      const result = await import('./review-engine.ts').then((module) => module.runReview(context, repoDir, {
        skipClaudePreflight: true,
      }));
      assert.equal(loaderCalls, 1);
      assert.equal(result.verdict, 'ready');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('does not invoke the native review loader when review phase is disabled', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'review-engine-native-disabled-'));
    const context = makeReviewContext();

    writeFileSync(
      join(repoDir, '.wavemill-config.json'),
      JSON.stringify({ nativeAgent: { enabled: false, allowedPhases: ['review'] } }),
      'utf-8',
    );

    let loaderCalls = 0;
    let personaCalls = 0;
    reviewEngineTestUtils.setLoadNativeReviewModule(async () => {
      loaderCalls += 1;
      throw new Error('native loader should not be called');
    });
    reviewEngineTestUtils.setRunPersonaReview(async () => {
      personaCalls += 1;
      return {
        verdict: 'ready',
        codeReviewFindings: [],
        metadata: {
          branch: context.metadata.branch,
          files: context.metadata.files,
          hasUiChanges: false,
          designContextAvailable: false,
          uiVerificationRun: false,
        },
      };
    });

    try {
      const result = await import('./review-engine.ts').then((module) => module.runReview(context, repoDir, {
        skipClaudePreflight: true,
      }));
      assert.equal(loaderCalls, 0);
      assert.equal(personaCalls, 1);
      assert.equal(result.verdict, 'ready');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

function makeReviewContext(): ReviewContext {
  return {
    diff: 'diff --git a/file.ts b/file.ts',
    plan: 'Plan',
    taskPacket: 'Task packet',
    designContext: null,
    metadata: {
      branch: 'feature/native-review',
      files: ['file.ts'],
      hasUiChanges: false,
    },
  };
}
