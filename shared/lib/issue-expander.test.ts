import assert from 'node:assert/strict';
import { buildIssueExpansionCallOptions } from './issue-expander.ts';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${(err as Error).message}`);
  }
}

console.log('\n--- issue-expander Tests ---\n');

test('uses cliCmd for explicit Claude command overrides', () => {
  const options = buildIssueExpansionCallOptions('/custom/claude');
  assert.equal(options.cliCmd, '/custom/claude');
  assert.equal(options.mode, 'stream');
  assert.ok(options.cliFlags?.includes('--append-system-prompt'));
});

test('uses durable Claude settings for packet expansion', () => {
  const options = buildIssueExpansionCallOptions('/custom/claude');
  assert.equal(options.taskType, 'planning');
  assert.equal(options.retry, true);
  assert.equal(options.maxRetries, 2);
  assert.equal(options.timeout, 600_000);
  assert.equal(options.activityTimeout, undefined);
  assert.equal(options.maxBuffer, 50 * 1024 * 1024);
});

test('falls back to CLAUDE_CMD when no explicit override is provided', () => {
  const original = process.env.CLAUDE_CMD;
  process.env.CLAUDE_CMD = '/env/claude';

  try {
    const options = buildIssueExpansionCallOptions();
    assert.equal(options.cliCmd, '/env/claude');
  } finally {
    if (original === undefined) {
      delete process.env.CLAUDE_CMD;
    } else {
      process.env.CLAUDE_CMD = original;
    }
  }
});

console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
if (failed > 0) {
  process.exit(1);
}
