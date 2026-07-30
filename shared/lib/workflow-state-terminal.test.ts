import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { markWorkflowTerminal } from './workflow-state-terminal.ts';

test('markWorkflowTerminal records task and terminal transition idempotently', async () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'wavemill-terminal-state-'));
  const stateDir = join(repoDir, '.wavemill');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'workflow-state.json'), JSON.stringify({
    tasks: {
      'HOK-1': {
        slug: 'example',
        phase: 'ready',
        status: '',
        pr: '101',
      },
    },
  }));

  const now = () => new Date('2026-07-30T12:00:00Z');
  await markWorkflowTerminal({
    repoDir,
    issueId: 'HOK-1',
    outcome: 'done',
    reason: 'merged',
    source: 'test',
    now,
  });
  await markWorkflowTerminal({
    repoDir,
    issueId: 'HOK-1',
    outcome: 'done',
    reason: 'merged',
    source: 'test',
    now,
  });

  const state = JSON.parse(readFileSync(join(stateDir, 'workflow-state.json'), 'utf-8'));
  assert.equal(state.tasks['HOK-1'].phase, 'done');
  assert.equal(state.tasks['HOK-1'].terminal.pr, '101');
  assert.equal(state.terminalTransitions['HOK-1'].reason, 'merged');
  assert.equal(Object.keys(state.terminalTransitions).length, 1);
});
