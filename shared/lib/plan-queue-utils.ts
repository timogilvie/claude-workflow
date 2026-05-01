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
  const triagedTaskIds = new Set(
    result.triage.filter((record) => record.reason !== 'duplicate').flatMap((record) => [record.edge.from, record.edge.to]),
  );
  const queues = result.queues.filter((queue) => !triagedTaskIds.has(queue.taskId));
  const nonTriagedEdges = edges.filter((edge) => !triagedTaskIds.has(edge.from) && !triagedTaskIds.has(edge.to));
  return {
    availableNow: queues.filter((queue) => queue.ancestors.length === 0).map((queue) => queue.taskId),
    queuedAfterDependencies: queues
      .filter((queue) => queue.ancestors.length > 0)
      .map((queue) => ({ taskId: queue.taskId, ancestors: queue.ancestors })),
    avoidRunningTogether: clusterSharedSurface(nonTriagedEdges),
    needsTriage: result.triage,
  };
}
