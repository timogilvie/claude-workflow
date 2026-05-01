import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  planTaskDependencies,
  TaskDependencyPlannerError,
  type DependencyEdge,
  type TaskInput,
} from './task-dependency-planner.ts';

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

function makeTasks(...ids: string[]): TaskInput[] {
  return ids.map((id) => ({ id }));
}

console.log('\n--- task-dependency-planner Tests ---\n');

test('[REQ-F1] empty inputs -> empty result', () => {
  const result = planTaskDependencies([], []);
  assert.deepEqual(result, {
    waves: [],
    queues: [],
    triage: [],
  });
});

test('[REQ-F1] linear chain -> correct waves and queues', () => {
  const edges: DependencyEdge[] = [
    { type: 'depends_on', from: 'A', to: 'B' },
    { type: 'depends_on', from: 'B', to: 'C' },
  ];
  const result = planTaskDependencies(makeTasks('A', 'B', 'C'), edges);

  assert.deepEqual(result.waves, [
    { index: 0, taskIds: ['A'] },
    { index: 1, taskIds: ['B'] },
    { index: 2, taskIds: ['C'] },
  ]);
  assert.deepEqual(result.queues, [
    { taskId: 'A', ancestors: [] },
    { taskId: 'B', ancestors: ['A'] },
    { taskId: 'C', ancestors: ['A', 'B'] },
  ]);
  assert.deepEqual(result.triage, []);
});

test('[REQ-F2] unknown endpoint throws by default', () => {
  assert.throws(() => {
    planTaskDependencies(makeTasks('A'), [{ type: 'depends_on', from: 'A', to: 'B' }]);
  }, (err: unknown) => {
    assert.ok(err instanceof TaskDependencyPlannerError);
    assert.equal(err.code, 'unknown_endpoint');
    assert.deepEqual(err.offendingEdge, { type: 'depends_on', from: 'A', to: 'B' });
    return true;
  });
});

test('[REQ-F2] unknown endpoint triaged with option', () => {
  const result = planTaskDependencies(
    makeTasks('A'),
    [{ type: 'depends_on', from: 'A', to: 'B' }],
    { triageUnknownEndpoints: true },
  );

  assert.equal(result.waves.length, 1);
  assert.deepEqual(result.waves[0], { index: 0, taskIds: ['A'] });
  assert.deepEqual(result.triage.map((record) => record.reason), ['unknown_endpoint']);
});

test('[REQ-F3] depends_on cycle throws', () => {
  assert.throws(() => {
    planTaskDependencies(makeTasks('A', 'B'), [
      { type: 'depends_on', from: 'A', to: 'B' },
      { type: 'depends_on', from: 'B', to: 'A' },
    ]);
  }, (err: unknown) => {
    assert.ok(err instanceof TaskDependencyPlannerError);
    assert.equal(err.code, 'cycle');
    assert.deepEqual(err.cycle, ['A', 'B', 'A']);
    return true;
  });
});

test('[REQ-F3] 3-node cycle throws with all IDs', () => {
  assert.throws(() => {
    planTaskDependencies(makeTasks('A', 'B', 'C'), [
      { type: 'depends_on', from: 'A', to: 'B' },
      { type: 'depends_on', from: 'B', to: 'C' },
      { type: 'depends_on', from: 'C', to: 'A' },
    ]);
  }, (err: unknown) => {
    assert.ok(err instanceof TaskDependencyPlannerError);
    assert.equal(err.code, 'cycle');
    assert.deepEqual(err.cycle, ['A', 'B', 'C', 'A']);
    return true;
  });
});

test('[REQ-F4] shared_surface cycle does not throw', () => {
  const result = planTaskDependencies(makeTasks('A', 'B'), [
    { type: 'shared_surface', from: 'A', to: 'B' },
    { type: 'shared_surface', from: 'B', to: 'A' },
  ]);

  assert.deepEqual(result.waves, [{ index: 0, taskIds: ['A', 'B'] }]);
  assert.deepEqual(result.queues, [
    { taskId: 'A', ancestors: [] },
    { taskId: 'B', ancestors: [] },
  ]);
});

test('[REQ-F4] mixed: depends_on plus shared_surface cycle ok', () => {
  const result = planTaskDependencies(makeTasks('A', 'B'), [
    { type: 'depends_on', from: 'A', to: 'B' },
    { type: 'shared_surface', from: 'B', to: 'A' },
  ]);

  assert.deepEqual(result.waves, [
    { index: 0, taskIds: ['A'] },
    { index: 1, taskIds: ['B'] },
  ]);
});

test('[REQ-F5] waves are topologically ordered', () => {
  const result = planTaskDependencies(makeTasks('A', 'B', 'C', 'D'), [
    { type: 'depends_on', from: 'A', to: 'B' },
    { type: 'depends_on', from: 'A', to: 'C' },
    { type: 'depends_on', from: 'B', to: 'D' },
    { type: 'depends_on', from: 'C', to: 'D' },
  ]);

  assert.deepEqual(result.waves, [
    { index: 0, taskIds: ['A'] },
    { index: 1, taskIds: ['B', 'C'] },
    { index: 2, taskIds: ['D'] },
  ]);
});

test('[REQ-F6] deterministic regardless of input order', () => {
  const tasksA = makeTasks('A', 'B', 'C', 'D');
  const edgesA: DependencyEdge[] = [
    { type: 'depends_on', from: 'A', to: 'B' },
    { type: 'depends_on', from: 'A', to: 'C' },
    { type: 'depends_on', from: 'B', to: 'D' },
    { type: 'depends_on', from: 'C', to: 'D' },
  ];

  const tasksB = makeTasks('D', 'C', 'B', 'A');
  const edgesB: DependencyEdge[] = [
    { type: 'depends_on', from: 'C', to: 'D' },
    { type: 'depends_on', from: 'A', to: 'C' },
    { type: 'depends_on', from: 'A', to: 'B' },
    { type: 'depends_on', from: 'B', to: 'D' },
  ];

  const resultA = planTaskDependencies(tasksA, edgesA);
  const resultB = planTaskDependencies(tasksB, edgesB);

  assert.deepEqual(resultA, resultB);
});

test('[REQ-F6] numeric sort: task-2 before task-10', () => {
  const result = planTaskDependencies(makeTasks('task-10', 'task-2'), []);
  assert.deepEqual(result.waves, [{ index: 0, taskIds: ['task-2', 'task-10'] }]);
});

test('[REQ-F7] ancestor queue for diamond graph', () => {
  const result = planTaskDependencies(makeTasks('A', 'B', 'C', 'D'), [
    { type: 'depends_on', from: 'A', to: 'B' },
    { type: 'depends_on', from: 'A', to: 'C' },
    { type: 'depends_on', from: 'B', to: 'D' },
    { type: 'depends_on', from: 'C', to: 'D' },
  ]);

  const queueD = result.queues.find((queue) => queue.taskId === 'D');
  assert.ok(queueD);
  assert.deepEqual(queueD.ancestors, ['A', 'B', 'C']);
});

test('[REQ-F7] long chain ancestors in order', () => {
  const result = planTaskDependencies(makeTasks('A', 'B', 'C', 'D', 'E'), [
    { type: 'depends_on', from: 'A', to: 'B' },
    { type: 'depends_on', from: 'B', to: 'C' },
    { type: 'depends_on', from: 'C', to: 'D' },
    { type: 'depends_on', from: 'D', to: 'E' },
  ]);

  const queueE = result.queues.find((queue) => queue.taskId === 'E');
  assert.ok(queueE);
  assert.deepEqual(queueE.ancestors, ['A', 'B', 'C', 'D']);
});

test('[REQ-F8] depends_on self-loop triaged', () => {
  const result = planTaskDependencies(makeTasks('A'), [{ type: 'depends_on', from: 'A', to: 'A' }]);
  assert.deepEqual(result.triage.map((record) => record.reason), ['self_loop']);
});

test('[REQ-F8] shared_surface self-loop triaged', () => {
  const result = planTaskDependencies(makeTasks('A'), [{ type: 'shared_surface', from: 'A', to: 'A' }]);
  assert.deepEqual(result.triage.map((record) => record.reason), ['self_loop']);
});

test('[REQ-F9] duplicate edge triaged', () => {
  const result = planTaskDependencies(makeTasks('A', 'B'), [
    { type: 'depends_on', from: 'A', to: 'B' },
    { type: 'depends_on', from: 'A', to: 'B' },
  ]);

  assert.deepEqual(result.triage.map((record) => record.reason), ['duplicate']);
  assert.deepEqual(result.waves, [
    { index: 0, taskIds: ['A'] },
    { index: 1, taskIds: ['B'] },
  ]);
});

test('[REQ-F9] same from/to different type not duplicate', () => {
  const result = planTaskDependencies(makeTasks('A', 'B'), [
    { type: 'depends_on', from: 'A', to: 'B' },
    { type: 'shared_surface', from: 'A', to: 'B' },
  ]);

  assert.deepEqual(result.triage, []);
});

test('[REQ-F10] no forbidden tokens in source', () => {
  const source = readFileSync(new URL('./task-dependency-planner.ts', import.meta.url), 'utf8');
  const forbidden = ['llm-cli', 'linear', 'child_process'];

  for (const token of forbidden) {
    assert.equal(source.includes(token), false, `Source includes forbidden token: ${token}`);
  }
});

test('[REQ] duplicate task IDs throw', () => {
  assert.throws(() => {
    planTaskDependencies([{ id: 'A' }, { id: 'A' }], []);
  }, (err: unknown) => {
    assert.ok(err instanceof TaskDependencyPlannerError);
    assert.equal(err.code, 'duplicate_task_id');
    return true;
  });
});

test('[REQ] single task no edges', () => {
  const result = planTaskDependencies(makeTasks('A'), []);
  assert.deepEqual(result, {
    waves: [{ index: 0, taskIds: ['A'] }],
    queues: [{ taskId: 'A', ancestors: [] }],
    triage: [],
  });
});

console.log(`\nPassed: ${passed}`);
if (failed > 0) {
  console.log(`Failed: ${failed}`);
  process.exit(1);
}
console.log('All task-dependency-planner tests passed.');
