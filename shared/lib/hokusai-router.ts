/**
 * Hokusai-backed workflow router integration.
 *
 * @module hokusai-router
 */

import { getHokusaiRouterConfig } from './config.ts';
import { errorMessage } from './error-utils.ts';
import { fromHokusaiOutput } from './hokusai-adapter.ts';
import {
  toHokusaiInput,
  type HokusaiOutput,
  type HokusaiPredictions,
  type HokusaiRoute,
} from './hokusai-schema.ts';
import { buildTaskDescriptor } from './task-descriptor-builder.ts';
import type { WorkflowRouteDecision } from './workflow-router.ts';

export interface HokusaiRouterOptions {
  repoDir?: string;
  modelsAvailable?: string[];
  maxCostUsd?: number;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isHokusaiRoute(value: unknown): value is HokusaiRoute {
  return Boolean(
    value &&
    typeof value === 'object' &&
    typeof (value as HokusaiRoute).planner_model === 'string' &&
    typeof (value as HokusaiRoute).coder_model === 'string' &&
    typeof (value as HokusaiRoute).reviewer_model === 'string' &&
    ['low', 'medium', 'high'].includes((value as HokusaiRoute).plan_depth) &&
    ['low', 'medium', 'high'].includes((value as HokusaiRoute).code_depth) &&
    ['light', 'standard', 'deep'].includes((value as HokusaiRoute).review_mode)
  );
}

function isHokusaiPredictions(value: unknown): value is HokusaiPredictions {
  return Boolean(
    value &&
    typeof value === 'object' &&
    isFiniteNumber((value as HokusaiPredictions).expected_success_probability) &&
    isFiniteNumber((value as HokusaiPredictions).expected_cost_usd) &&
    isFiniteNumber((value as HokusaiPredictions).confidence)
  );
}

export function isHokusaiOutput(value: unknown): value is HokusaiOutput {
  return Boolean(
    value &&
    typeof value === 'object' &&
    typeof (value as HokusaiOutput).schema_version === 'string' &&
    isHokusaiRoute((value as HokusaiOutput).route) &&
    isHokusaiPredictions((value as HokusaiOutput).predictions)
  );
}

export async function routeViaHokusai(
  prompt: string,
  options: HokusaiRouterOptions = {},
): Promise<WorkflowRouteDecision | null> {
  const repoDir = options.repoDir;
  const config = getHokusaiRouterConfig(repoDir);
  const endpoint = config.endpoint;

  if (!endpoint) {
    return null;
  }

  const descriptor = buildTaskDescriptor({
    originalPrompt: prompt,
    modelsAvailable: options.modelsAvailable,
    maxCostUsd: options.maxCostUsd,
  });
  const input = toHokusaiInput(
    descriptor,
    descriptor.repoContext,
    {
      modelsAvailable: options.modelsAvailable,
      maxCostUsd: options.maxCostUsd,
    },
    'workflow-route',
  );

  const controller = new AbortController();
  const timeoutMs = config.timeout ?? 5000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        ...input,
        backend: config.backend ?? 'local',
        ...(config.backend !== 'remote' && config.modelPath
          ? { model_path: config.modelPath }
          : {}),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
    }

    const payload: unknown = await response.json();
    if (!isHokusaiOutput(payload)) {
      throw new Error('Invalid Hokusai response shape');
    }

    const decision = fromHokusaiOutput(payload, { repoDir });
    if (typeof options.maxCostUsd === 'number') {
      decision.constraints = { maxCostUsd: options.maxCostUsd };
    }
    return decision;
  } catch (error) {
    console.warn(`[hokusai-router] Hokusai routing failed: ${errorMessage(error)}`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
