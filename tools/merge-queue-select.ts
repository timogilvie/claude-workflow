#!/usr/bin/env -S npx tsx

import fs from 'node:fs';
import { planMergeQueueTick } from '../shared/lib/merge-queue.ts';
import type { MergeQueueConfigResolved, MergeQueuePr } from '../shared/lib/merge-queue.ts';

interface CliInput {
  readyPrs: MergeQueuePr[];
  now: string;
  config: MergeQueueConfigResolved;
}

function readInput(path: string): CliInput {
  const raw = path === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(path, 'utf8');
  return JSON.parse(raw) as CliInput;
}

const args = process.argv.slice(2);
if (args[0] !== '--input' || !args[1]) {
  console.error('Usage: merge-queue-select.ts --input <path|->');
  process.exit(1);
}

const input = readInput(args[1]);
console.log(JSON.stringify(planMergeQueueTick(input), null, 2));
