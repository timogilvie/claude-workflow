#!/usr/bin/env -S npx tsx
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { runTool } from '../shared/lib/tool-runner.ts';
import { getBacklog, type LinearIssue } from '../shared/lib/linear.ts';
import {
  planTaskDependencies,
  TaskDependencyPlannerError,
  type DependencyEdge,
  type PlanResult,
  type TriageRecord,
} from '../shared/lib/task-dependency-planner.ts';

type BacklogRecord = {
  id: string;
  title?: string;
  dependsOn?: string[];
  sharedSurface?: string[];
  [key: string]: unknown;
};

type QueuePlan = {
  availableNow: string[];
  queuedAfterDependencies: Array<{ taskId: string; ancestors: string[] }>;
  avoidRunningTogether: string[][];
  needsTriage: TriageRecord[];
};

const compareTaskIds = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

function parseBacklogJson(raw: string, source: string): BacklogRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Failed to parse backlog JSON from ${source}: ${(error as Error).message}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`Backlog JSON from ${source} must be an array`);

  return parsed.map((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error(`Backlog record at index ${index} must be an object`);
    }
    const record = item as BacklogRecord;
    if (typeof record.id !== 'string' || record.id.trim() === '') {
      throw new Error(`Backlog record at index ${index} must have a non-empty string id`);
    }
    for (const key of ['dependsOn', 'sharedSurface'] as const) {
      const value = record[key];
      if (value !== undefined && (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || id.trim() === ''))) {
        throw new Error(`${key} for ${record.id} must be an array of non-empty strings`);
      }
    }
    return record;
  });
}

function extractEdgesFromBacklog(records: BacklogRecord[]): DependencyEdge[] {
  return records.flatMap((record) => [
    ...(record.dependsOn ?? []).map((dependency) => ({
      type: 'depends_on' as const,
      from: dependency,
      to: record.id,
      source: 'explicit' as const,
    })),
    ...(record.sharedSurface ?? []).map((peer) => ({
      type: 'shared_surface' as const,
      from: record.id,
      to: peer,
      source: 'explicit' as const,
    })),
  ]);
}

function clusterSharedSurface(edges: DependencyEdge[]): string[][] {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    const current = parent.get(id) ?? id;
    if (current === id) {
      parent.set(id, id);
      return id;
    }
    const root = find(current);
    parent.set(id, root);
    return root;
  };

  for (const edge of edges) {
    if (edge.type !== 'shared_surface') continue;
    const rootA = find(edge.from);
    const rootB = find(edge.to);
    if (rootA !== rootB) parent.set(rootB, rootA);
  }

  const groups = new Map<string, string[]>();
  for (const id of parent.keys()) groups.set(find(id), [...(groups.get(find(id)) ?? []), id]);
  return [...groups.values()]
    .map((group) => group.sort(compareTaskIds))
    .filter((group) => group.length > 1)
    .sort((a, b) => compareTaskIds(a[0] ?? '', b[0] ?? ''));
}

function buildQueuePlan(edges: DependencyEdge[], result: PlanResult): QueuePlan {
  const triagedTaskIds = new Set(
    result.triage.filter((record) => record.reason !== 'duplicate').flatMap((record) => [record.edge.from, record.edge.to]),
  );
  const queues = result.queues.filter((queue) => !triagedTaskIds.has(queue.taskId));
  return {
    availableNow: queues.filter((queue) => queue.ancestors.length === 0).map((queue) => queue.taskId),
    queuedAfterDependencies: queues
      .filter((queue) => queue.ancestors.length > 0)
      .map((queue) => ({ taskId: queue.taskId, ancestors: queue.ancestors })),
    avoidRunningTogether: clusterSharedSurface(edges),
    needsTriage: result.triage,
  };
}

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
