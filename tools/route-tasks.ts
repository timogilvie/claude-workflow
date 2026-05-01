#!/usr/bin/env -S npx tsx

import { readFileSync } from 'node:fs';
import { stdin as input } from 'node:process';
import { routeBatch, getWavemillAdditionalEvalPaths, tasksFromPlan } from '../shared/lib/route-batch.ts';
import type { RouteInputKind, RouteSource } from '../shared/lib/route-artifact.ts';
import { runTool } from '../shared/lib/tool-runner.ts';

interface RouteBatchTaskInput {
  issueId?: string;
  prompt?: string;
  file?: string;
  source?: RouteSource;
  inputKind?: RouteInputKind;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of input) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

async function readJsonlTasks(path: string): Promise<RouteBatchTaskInput[]> {
  const content = path === '-'
    ? await readStdin()
    : readFileSync(path, 'utf-8');

  const tasks: RouteBatchTaskInput[] = [];
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
  for (const [index, line] of lines.entries()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid JSONL at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (!parsed || typeof parsed !== 'object') {
      throw new Error(`Invalid JSONL at line ${index + 1}: expected object`);
    }

    const item = parsed as { issueId?: unknown; prompt?: unknown; file?: unknown; source?: unknown; inputKind?: unknown };
    tasks.push({
      issueId: typeof item.issueId === 'string' ? item.issueId : undefined,
      prompt: typeof item.prompt === 'string' ? item.prompt : undefined,
      file: typeof item.file === 'string' ? item.file : undefined,
      source: typeof item.source === 'string' ? item.source as RouteSource : undefined,
      inputKind: typeof item.inputKind === 'string' ? item.inputKind as RouteInputKind : undefined,
    });
  }

  return tasks;
}

runTool({
  name: 'route-tasks',
  description: 'Batch route multiple task prompts or packet files as JSONL',
  options: {
    jsonl: {
      type: 'string',
      description: 'Route one JSON object per line from a file or stdin (-)',
    },
    plan: {
      type: 'string',
      description: 'Route tasks from a launch-plan style JSON file',
    },
    'repo-dir': {
      type: 'string',
      description: 'Repository directory (default: current directory)',
    },
    mode: {
      type: 'string',
      description: 'Routing mode: auto, stage-aware, heuristic, or hokusai',
    },
    'max-cost': {
      type: 'string',
      description: 'Maximum cost budget in USD for routing',
    },
  },
  examples: [
    '# Route a JSONL file of task packets',
    'npx tsx tools/route-tasks.ts --jsonl /tmp/route-input.jsonl',
    '',
    '# Route launch-plan tasks',
    'npx tsx tools/route-tasks.ts --plan /tmp/session-launch-plan.json',
    '',
    '# Route JSONL from stdin',
    'cat /tmp/route-input.jsonl | npx tsx tools/route-tasks.ts --jsonl -',
  ],
  async run({ args }) {
    if ((args.jsonl ? 1 : 0) + (args.plan ? 1 : 0) !== 1) {
      throw new Error('Provide exactly one of --jsonl or --plan.');
    }

    const repoDir = args['repo-dir'] || process.cwd();
    const mode = (args.mode || 'auto') as 'auto' | 'stage-aware' | 'heuristic' | 'hokusai';
    let maxCostUsd: number | undefined;
    if (args['max-cost']) {
      maxCostUsd = Number(args['max-cost']);
      if (!Number.isFinite(maxCostUsd) || maxCostUsd < 0) {
        throw new Error(`--max-cost must be a non-negative number, got ${args['max-cost']}`);
      }
    }

    const tasks = args.jsonl
      ? await readJsonlTasks(args.jsonl)
      : tasksFromPlan(JSON.parse(readFileSync(args.plan!, 'utf-8')));

    if (tasks.length === 0) {
      return;
    }

    const results = await routeBatch(tasks, {
      repoDir,
      mode,
      maxCostUsd,
      additionalEvalsPaths: getWavemillAdditionalEvalPaths(repoDir),
    });

    if (results.length !== tasks.length) {
      throw new Error(`Batch routing returned ${results.length} results for ${tasks.length} tasks`);
    }

    for (const { task, decision } of results) {
      if (!decision.planner || !decision.coder || !decision.reviewer) {
        throw new Error(`Batch routing returned an incomplete decision${task.issueId ? ` for ${task.issueId}` : ''}`);
      }

      const output = task.issueId
        ? { issueId: task.issueId, ...decision }
        : decision;
      console.log(JSON.stringify(output));
    }
  },
});
