// ---------------------------------------------------------------------------
// Per-turn output ceilings for native agent phases.
//
// Every native request must carry an explicit `max_tokens`. Pi omits the field
// entirely when the stream options leave `maxTokens` undefined, and OpenRouter
// then pre-authorizes the routed endpoint's *full* max completion length
// against the account balance before generating a token. For a model like
// glm-5.2 that reserves ~65k output tokens per request, which returns
//
//   402 This request requires more credits, or fewer max_tokens.
//   You requested up to 65536 tokens, but can only afford N.
//
// long before real usage justifies it. Sending a bounded ceiling keeps the
// reservation proportional to what a turn actually emits.
//
// Values above a model's own ceiling are clamped by OpenRouter rather than
// rejected, so these constants are safe across the native-eligible fleet even
// where an individual model caps output lower.
// ---------------------------------------------------------------------------

/** Fallback ceiling for any phase that does not set its own (planning, task expansion). */
export const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;

/** Coding turns can emit whole-file writes, so they get the widest ceiling. */
export const CODING_MAX_OUTPUT_TOKENS = 32_768;

/** Review turns emit a concise JSON verdict and need far less headroom. */
export const REVIEW_MAX_OUTPUT_TOKENS = 8_192;

export interface DynamicOutputReservationInput {
  inputTokens: number;
  contextWindowTokens: number;
  phaseCeiling: number;
  minOutputTokens?: number;
  safetyMarginPct?: number;
}

const DEFAULT_MIN_OUTPUT_TOKENS = 1_024;
const DEFAULT_OUTPUT_SAFETY_MARGIN_PCT = 5;

export function computeDynamicMaxTokens(input: DynamicOutputReservationInput): number {
  const minOutputTokens = input.minOutputTokens ?? DEFAULT_MIN_OUTPUT_TOKENS;
  const safetyMarginPct = input.safetyMarginPct ?? DEFAULT_OUTPUT_SAFETY_MARGIN_PCT;
  validatePositiveInteger(input.inputTokens, 'inputTokens', { allowZero: true });
  validatePositiveInteger(input.contextWindowTokens, 'contextWindowTokens');
  validatePositiveInteger(input.phaseCeiling, 'phaseCeiling');
  validatePositiveInteger(minOutputTokens, 'minOutputTokens');
  if (!Number.isFinite(safetyMarginPct) || safetyMarginPct < 0 || safetyMarginPct > 100) {
    throw new Error('safetyMarginPct must be between 0 and 100');
  }

  const usableWindow = Math.floor(input.contextWindowTokens * (1 - (safetyMarginPct / 100)));
  const available = usableWindow - input.inputTokens;
  const effectiveMinimum = Math.min(minOutputTokens, input.phaseCeiling);
  return Math.max(effectiveMinimum, Math.min(input.phaseCeiling, available));
}

function validatePositiveInteger(
  value: number,
  label: string,
  options: { allowZero?: boolean } = {},
): void {
  const minimum = options.allowZero === true ? 0 : 1;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < minimum) {
    throw new Error(`${label} must be ${minimum === 0 ? 'a non-negative' : 'a positive'} integer`);
  }
}
