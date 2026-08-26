/**
 * Models excluded from every automatic selection path.
 *
 * `filterDisabledModels` is applied by challenge-mode, challenge-scheduler,
 * stage-aware-router, workflow-router, execution-contract and model-registry,
 * so an entry here is removed as a planner, coder, reviewer and challenger
 * alike. It does not remove the model from the registry: identity, pricing and
 * audit history are preserved, and re-enabling is a one-line revert.
 *
 * Prefer this over `routingEligible: false` in the registry as the single
 * authoritative kill-switch. Registry eligibility flags do reach challenge
 * selection (listEffectiveModelsForStage applies explainModelSupportExclusion,
 * which checks lifecycle, stages, disabled and routingEligible), but an entry
 * here is unambiguous, greppable, and reverts in one line.
 */
export const DISABLED_MODEL_IDS = new Set<string>([
  'gpt-5.3-codex',
  // Disabled 2026-08-25 for HOK-2885. Stalled with
  // `provider-transient-error: Upstream idle timeout exceeded` on 5 of 7 recent
  // challenger launches -- the most-selected challenger and the least reliable.
  // The stall is provider-side (OpenRouter tearing down an idle upstream
  // mid-stream), not a quality problem, so this is a reliability hold rather
  // than a judgement on the model's output. HOK-2885 has since landed bounded
  // phase relaunch on transient challenger failures plus single-side abort
  // scoping, so a stall no longer costs the pair -- but at a ~71% observed
  // stall rate the retry budget would still be spent mostly on this model.
  // Re-enable only after a completion-rate review shows the upstream stalls
  // have subsided (or once challenge selection weights by observed
  // completion rate).
  'llama-4-maverick',
]);

export function isDisabledModel(modelId: string | undefined | null): boolean {
  return typeof modelId === 'string' && DISABLED_MODEL_IDS.has(modelId);
}

export function filterDisabledModels<T extends string>(models: T[]): T[] {
  return models.filter((model) => !isDisabledModel(model));
}
