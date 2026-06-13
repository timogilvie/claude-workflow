export const DISABLED_MODEL_IDS = new Set<string>([
  'gpt-5.3-codex',
  // TEMPORARY (2026-06-13): claude-fable-5 access is restricted upstream.
  // Remove this entry to re-enable once access is restored. See HOK-2198.
  // The registry default intentionally still lists Fable as the frontier
  // model (and ladder-first) — this set gates availability, not the catalog.
  'claude-fable-5',
]);

export function isDisabledModel(modelId: string | undefined | null): boolean {
  return typeof modelId === 'string' && DISABLED_MODEL_IDS.has(modelId);
}

export function filterDisabledModels<T extends string>(models: T[]): T[] {
  return models.filter((model) => !isDisabledModel(model));
}
