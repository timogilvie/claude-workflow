import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getHokusaiRouterConfig } from './config.ts';
import { getCurrentOperatingMode, type OperatingMode } from './operating-mode.ts';
import { loadStageAwareRouterContext, type StageAwareRouterContext } from './stage-aware-router.ts';
import {
  readTaskPromptFromFile,
  routeWorkflow,
  routeWorkflowAutoWithContext,
  routeWorkflowDegradedWithContext,
  routeWorkflowHokusai,
  routeWorkflowStageAwareWithContext,
  type RouteWorkflowOptions,
  type WorkflowRouteDecision,
} from './workflow-router.ts';

export interface RouteBatchTask {
  issueId?: string;
  prompt: string;
  file?: string;
}

export interface RouteBatchPlanTask {
  issue?: string;
  issueId?: string;
  taskPacketFile?: string;
  prompt?: string;
}

export interface RouteBatchOptions extends RouteWorkflowOptions {
  repoDir?: string;
  mode?: 'auto' | 'stage-aware' | 'heuristic' | 'hokusai';
  operatingMode?: OperatingMode;
}

export interface RouteBatchResult {
  task: RouteBatchTask;
  decision: WorkflowRouteDecision;
}

function resolveWavemillRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

export function getWavemillAdditionalEvalPaths(repoDir: string): string[] {
  const wavemillRoot = resolveWavemillRoot();
  if (resolve(repoDir) === resolve(wavemillRoot)) {
    return [];
  }

  const additionalEvalsPaths: string[] = [];
  const aggregatedPath = resolve(wavemillRoot, '.wavemill/evals/aggregated-evals.jsonl');
  const backfilledPath = resolve(wavemillRoot, '.wavemill/evals/aggregated-evals.backfilled.jsonl');

  if (existsSync(aggregatedPath)) {
    additionalEvalsPaths.push(aggregatedPath);
  }
  if (existsSync(backfilledPath)) {
    additionalEvalsPaths.push(backfilledPath);
  }

  return additionalEvalsPaths;
}

export function resolveRouteBatchTask(task: {
  issueId?: string;
  prompt?: string;
  file?: string;
}): RouteBatchTask {
  if (task.file) {
    return {
      issueId: task.issueId,
      file: task.file,
      prompt: readTaskPromptFromFile(task.file),
    };
  }

  if (typeof task.prompt === 'string') {
    return {
      issueId: task.issueId,
      prompt: task.prompt,
    };
  }

  throw new Error(`Task${task.issueId ? ` ${task.issueId}` : ''} is missing both prompt and file`);
}

export function tasksFromPlan(plan: unknown): RouteBatchTask[] {
  const items = Array.isArray(plan)
    ? plan
    : Array.isArray((plan as { tasks?: unknown[] })?.tasks)
      ? (plan as { tasks: unknown[] }).tasks
      : null;

  if (!items) {
    throw new Error('Plan input must be an array or an object with a tasks array');
  }

  return items.map((task, index) => {
    if (!task || typeof task !== 'object') {
      throw new Error(`Plan task at index ${index} is not an object`);
    }

    const planTask = task as RouteBatchPlanTask;
    return resolveRouteBatchTask({
      issueId: planTask.issueId || planTask.issue,
      prompt: planTask.prompt,
      file: planTask.taskPacketFile,
    });
  });
}

function buildRouteBatchWorkflowOptions(options: RouteBatchOptions): RouteBatchOptions {
  const repoDir = options.repoDir || process.cwd();
  return {
    ...options,
    repoDir,
    additionalEvalsPaths: options.additionalEvalsPaths ?? getWavemillAdditionalEvalPaths(repoDir),
  };
}

function shouldLoadStageAwareContext(
  mode: NonNullable<RouteBatchOptions['mode']>,
  repoDir: string,
): boolean {
  if (mode === 'stage-aware') {
    return true;
  }

  if (mode !== 'auto') {
    return false;
  }

  return !Boolean(getHokusaiRouterConfig(repoDir).endpoint);
}

async function routeTaskInBatch(
  prompt: string,
  options: RouteBatchOptions,
  operatingMode: OperatingMode | undefined,
  stageAwareContext: StageAwareRouterContext | undefined,
): Promise<WorkflowRouteDecision> {
  const mode = options.mode || 'auto';

  if (mode === 'heuristic') {
    return routeWorkflow(prompt, options);
  }

  if (mode === 'stage-aware') {
    if (!stageAwareContext) {
      throw new Error('Stage-aware context was not prepared for stage-aware batch routing');
    }
    return routeWorkflowStageAwareWithContext(prompt, options, stageAwareContext);
  }

  if (mode === 'hokusai') {
    return routeWorkflowHokusai(prompt, options);
  }

  if (operatingMode === 'constrained' || operatingMode === 'survival') {
    if (!stageAwareContext) {
      throw new Error(`Stage-aware context was not prepared for ${operatingMode} batch routing`);
    }
    return routeWorkflowDegradedWithContext(prompt, options, operatingMode, stageAwareContext);
  }

  return routeWorkflowAutoWithContext(prompt, options, {
    operatingMode,
    stageAwareContext,
  });
}

export async function routeBatch(
  tasks: Array<{ issueId?: string; prompt?: string; file?: string }>,
  options: RouteBatchOptions = {},
): Promise<RouteBatchResult[]> {
  const resolvedOptions = buildRouteBatchWorkflowOptions(options);
  const repoDir = resolvedOptions.repoDir || process.cwd();
  const mode = resolvedOptions.mode || 'auto';
  const resolvedTasks = tasks.map((task) => resolveRouteBatchTask(task));

  let operatingMode: OperatingMode | undefined;
  if (mode === 'auto') {
    operatingMode = resolvedOptions.operatingMode ?? getCurrentOperatingMode(repoDir);
  }

  const stageAwareContext = shouldLoadStageAwareContext(mode, repoDir)
    ? loadStageAwareRouterContext(resolvedOptions)
    : undefined;

  const results: RouteBatchResult[] = [];
  for (const task of resolvedTasks) {
    const decision = await routeTaskInBatch(task.prompt, resolvedOptions, operatingMode, stageAwareContext);
    results.push({ task, decision });
  }

  return results;
}
