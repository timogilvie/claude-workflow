import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { reviewEngineTestUtils } from './review-engine.ts';

describe('review-engine scoped mode', () => {
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
});
