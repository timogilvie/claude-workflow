#!/usr/bin/env -S npx tsx
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { runTool } from '../shared/lib/tool-runner.ts';
import { getBacklog, type LinearIssue } from '../shared/lib/linear.ts';
import { planTaskDependencies, TaskDependencyPlannerError } from '../shared/lib/task-dependency-planner.ts';
import {
  parseBacklogJson,
  extractEdgesFromBacklog,
  buildQueuePlan,
  compareTaskIds,
  type BacklogRecord,
  type QueuePlan,
} from '../shared/lib/plan-queue-utils.ts';

function renderPreview(queuePlan: QueuePlan, records: BacklogRecord[]): string {
  const titleById = new Map(records.map((record) => [record.id, record.title ?? '']));
  const task = (id: string) => (titleById.get(id) ? `${id} - ${titleById.get(id)}` : id);
  const section = <T>(heading: string, items: T[], render: (item: T) => string) =>
    [heading, ...(items.length === 0 ? ['(none)'] : items.map(render))].join('\n');

  return [
    section('Available Now', queuePlan.availableNow, (id) => `- ${task(id)}`),
    section('Queued After Dependencies', queuePlan.queuedAfterDependencies, (item) => `- ${task(item.taskId)} (after: ${item.ancestors.join(', ')})`),
    section('Avoid Running Together', queuePlan.avoidRunningTogether, (group) => `- ${group.join(', ')}`),
    section('Needs Triage', queuePlan.needsTriage, (record) => `- ${record.edge.to} (${record.reason}: ${record.detail ?? `${record.edge.from}->${record.edge.to}`})`),
  ].join('\n\n');
}

async function loadBacklogFromLinear(projectName?: string): Promise<BacklogRecord[]> {
  const blockers = (issue: LinearIssue) =>
    (issue.inverseRelations?.nodes ?? [])
      .filter((relation) => relation.type === 'blocks' && relation.issue?.identifier)
      .map((relation) => relation.issue!.identifier)
      .sort(compareTaskIds);

  return (await getBacklog(projectName)).map((issue) => ({
    id: issue.identifier,
    title: issue.title,
    dependsOn: blockers(issue),
  }));
}

function readBacklogFile(path: string): BacklogRecord[] {
  try {
    return parseBacklogJson(readFileSync(path, 'utf8'), path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code) {
      throw new Error(`Failed to read backlog file ${path}: ${(error as Error).message}`);
    }
    throw error;
  }
}

runTool({
  name: 'plan-queue',
  description: 'Plan read-only task dependency queues from backlog JSON',
  options: {
    'backlog-file': { type: 'string', description: 'Read backlog JSON array from a file' },
    stdin: { type: 'boolean', description: 'Read backlog JSON array from stdin' },
    project: { type: 'string', description: 'Fetch backlog from Linear project name' },
    json: { type: 'boolean', description: 'Emit queuePlan JSON' },
    preview: { type: 'boolean', description: 'Emit human-readable preview' },
  },
  examples: [
    'npx tsx tools/plan-queue.ts --backlog-file fixtures/plan-queue/backlog-basic.json --json',
    'cat backlog.json | npx tsx tools/plan-queue.ts --stdin --preview',
    'npx tsx tools/plan-queue.ts --project "My Project" --json --preview',
  ],
  async run({ args }) {
    const sources = [args['backlog-file'], args.stdin, args.project].filter(Boolean);
    if (sources.length !== 1) throw new Error('Usage: provide exactly one input source: --backlog-file <path>, --stdin, or --project <name>');

    const records = args['backlog-file']
      ? readBacklogFile(args['backlog-file'])
      : args.stdin
      ? parseBacklogJson(readFileSync(0, 'utf8'), 'stdin')
      : await loadBacklogFromLinear(args.project);
    const edges = extractEdgesFromBacklog(records);
    let result: PlanResult;
    try {
      result = planTaskDependencies(records, edges, { triageUnknownEndpoints: true });
    } catch (error) {
      if (error instanceof TaskDependencyPlannerError) throw new Error(`Planner failed (${error.code}): ${error.message}`);
      throw error;
    }

    const queuePlan = buildQueuePlan(edges, result);
    const emitJson = args.json || !args.preview;
    if (emitJson) process.stdout.write(`${JSON.stringify(queuePlan, null, 2)}\n`);
    if (args.preview) {
      (emitJson ? process.stderr : process.stdout).write(`${renderPreview(queuePlan, records)}\n`);
    }
  },
});
