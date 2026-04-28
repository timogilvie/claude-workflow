import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CANONICAL_RUBRIC_CRITERIA,
  RUBRIC_SCHEMA_VERSION,
  RUBRIC_VERSION,
  formatRubricForAgentPrompt,
  formatRubricForJudgePrompt,
} from './rubric.ts';

const libDir = dirname(fileURLToPath(import.meta.url));
const repoDir = join(libDir, '..', '..');

test('rubric constants and criterion order are canonical', () => {
  assert.equal(RUBRIC_SCHEMA_VERSION, '1.0');
  assert.equal(RUBRIC_VERSION, '1.0');
  assert.deepEqual(
    CANONICAL_RUBRIC_CRITERIA.map((criterion) => criterion.id),
    ['completeness', 'correctness', 'code_quality', 'intervention_impact', 'autonomy']
  );
});

test('judge prompt rubric block includes canonical keys only', () => {
  const block = formatRubricForJudgePrompt();
  for (const criterion of CANONICAL_RUBRIC_CRITERIA) {
    assert.match(block, new RegExp(`\\*\\*${criterion.id}\\*\\*`));
  }
  assert.doesNotMatch(block, /scopeDiscipline/);
  assert.doesNotMatch(block, /codeQuality/);
});

test('agent prompt block stays concise and complete', () => {
  const block = formatRubricForAgentPrompt();
  assert.match(block, /^## Grading Rubric/m);
  for (const criterion of CANONICAL_RUBRIC_CRITERIA) {
    assert.match(block, new RegExp(`\`${criterion.id}\``));
  }
  assert.ok(block.length < 900);
});

test('eval-judge prompt includes every canonical rubric criterion id', () => {
  const evalJudge = readFileSync(join(repoDir, 'tools/prompts/eval-judge.md'), 'utf-8');
  for (const criterion of CANONICAL_RUBRIC_CRITERIA) {
    assert.match(evalJudge, new RegExp(`\\b${criterion.id}\\b`));
  }
});

test('agent rubric snippet matches canonical formatter output', () => {
  const snippet = readFileSync(join(repoDir, 'tools/prompts/agent-rubric-snippet.md'), 'utf-8').trim();
  assert.equal(snippet, formatRubricForAgentPrompt());
});
