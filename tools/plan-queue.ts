#!/usr/bin/env -S npx tsx
import { readFileSync } from 'node:fs';
import process from 'node:process';
import {
  assembleNearbyContext,
  buildPartialRefreshPrompt,
  parseQueueAnalysisEdges,
} from '../shared/lib/queue-partial-refresh.ts';
import { runTool } from '../shared/lib/tool-runner.ts';
import { getBacklog, type LinearIssue } from '../shared/lib/linear.ts';
import {
  planTaskDependencies,
  TaskDependencyPlannerError,
  type DependencyEdge,
  type PlanResult,
} from '../shared/lib/task-dependency-planner.ts';
import {
  cachedEdgesToDependencyEdges,
  computeBacklogDiff,
  getCacheStats,
  loadCache,
  mergeEdges,
  pruneCache,
  saveCache,
  type CacheFile,
  type FingerprintableTask,
} from '../shared/lib/task-dependency-plan-cache.ts';
import {
  parseBacklogJson,
  extractEdgesFromBacklog,
  buildQueuePlan,
  compareTaskIds,
  type BacklogRecord,
  type QueuePlan,
} from '../shared/lib/plan-queue-utils.ts';
import { toKebabCase } from '../shared/lib/string-utils.ts';

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
  const blockingRelationIds = (issue: LinearIssue) =>
    [
      ...(issue.relations?.nodes ?? [])
        .filter((relation) => relation.type === 'blocks' && relation.relatedIssue?.identifier)
        .map((relation) => relation.relatedIssue!.identifier),
      ...(issue.inverseRelations?.nodes ?? [])
        .filter((relation) => relation.type === 'blocks' && relation.issue?.identifier)
        .map((relation) => relation.issue!.identifier),
    ]
      .sort(compareTaskIds)
      .filter((identifier, index, all) => identifier !== all[index - 1]);

  return (await getBacklog(projectName)).map((issue) => ({
    id: issue.identifier,
    title: issue.title,
    description: issue.description,
    labels: issue.labels.nodes.map((label) => label.name).sort((a, b) => a.localeCompare(b)),
    priority: issue.priority ?? null,
    estimate: issue.estimate ?? null,
    state: issue.state.name,
    blocks: blockingRelationIds(issue),
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

function toCacheTask(record: BacklogRecord): FingerprintableTask {
  return {
    id: record.id,
    title: record.title,
    description: record.description,
    labels: record.labels,
    priority: record.priority,
    estimate: record.estimate,
    state: record.state,
    blocks: record.blocks,
  };
}

function dedupeDependencyEdges(edges: DependencyEdge[]): DependencyEdge[] {
  const deduped = new Map<string, DependencyEdge>();

  for (const edge of edges) {
    const key = `${edge.type}\u0000${edge.from}\u0000${edge.to}`;
    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, edge);
      continue;
    }

    if (existing.source === 'explicit') continue;
    if (edge.source === 'explicit') {
      deduped.set(key, edge);
    }
  }

  return [...deduped.values()].sort((a, b) => {
    const typeCompare = a.type.localeCompare(b.type);
    if (typeCompare !== 0) return typeCompare;
    const fromCompare = compareTaskIds(a.from, b.from);
    if (fromCompare !== 0) return fromCompare;
    return compareTaskIds(a.to, b.to);
  });
}

runTool({
  name: 'plan-queue',
  description: 'Plan read-only task dependency queues from backlog JSON',
  options: {
    'backlog-file': { type: 'string', description: 'Read backlog JSON array from a file' },
    stdin: { type: 'boolean', description: 'Read backlog JSON array from stdin' },
    project: { type: 'string', description: 'Fetch backlog from Linear project name' },
    'cache-key': { type: 'string', description: 'Cache key slug for file/stdin backlog modes' },
    'no-cache': { type: 'boolean', description: 'Disable task dependency cache reads and writes' },
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

    const cacheKey = args.project ? toKebabCase(args.project) : args['cache-key'];
    const shouldUseCache = !args['no-cache'] && typeof cacheKey === 'string' && cacheKey.length > 0;
    const records = args['backlog-file']
      ? readBacklogFile(args['backlog-file'])
      : args.stdin
      ? parseBacklogJson(readFileSync(0, 'utf8'), 'stdin')
      : await loadBacklogFromLinear(args.project);
    const fingerprintTasks = records.map(toCacheTask);
    let cacheBeforePrune: CacheFile | undefined = undefined;
    if (shouldUseCache) {
      try {
        cacheBeforePrune = loadCache(process.cwd(), cacheKey);
      } catch (error) {
        process.stderr.write(`plan-queue: invalid cache key "${cacheKey}": ${(error as Error).message}\n`);
        process.exit(2);
      }
    }
    const cacheAfterPrune = cacheBeforePrune ? pruneCache(cacheBeforePrune, fingerprintTasks) : undefined;
    const explicitEdges = extractEdgesFromBacklog(records);
    const backlogDiff = cacheBeforePrune ? computeBacklogDiff(cacheBeforePrune.fingerprints, fingerprintTasks) : undefined;
    const shouldRunPartialRefresh =
      cacheBeforePrune !== undefined &&
      Object.keys(cacheBeforePrune.fingerprints).length > 0 &&
      backlogDiff !== undefined &&
      backlogDiff.added.length + backlogDiff.changed.length > 0 &&
      backlogDiff.added.length + backlogDiff.changed.length < records.length;

    let cacheToSave = cacheAfterPrune;
    let inferredEdges: DependencyEdge[] = cacheAfterPrune ? cachedEdgesToDependencyEdges(cacheAfterPrune.edges) : [];

    if (shouldRunPartialRefresh && cacheAfterPrune && backlogDiff) {
      const changedTaskIds = new Set([...backlogDiff.added, ...backlogDiff.changed]);
      const removedTaskIds = new Set([...backlogDiff.completed, ...backlogDiff.removed]);
      const contextTaskIds = assembleNearbyContext({ changedTaskIds, allBacklog: records });
      const taskById = new Map(records.map((record) => [record.id, record]));
      const contextTasks = contextTaskIds
        .map((taskId) => taskById.get(taskId))
        .filter((record): record is BacklogRecord => record !== undefined);
      const [{ callLLM }, { loadPromptTemplate }] = await Promise.all([
        import('../shared/lib/llm-cli.ts'),
        import('../shared/lib/prompt-utils.ts'),
      ]);
      const promptTemplate = await loadPromptTemplate('tools/prompts/queue-analysis.md');
      const prompt = buildPartialRefreshPrompt({
        changedTaskIds,
        contextTasks,
        template: promptTemplate,
      });
      const llmResult = await callLLM(prompt, { taskType: 'classify', repoDir: process.cwd() });
      const fingerprintMap = new Map(Object.entries(cacheAfterPrune.fingerprints));
      const freshEdges = parseQueueAnalysisEdges(llmResult.text, changedTaskIds, fingerprintMap);
      const mergedCachedEdges = mergeEdges(cacheAfterPrune.edges, freshEdges, { changedTaskIds, removedTaskIds });
      inferredEdges = cachedEdgesToDependencyEdges(mergedCachedEdges);
      cacheToSave = {
        ...cacheAfterPrune,
        edges: mergedCachedEdges,
      };
    }

    const edges = dedupeDependencyEdges([...explicitEdges, ...inferredEdges]);
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
      if (cacheBeforePrune && cacheAfterPrune) {
        const cacheStats = getCacheStats(cacheBeforePrune, cacheAfterPrune);
        process.stderr.write(`cache: hits=0 misses=0 pruned=${cacheStats.totalEdges - cacheStats.retainedEdges}\n`);
      }
    }
    if (cacheToSave && cacheKey) {
      await saveCache(process.cwd(), cacheKey, cacheToSave);
    }
  },
});
