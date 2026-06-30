// ---------------------------------------------------------------------------
// Re-export shim — all secret redaction logic lives in shared/lib/redaction-profiles.ts
// This file exists to preserve import paths for transcript, loop, and command-transcript callers.
// ---------------------------------------------------------------------------

export type {
  RedactionCategory,
  RedactionOptions,
  RedactionResult,
  SecretPattern,
  ValueRedactionResult,
} from '../../redaction-profiles.ts';

export {
  redactSecrets,
  redactSecretsInValue,
} from '../../redaction-profiles.ts';
