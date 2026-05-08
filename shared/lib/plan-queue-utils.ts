import type { DependencyEdge, PlanResult, TriageRecord } from './task-dependency-planner.ts';

export type BacklogRecord = {
  id: string;
  title?: string;
  dependsOn?: string[];
  sharedSurface?: string[];
  [key: string]: unknown;
};

export type QueuePlan = {
  availableNow: string[];
  queuedAfterDependencies: Array<{ taskId: string; ancestors: string[] }>;
  avoidRunningTogether: string[][];
  needsTriage: TriageRecord[];
};

export type TaskWithScore = {
  id: string;
  score: number;
};

export type WaveSelection = {
  wave: string[];
  deferred: string[];
};

export const compareTaskIds = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

export function parseBacklogJson(raw: string, source: string): BacklogRecord[] {
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

export function extractEdgesFromBacklog(records: BacklogRecord[]): DependencyEdge[] {
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

export function clusterSharedSurface(edges: DependencyEdge[]): string[][] {
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

export function buildQueuePlan(edges: DependencyEdge[], result: PlanResult): QueuePlan {
  const normalizeId = (id: string) => id.trim().toUpperCase();
  const knownTaskIds = new Set(result.queues.map((queue) => normalizeId(queue.taskId)));
  const externalBlockersByTask = new Map<string, Set<string>>();

  const displayableTriage = result.triage.filter((record) => {
    if (record.reason === 'duplicate') {
      return false;
    }
    if (
      record.reason === 'unknown_endpoint' &&
      record.edge.type === 'depends_on' &&
      knownTaskIds.has(normalizeId(record.edge.to)) &&
      !knownTaskIds.has(normalizeId(record.edge.from))
    ) {
      const taskId = normalizeId(record.edge.to);
      if (!externalBlockersByTask.has(taskId)) {
        externalBlockersByTask.set(taskId, new Set<string>());
      }
      externalBlockersByTask.get(taskId)?.add(record.edge.from);
      return false;
    }
    return true;
  });

  const triagedTaskIds = new Set(displayableTriage.flatMap((record) => [record.edge.from, record.edge.to]).map(normalizeId));
  const queues = result.queues.filter((queue) => !triagedTaskIds.has(normalizeId(queue.taskId)));
  const availableNow = queues
    .filter((queue) => queue.ancestors.length === 0 && !externalBlockersByTask.has(normalizeId(queue.taskId)))
    .map((queue) => queue.taskId);
  const queuedAfterDependencies = queues
    .map((queue) => {
      const hiddenBlockers = externalBlockersByTask.get(normalizeId(queue.taskId)) ?? new Set<string>();
      const ancestors = [...new Set([...queue.ancestors, ...hiddenBlockers])];
      return { taskId: queue.taskId, ancestors };
    })
    .filter((queue) => queue.ancestors.length > 0);
  const nonTriagedEdges = edges.filter((edge) => !triagedTaskIds.has(normalizeId(edge.from)) && !triagedTaskIds.has(normalizeId(edge.to)));
  return {
    availableNow,
    queuedAfterDependencies,
    avoidRunningTogether: clusterSharedSurface(nonTriagedEdges),
    needsTriage: displayableTriage,
  };
}

export function selectFirstWave(
  plan: QueuePlan,
  scoredTasks: TaskWithScore[],
  opts: { maxParallel: number }
): WaveSelection {
  if (!Array.isArray(plan.availableNow)) {
    throw new TypeError('Queue plan must include availableNow');
  }

  if (!Number.isInteger(opts.maxParallel) || opts.maxParallel < 0) {
    throw new RangeError('maxParallel must be a non-negative integer');
  }

  if (opts.maxParallel === 0) {
    return { wave: [], deferred: [...plan.availableNow] };
  }

  const scoreById = new Map(scoredTasks.map((task) => [task.id, task.score]));
  const available = plan.availableNow
    .map((id) => ({ id, score: scoreById.get(id) ?? 0 }))
    .sort((a, b) => b.score - a.score || compareTaskIds(a.id, b.id));

  const clusterById = new Map<string, number>();
  for (const [index, group] of (plan.avoidRunningTogether ?? []).entries()) {
    for (const taskId of group) {
      clusterById.set(taskId, index);
    }
  }

  const usedClusters = new Set<number>();
  const wave: string[] = [];
  const deferred: string[] = [];

  for (const task of available) {
    const cluster = clusterById.get(task.id);
    if (wave.length < opts.maxParallel && (cluster === undefined || !usedClusters.has(cluster))) {
      wave.push(task.id);
      if (cluster !== undefined) {
        usedClusters.add(cluster);
      }
      continue;
    }
    deferred.push(task.id);
  }

  return { wave, deferred };
}
