export const PROMPT_COMPONENT_IDS = [
  'task_prompt',
  'pr_review_output',
  'intervention_metadata',
  'task_packet',
  'plan_content',
  'self_review_summary',
  'template_static',
] as const;

export type PromptComponentId = (typeof PROMPT_COMPONENT_IDS)[number];

export interface PromptSizeMeasurement {
  totalBytes: number;
  componentBytes: Record<PromptComponentId, number>;
}

export interface PromptTruncationOptions {
  softLimitBytes: number;
  perComponentMaxBytes: number;
  truncatableComponents?: PromptComponentId[];
}

export interface PromptTruncationResult {
  components: Record<PromptComponentId, string>;
  measurement: PromptSizeMeasurement;
  truncated: boolean;
  truncationSummary: Partial<Record<PromptComponentId, number>>;
}

export interface PromptSizeDiagnostics {
  prompt_bytes?: number;
  prompt_component_bytes?: Record<string, number>;
  prompt_truncated?: boolean;
  prompt_truncation_summary?: Record<string, number>;
  prompt_size_limit_bytes?: number;
  prompt_soft_limit_bytes?: number;
}

const DEFAULT_TRUNCATABLE_COMPONENTS: PromptComponentId[] = [
  'pr_review_output',
  'task_packet',
  'plan_content',
  'self_review_summary',
  'task_prompt',
  'intervention_metadata',
];

export function byteLengthUtf8(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

export function measurePromptComponents(
  components: Record<PromptComponentId, string>,
): PromptSizeMeasurement {
  const componentBytes = Object.fromEntries(
    PROMPT_COMPONENT_IDS.map((componentId) => [componentId, byteLengthUtf8(components[componentId])]),
  ) as Record<PromptComponentId, number>;

  const totalBytes = Object.values(componentBytes).reduce((sum, value) => sum + value, 0);
  return { totalBytes, componentBytes };
}

export function checkPromptSize(
  totalBytes: number,
  hardLimitBytes: number,
): 'ok' | 'over_hard_limit' {
  return totalBytes <= hardLimitBytes ? 'ok' : 'over_hard_limit';
}

export function truncatePromptComponents(
  components: Record<PromptComponentId, string>,
  options: PromptTruncationOptions,
): PromptTruncationResult {
  const nextComponents: Record<PromptComponentId, string> = { ...components };
  const truncationSummary: Partial<Record<PromptComponentId, number>> = {};
  const truncatableComponents = new Set(
    options.truncatableComponents ?? DEFAULT_TRUNCATABLE_COMPONENTS,
  );

  let measurement = measurePromptComponents(nextComponents);

  while (measurement.totalBytes > options.softLimitBytes) {
    const candidates = DEFAULT_TRUNCATABLE_COMPONENTS
      .filter((componentId) => truncatableComponents.has(componentId))
      .map((componentId) => ({
        componentId,
        byteLength: measurement.componentBytes[componentId],
      }))
      .filter(({ byteLength }) => byteLength > 0)
      .sort((left, right) => right.byteLength - left.byteLength);

    if (candidates.length === 0) {
      break;
    }

    const { componentId, byteLength } = candidates[0];
    const reductionNeeded = measurement.totalBytes - options.softLimitBytes;
    const targetBytes = Math.max(
      1,
      Math.min(options.perComponentMaxBytes, byteLength - reductionNeeded),
    );

    if (targetBytes >= byteLength) {
      break;
    }

    const truncatedValue = truncateStringToByteLimit(
      nextComponents[componentId],
      targetBytes,
      componentId,
      byteLength,
    );

    const truncatedBytes = byteLengthUtf8(truncatedValue);
    if (truncatedBytes >= byteLength) {
      break;
    }

    nextComponents[componentId] = truncatedValue;
    truncationSummary[componentId] = byteLength - truncatedBytes;
    measurement = measurePromptComponents(nextComponents);
  }

  return {
    components: nextComponents,
    measurement,
    truncated: Object.keys(truncationSummary).length > 0,
    truncationSummary,
  };
}

function truncateStringToByteLimit(
  value: string,
  maxBytes: number,
  componentId: PromptComponentId,
  originalBytes: number,
): string {
  if (byteLengthUtf8(value) <= maxBytes) {
    return value;
  }

  const marker = `[TRUNCATED: ${Math.max(0, originalBytes - maxBytes)} bytes omitted from ${componentId}]`;
  const markerBytes = byteLengthUtf8(marker);
  if (markerBytes >= maxBytes) {
    return takeUtf8Prefix(marker, maxBytes);
  }

  const remainingBytes = maxBytes - markerBytes;
  let headBytes = Math.ceil(remainingBytes / 2);
  let tailBytes = Math.floor(remainingBytes / 2);
  let head = takeUtf8Prefix(value, headBytes);
  let tail = takeUtf8Suffix(value, tailBytes);
  let candidate = `${head}${marker}${tail}`;

  while (byteLengthUtf8(candidate) > maxBytes && tailBytes > 0) {
    tailBytes -= 1;
    tail = takeUtf8Suffix(value, tailBytes);
    candidate = `${head}${marker}${tail}`;
  }

  while (byteLengthUtf8(candidate) > maxBytes && headBytes > 0) {
    headBytes -= 1;
    head = takeUtf8Prefix(value, headBytes);
    candidate = `${head}${marker}${tail}`;
  }

  return candidate;
}

function takeUtf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return '';
  }

  const buffer = Buffer.from(value, 'utf8');
  if (buffer.length <= maxBytes) {
    return value;
  }

  let end = maxBytes;
  while (end > 0) {
    const candidate = buffer.subarray(0, end).toString('utf8');
    if (byteLengthUtf8(candidate) <= maxBytes) {
      return candidate;
    }
    end -= 1;
  }

  return '';
}

function takeUtf8Suffix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return '';
  }

  const buffer = Buffer.from(value, 'utf8');
  if (buffer.length <= maxBytes) {
    return value;
  }

  let start = buffer.length - maxBytes;
  while (start < buffer.length) {
    const candidate = buffer.subarray(start).toString('utf8');
    if (byteLengthUtf8(candidate) <= maxBytes) {
      return candidate;
    }
    start += 1;
  }

  return '';
}
