export const DISABLED_MODEL_IDS = new Set<string>([
  'gpt-5.3-codex',
]);

export function isDisabledModel(modelId: string | undefined | null): boolean {
  return typeof modelId === 'string' && DISABLED_MODEL_IDS.has(modelId);
}

export function filterDisabledModels<T extends string>(models: T[]): T[] {
  return models.filter((model) => !isDisabledModel(model));
}
