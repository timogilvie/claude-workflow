#!/usr/bin/env -S npx tsx

import { readFileSync } from 'node:fs';
import { stdin as input } from 'node:process';
import { getBacklogForScoring } from '../shared/lib/linear.ts';
import {
  planTaskDependencies,
  TaskDependencyPlannerError,
  type DependencyEdge,
  type PlanResult,
  type TaskInput,
} from '../shared/lib/task-dependency-planner.ts';
import { runTool } from '../shared/lib/tool-runner.ts';

type RawBacklogObject = { tasks?: unknown; edges?: unknown };
type RawLinearRelation = { type?: unknown; relatedIssue?: { identifier?: unknown } };
type RawLinearIssue = { id?: unknown; identifier?: unknown; relations?: { nodes?: unknown } };

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of input) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf-8');
}

export function normalizeBacklog(raw: unknown): { tasks: TaskInput[]; edges: DependencyEdge[] } {
  if (Array.isArray(raw)) {
    const tasks: TaskInput[] = [];
    const edges: DependencyEdge[] = [];
    for (const item of raw as RawLinearIssue[]) {
      if (!item || typeof item !== 'object') throw new Error('backlog must be an array of task objects');
      const id = typeof item.identifier === 'string' ? item.identifier : typeof item.id === 'string' ? item.id : '';
      if (!id) throw new Error('each task must include id or identifier');
      tasks.push({ id });

      const relations = Array.isArray(item.relations?.nodes) ? item.relations.nodes as RawLinearRelation[] : [];
      for (const relation of relations) {
        const to = relation?.relatedIssue?.identifier;
        if (relation?.type === 'blocks' && typeof to === 'string' && to) {
          edges.push({ type: 'depends_on', from: id, to, source: 'inferred', reason: 'linear.blocks' });
        }
      }
    }
    return { tasks, edges };
  }

  if (raw && typeof raw === 'object') {
    const obj = raw as RawBacklogObject;
    if (!Array.isArray(obj.tasks)) throw new Error('backlog object must include tasks[]');
    if (obj.edges !== undefined && !Array.isArray(obj.edges)) throw new Error('backlog object edges must be an array');
    return {
      tasks: obj.tasks as TaskInput[],
      edges: (obj.edges ?? []) as DependencyEdge[],
    };
  }

  throw new Error('backlog must be an array of tasks or {tasks,edges} object');
}

export function formatPreview(result: PlanResult, edges: DependencyEdge[]): string {
  const available = result.waves[0]?.taskIds ?? [];
  const byTask = new Map(result.queues.map((q) => [q.taskId, q.ancestors]));
  const queued = result.waves.slice(1).flatMap((w) => w.taskIds);
  const sharedPairs = edges.filter((e) => e.type === 'shared_surface').map((e) => `${e.from} + ${e.to}`);
  const triage = [...new Set(result.triage.flatMap((r) => [r.edge.from, r.edge.to]))].sort();
  return [
    'Available Now',
    ...((available.length ? available : ['(none)']).map((id) => `  ${id}`)),
    '',
    'Queued After Dependencies',
    ...((queued.length ? queued.map((id) => `  ${id} (after: ${(byTask.get(id) ?? []).join(', ')})`) : ['  (none)'])),
    '',
    'Avoid Running Together',
    ...((sharedPairs.length ? sharedPairs : ['(none)']).map((line) => `  ${line}`)),
    '',
    'Needs Triage',
    ...((triage.length ? triage : ['(none)']).map((id) => `  ${id}`)),
  ].join('\n');
}

async function loadInput(backlogPath?: string, project?: string): Promise<unknown> {
  if (backlogPath && project) throw new Error('provide only one of --backlog or --project');
  if (backlogPath) return JSON.parse(readFileSync(backlogPath, 'utf-8'));
  if (project) return await getBacklogForScoring(project);
  if (!process.stdin.isTTY) {
    const text = await readStdin();
    if (!text.trim()) throw new Error('stdin is empty');
    return JSON.parse(text);
  }
  throw new Error('no input provided. Use --backlog, --project, or pipe JSON via stdin.');
}

function main(): void {
  runTool({
    name: 'plan-queue',
    description: 'Analyze task dependency queue from backlog JSON',
    options: {
      backlog: { type: 'string', description: 'Path to backlog JSON file' },
      project: { type: 'string', description: 'Linear project name to fetch backlog for scoring' },
      preview: { type: 'boolean', description: 'Render human-readable preview instead of JSON' },
    },
    examples: [
      'npx tsx tools/plan-queue.ts --backlog /tmp/backlog.json',
      'cat /tmp/backlog.json | npx tsx tools/plan-queue.ts --preview',
      'npx tsx tools/plan-queue.ts --project "My Project"',
    ],
    async run({ args }) {
      try {
        const raw = await loadInput(args.backlog, args.project);
        const { tasks, edges } = normalizeBacklog(raw);
        const result = planTaskDependencies(tasks, edges, { triageUnknownEndpoints: true });
        process.stdout.write(`${args.preview ? formatPreview(result, edges) : JSON.stringify(result, null, 2)}\n`);
      } catch (error) {
        if (error instanceof TaskDependencyPlannerError) {
          console.error(`Error: ${error.message}`);
          process.exit(2);
        }
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${message}`);
        process.exit(1);
      }
    },
  });
}

if (import.meta.main) main();
