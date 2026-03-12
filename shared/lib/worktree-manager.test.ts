import assert from 'node:assert/strict';
import { getWorktreePath } from './worktree-manager.ts';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${(error as Error).message}`);
  }
}

console.log('\n--- worktree-manager tests ---\n');

test('getWorktreePath sanitizes branch names into feature worktree paths', () => {
  const result = getWorktreePath('Add caching layer', '/tmp/worktrees');
  assert.equal(result, '/tmp/worktrees/add-caching-layer');
});

process.on('exit', () => {
  console.log(`\nPassed: ${passed}`);
  console.log(`Failed: ${failed}`);

  if (failed > 0) {
    process.exitCode = 1;
  }
});
