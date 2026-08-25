import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const REVIEW_GUARD_TEMPLATE_COMMAND = 'npx tsx {{TOOLS_DIR}}/check-review-scope.ts --repo-dir .';
const SELF_REVIEW_GUARD_COMMAND = 'npx tsx tools/check-review-scope.ts --repo-dir .';
const LEGACY_GUARD_COMMAND = 'npx tsx $tools_dir/check-review-scope.ts --repo-dir .';
const COMMIT_INSTRUCTION = 'git commit -m "fix: Address self-review findings (iteration N)"';

function assertGuardBeforeCommit(content: string, guardCommand: string, label: string): void {
  const guardIndex = content.indexOf(guardCommand);
  const commitIndex = content.indexOf(COMMIT_INSTRUCTION);

  assert.notEqual(guardIndex, -1, `${label} must include the review scope guard command`);
  assert.notEqual(commitIndex, -1, `${label} must include the review-fix commit instruction`);
  assert.ok(guardIndex < commitIndex, `${label} must run the guard before the review-fix commit`);

  const interveningText = content.slice(guardIndex, commitIndex);
  assert.match(
    interveningText,
    /preserve the index, report the violation, and stop/i,
    `${label} must stop instead of committing when the guard fails`,
  );
  assert.match(
    interveningText,
    /No review commit may be created/i,
    `${label} must include the fail-closed no-commit contract`,
  );
}

test('review-phase prompt requires review scope guard immediately before review-fix commits', () => {
  const content = readFileSync('tools/prompts/review-phase.md', 'utf-8');

  assertGuardBeforeCommit(content, REVIEW_GUARD_TEMPLATE_COMMAND, 'review-phase.md');
});

test('canonical self-review instructions require review scope guard before review-fix commits', () => {
  const content = readFileSync('tools/prompts/self-review-instructions.md', 'utf-8');

  assertGuardBeforeCommit(content, SELF_REVIEW_GUARD_COMMAND, 'self-review-instructions.md');
});

test('legacy generated workflow instructions require review scope guard before review-fix commits', () => {
  const content = readFileSync('shared/lib/agent-adapters.sh', 'utf-8');

  assertGuardBeforeCommit(content, LEGACY_GUARD_COMMAND, 'agent-adapters.sh');
});
