import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(
  readFileSync(join(__dirname, '..', 'schemas', 'launch-plan.schema.json'), 'utf-8'),
);

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validate = ajv.compile(schema);

function makePlan(taskOverrides: Record<string, unknown> = {}) {
  return {
    session: 'session-1',
    repoDir: '/tmp/repo',
    baseBranch: 'auto/integration',
    worktreeRoot: '/tmp/worktrees',
    agentCmd: 'codex',
    tasks: [
      {
        issue: 'HOK-1635',
        slug: 'document-model-field',
        branch: 'task/document-model-field',
        ...taskOverrides,
      },
    ],
  };
}

describe('launch-plan schema', () => {
  it('accepts task model selectors as strings', () => {
    const valid = validate(makePlan({ model: 'sonnet' }));
    assert.equal(valid, true, JSON.stringify(validate.errors));
  });

  it('allows tasks without a model field', () => {
    const valid = validate(makePlan());
    assert.equal(valid, true, JSON.stringify(validate.errors));
  });

  it('accepts parentResolvedModel as a string', () => {
    const valid = validate(makePlan({ parentResolvedModel: 'claude-opus-4-7' }));
    assert.equal(valid, true, JSON.stringify(validate.errors));
  });

  it('rejects non-string model values', () => {
    const valid = validate(makePlan({ model: null }));
    assert.equal(valid, false);
    assert.match(JSON.stringify(validate.errors), /\/tasks\/0\/model|must be string/i);
  });
});
