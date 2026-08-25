/**
 * Models excluded from every automatic selection path.
 *
 * `filterDisabledModels` is applied by challenge-mode, challenge-scheduler,
 * stage-aware-router, workflow-router, execution-contract and model-registry,
 * so an entry here is removed as a planner, coder, reviewer and challenger
 * alike. It does not remove the model from the registry: identity, pricing and
 * audit history are preserved, and re-enabling is a one-line revert.
 *
 * Prefer this over `routingEligible: false` in the registry when the goal is to
 * stop a model being chosen. Challenger selection draws its candidate pool from
 * `filterDisabledModels`, not from the registry's routing eligibility, so
 * `routingEligible` alone does not remove a model from challenge work.
 */
export const DISABLED_MODEL_IDS = new Set<string>([
  'gpt-5.3-codex',
  // Disabled 2026-08-25 pending HOK-2885. Stalled with
  // `provider-transient-error: Upstream idle timeout exceeded` on 5 of 7 recent
  // challenger launches -- the most-selected challenger and the least reliable.
  // The stall is provider-side (OpenRouter tearing down an idle upstream
  // mid-stream), not a quality problem, so this is a reliability hold rather
  // than a judgement on the model's output. Revisit once HOK-2885 lands
  // retry-on-transient, which may make it viable again.
  'llama-4-maverick',
]);

export function isDisabledModel(modelId: string | undefined | null): boolean {
  return typeof modelId === 'string' && DISABLED_MODEL_IDS.has(modelId);
}

export function filterDisabledModels<T extends string>(models: T[]): T[] {
  return models.filter((model) => !isDisabledModel(model));
}
