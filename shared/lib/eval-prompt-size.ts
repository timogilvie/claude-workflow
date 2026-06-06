/**
 * Eval prompt byte-size enforcement.
 *
 * The Claude CLI input path fails before judge invocation when stdin is too
 * large. Keep this module pure so eval code can decide whether to fail fast or
 * send a compressed prompt without touching provider code.
 */

export type EvalPromptComponentName =
  | 'taskPrompt'
  | 'prReviewOutput'
  | 'interventionMetadata'
  | 'taskPacket'
  | 'planContent'
  | 'selfReviewSummary'
  | 'templateScaffold';

export type EvalOversizePolicy = 'fail' | 'truncate';
export type PromptSizeAction = 'pass' | 'truncated' | 'rejected';

export interface TruncatedPromptComponent {
  name: EvalPromptComponentName;
  originalBytes: number;
  finalBytes: number;
  removedBytes: number;
}

export interface PromptSizeDiagnostic {
  totalBytes: number;
  limitBytes: number;
  perComponentBytes: Record<EvalPromptComponentName, number>;
  policy: EvalOversizePolicy;
  action: PromptSizeAction;
  truncatedComponents?: TruncatedPromptComponent[];
}

export type PromptComponents = Partial<Record<EvalPromptComponentName, string>>;

export interface PromptSizeEnforcementResult {
  action: PromptSizeAction;
  components: PromptComponents;
  diagnostic: PromptSizeDiagnostic;
}

export interface PromptSizeConfig {
  limitBytes: number;
  policy: EvalOversizePolicy;
}

export interface EvalPromptSizeEnv {
  EVAL_MAX_PROMPT_BYTES?: string;
  EVAL_OVERSIZE_POLICY?: string;
}

export const DEFAULT_EVAL_MAX_PROMPT_BYTES = 9 * 1024 * 1024;
export const DEFAULT_EVAL_OVERSIZE_POLICY: EvalOversizePolicy = 'fail';

export const DEFAULT_TRUNCATION_ORDER: readonly EvalPromptComponentName[] = [
  'prReviewOutput',
  'taskPacket',
  'planContent',
  'selfReviewSummary',
  'taskPrompt',
];

const COMPONENT_NAMES: readonly EvalPromptComponentName[] = [
  'taskPrompt',
  'prReviewOutput',
  'interventionMetadata',
  'taskPacket',
  'planContent',
  'selfReviewSummary',
  'templateScaffold',
];

const MIN_PROMPT_LIMIT_BYTES = 1024;

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function emptyComponentBytes(): Record<EvalPromptComponentName, number> {
  return {
    taskPrompt: 0,
    prReviewOutput: 0,
    interventionMetadata: 0,
    taskPacket: 0,
    planContent: 0,
    selfReviewSummary: 0,
    templateScaffold: 0,
  };
}

export function measurePromptComponents(
  components: PromptComponents,
): { totalBytes: number; perComponentBytes: Record<EvalPromptComponentName, number> } {
  const perComponentBytes = emptyComponentBytes();
  let totalBytes = 0;

  for (const name of COMPONENT_NAMES) {
    const bytes = byteLength(components[name] ?? '');
    perComponentBytes[name] = bytes;
    totalBytes += bytes;
  }

  return { totalBytes, perComponentBytes };
}

export function resolveEvalPromptSizeConfig(evalConfig: {
  maxPromptBytes?: unknown;
  oversizePolicy?: unknown;
} = {}): PromptSizeConfig {
  const limitBytes = evalConfig.maxPromptBytes ?? DEFAULT_EVAL_MAX_PROMPT_BYTES;
  if (
    typeof limitBytes !== 'number' ||
    !Number.isFinite(limitBytes) ||
    limitBytes < MIN_PROMPT_LIMIT_BYTES
  ) {
    throw new Error(
      `Invalid eval.maxPromptBytes: expected a finite number >= ${MIN_PROMPT_LIMIT_BYTES}.`,
    );
  }

  const policy = evalConfig.oversizePolicy ?? DEFAULT_EVAL_OVERSIZE_POLICY;
  if (policy !== 'fail' && policy !== 'truncate') {
    throw new Error('Invalid eval.oversizePolicy: expected "fail" or "truncate".');
  }

  return {
    limitBytes: Math.floor(limitBytes),
    policy,
  };
}

export function applyEvalPromptSizeEnv(
  evalConfig: { maxPromptBytes?: unknown; oversizePolicy?: unknown } = {},
  env: EvalPromptSizeEnv = {},
): { maxPromptBytes?: unknown; oversizePolicy?: unknown } {
  const next = { ...evalConfig };

  if (env.EVAL_MAX_PROMPT_BYTES !== undefined && env.EVAL_MAX_PROMPT_BYTES.trim() !== '') {
    const parsed = Number(env.EVAL_MAX_PROMPT_BYTES);
    next.maxPromptBytes = parsed;
  }

  if (env.EVAL_OVERSIZE_POLICY !== undefined && env.EVAL_OVERSIZE_POLICY.trim() !== '') {
    next.oversizePolicy = env.EVAL_OVERSIZE_POLICY;
  }

  return next;
}

function makeMarker(name: EvalPromptComponentName, removedBytes: number): string {
  return `\n[... TRUNCATED ${Math.max(0, removedBytes)} bytes from ${name} ...]\n`;
}

function prefixWithinByteBudget(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (byteLength(text) <= maxBytes) return text;

  let low = 0;
  let high = text.length;
  let best = '';
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = text.slice(0, mid);
    if (byteLength(candidate) <= maxBytes) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

function truncateComponentToTargetBytes(
  text: string,
  name: EvalPromptComponentName,
  targetBytes: number,
): string {
  const originalBytes = byteLength(text);
  if (originalBytes <= targetBytes) return text;

  let kept = prefixWithinByteBudget(text, targetBytes);
  for (let i = 0; i < 8; i++) {
    const keptBytes = byteLength(kept);
    const marker = makeMarker(name, originalBytes - keptBytes);
    const remainingForContent = targetBytes - byteLength(marker);
    const nextKept = prefixWithinByteBudget(text, remainingForContent);
    if (nextKept === kept) {
      return `${kept}${marker}`;
    }
    kept = nextKept;
  }

  const keptBytes = byteLength(kept);
  return `${kept}${makeMarker(name, originalBytes - keptBytes)}`;
}

function diagnosticFor(
  components: PromptComponents,
  limitBytes: number,
  policy: EvalOversizePolicy,
  action: PromptSizeAction,
  truncatedComponents?: TruncatedPromptComponent[],
): PromptSizeDiagnostic {
  const measured = measurePromptComponents(components);
  return {
    totalBytes: measured.totalBytes,
    limitBytes,
    perComponentBytes: measured.perComponentBytes,
    policy,
    action,
    ...(truncatedComponents && truncatedComponents.length > 0
      ? { truncatedComponents }
      : {}),
  };
}

export function enforcePromptSizeLimit({
  components,
  limitBytes,
  policy,
  truncationOrder = DEFAULT_TRUNCATION_ORDER,
}: {
  components: PromptComponents;
  limitBytes: number;
  policy: EvalOversizePolicy;
  truncationOrder?: readonly EvalPromptComponentName[];
}): PromptSizeEnforcementResult {
  const config = resolveEvalPromptSizeConfig({
    maxPromptBytes: limitBytes,
    oversizePolicy: policy,
  });
  const initial = measurePromptComponents(components);
  if (initial.totalBytes <= config.limitBytes) {
    return {
      action: 'pass',
      components,
      diagnostic: diagnosticFor(components, config.limitBytes, config.policy, 'pass'),
    };
  }

  if (config.policy === 'fail') {
    return {
      action: 'rejected',
      components,
      diagnostic: diagnosticFor(components, config.limitBytes, config.policy, 'rejected'),
    };
  }

  const nextComponents: PromptComponents = { ...components };
  const truncatedComponents: TruncatedPromptComponent[] = [];

  for (const name of truncationOrder) {
    const currentValue = nextComponents[name] ?? '';
    const originalBytes = byteLength(currentValue);
    if (originalBytes === 0) continue;

    const currentTotal = measurePromptComponents(nextComponents).totalBytes;
    if (currentTotal <= config.limitBytes) break;

    const targetBytes = Math.max(0, originalBytes - (currentTotal - config.limitBytes));
    const truncated = truncateComponentToTargetBytes(currentValue, name, targetBytes);
    nextComponents[name] = truncated;
    const finalBytes = byteLength(truncated);
    truncatedComponents.push({
      name,
      originalBytes,
      finalBytes,
      removedBytes: Math.max(0, originalBytes - finalBytes),
    });
  }

  const finalMeasured = measurePromptComponents(nextComponents);
  const action: PromptSizeAction =
    finalMeasured.totalBytes <= config.limitBytes ? 'truncated' : 'rejected';

  return {
    action,
    components: nextComponents,
    diagnostic: diagnosticFor(
      nextComponents,
      config.limitBytes,
      config.policy,
      action,
      truncatedComponents,
    ),
  };
}
