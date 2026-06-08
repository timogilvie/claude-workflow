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
  EVAL_MISSING_TASK_DESCRIPTOR: {
    code: 'EVAL_MISSING_TASK_DESCRIPTOR',
    message: 'Eval record is missing a valid taskDescriptor object.',
  },
  EVAL_EMPTY_MODELS_AVAILABLE: {
    code: 'EVAL_EMPTY_MODELS_AVAILABLE',
    message: 'Eval record taskDescriptor.constraints.models_available must be a non-empty array.',
  },
  EVAL_UNKNOWN_STAGE_MODEL: {
    code: 'EVAL_UNKNOWN_STAGE_MODEL',
    message: 'Eval record stage model must resolve to a canonical registry model ID.',
  },
  EVAL_NONCANONICAL_REVIEWER: {
    code: 'EVAL_NONCANONICAL_REVIEWER',
    message: 'Eval record reviewer model must resolve to a canonical reviewer model ID.',
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
  'EVAL_MISSING_TASK_DESCRIPTOR',
  'EVAL_EMPTY_MODELS_AVAILABLE',
  'EVAL_UNKNOWN_STAGE_MODEL',
  'EVAL_NONCANONICAL_REVIEWER',
  'INELIGIBLE_REWARD_NO_JUDGE',
  'INELIGIBLE_TRAINING_INCOMPLETE_RUN',
  'UNKNOWN_SCHEMA_VERSION',
];
