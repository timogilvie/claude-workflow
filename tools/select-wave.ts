#!/usr/bin/env -S npx tsx
import { readFileSync } from 'node:fs';
import { runTool } from '../shared/lib/tool-runner.ts';
import {
  selectFirstWave,
  type QueuePlan,
  type TaskWithScore,
} from '../shared/lib/plan-queue-utils.ts';

type SelectWaveInput = {
  plan: QueuePlan;
  tasks: TaskWithScore[];
  maxParallel: number;
};

function parseInput(raw: string): SelectWaveInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Failed to parse select-wave JSON from stdin: ${(error as Error).message}`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TypeError('select-wave input must be a JSON object');
  }

  const input = parsed as Partial<SelectWaveInput>;
  if (!Array.isArray(input.tasks)) {
    throw new TypeError('select-wave input must include a tasks array');
  }
  if (typeof input.maxParallel !== 'number') {
    throw new TypeError('select-wave input must include numeric maxParallel');
  }

  return {
    plan: (input.plan ?? {}) as QueuePlan,
    tasks: input.tasks,
    maxParallel: input.maxParallel,
  };
}

runTool({
  name: 'select-wave',
  description: 'Select the first scheduler-derived parallel wave from scored tasks',
  options: {},
  examples: ['printf \'{"plan":{"availableNow":["HOK-1"]},"tasks":[{"id":"HOK-1","score":10}],"maxParallel":1}\' | npx tsx tools/select-wave.ts'],
  async run() {
    const input = parseInput(readFileSync(0, 'utf8'));
    const selection = selectFirstWave(input.plan, input.tasks, { maxParallel: input.maxParallel });
    process.stdout.write(`${JSON.stringify(selection, null, 2)}\n`);
  },
});
