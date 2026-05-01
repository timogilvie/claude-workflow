export const EVAL_ERROR_CODES = {
  MALFORMED_JSON: {
    code: 'MALFORMED_JSON',
    message: 'Line is not parseable JSON.',
  },
  NOT_AN_OBJECT: {
    code: 'NOT_AN_OBJECT',
    message: 'Line parses but is not a JSON object.',
  },
  MISSING_REQUIRED_FIELD: {
    code: 'MISSING_REQUIRED_FIELD',
    message: 'Required field is absent.',
  },
  SCHEMA_VIOLATION: {
    code: 'SCHEMA_VIOLATION',
    message: 'Field value fails schema.',
  },
  INELIGIBLE_REWARD_NO_JUDGE: {
    code: 'INELIGIBLE_REWARD_NO_JUDGE',
    message: 'Reward not paid: record has no judge evaluation result.',
  },
  INELIGIBLE_TRAINING_INCOMPLETE_RUN: {
    code: 'INELIGIBLE_TRAINING_INCOMPLETE_RUN',
    message:
      'Not training-eligible: record lacks run metadata required for training attribution.',
  },
  UNKNOWN_SCHEMA_VERSION: {
    code: 'UNKNOWN_SCHEMA_VERSION',
    message: 'Schema version is outside the known range.',
  },
} as const;

export type EvalErrorCode = keyof typeof EVAL_ERROR_CODES;

export const EVAL_ERROR_SEVERITY_ORDER: readonly EvalErrorCode[] = [
  'MALFORMED_JSON',
  'NOT_AN_OBJECT',
  'MISSING_REQUIRED_FIELD',
  'SCHEMA_VIOLATION',
  'INELIGIBLE_REWARD_NO_JUDGE',
  'INELIGIBLE_TRAINING_INCOMPLETE_RUN',
  'UNKNOWN_SCHEMA_VERSION',
];
