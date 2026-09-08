import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parseHorizons } from './backfill-survival.ts';

test('backfill-survival parses only S2 horizons', () => {
  assert.deepEqual(parseHorizons(), [14, 30, 60]);
  assert.deepEqual(parseHorizons('60,14'), [60, 14]);
  assert.throws(() => parseHorizons('7'), /horizons/);
});

test('backfill-survival requires repo coordinates before touching git or gh', () => {
  const tool = fileURLToPath(new URL('./backfill-survival.ts', import.meta.url));
  const result = spawnSync('npx', ['tsx', tool, '--repo', 'widgets'], { encoding: 'utf-8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--owner is required/);
  assert.doesNotMatch(result.stdout, /^\{/m, 'stdout must remain JSONL-only during successful scans');
});
