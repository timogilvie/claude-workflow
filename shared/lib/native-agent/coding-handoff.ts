import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { redactSecretsInValue } from './tools/redaction.ts';

export const NO_MARKER_HANDOFF_FILENAME = '.coding-no-marker-handoff.json';

export interface CodingMutationFailure {
  tool: string;
  error: string;
  message: string;
  retryHint?: string;
  diagnostics?: unknown;
}

export interface NoMarkerHandoff {
  schemaVersion: 1;
  stage: 'coding';
  reason: 'no_completion_marker';
  createdAt: string;
  stopReason: string;
  model: string;
  mutationFailureCount: number;
  lastMutationFailure: CodingMutationFailure | null;
  suggestedNextActions: string[];
}

export type NoMarkerHandoffValidationResult =
  | { ok: true; value: NoMarkerHandoff }
  | { ok: false; message: string; field?: string };

export interface BuildNoMarkerHandoffInput {
  createdAt?: string;
  stopReason: string;
  model: string;
  mutationFailureCount: number;
  lastMutationFailure: CodingMutationFailure | null;
}

export function getNoMarkerHandoffPath(featureDir: string): string {
  return join(featureDir, NO_MARKER_HANDOFF_FILENAME);
}

export function buildNoMarkerHandoff(input: BuildNoMarkerHandoffInput): NoMarkerHandoff {
  const suggestedNextActions = [
    'Retry coding: the last mutation tool error below explains what to fix.',
    'If apply_patch kept failing, construct the payload from the NativePatch example in the tool description.',
    'Write .coding-complete or .coding-blocked-completion.json before stopping so the controller can classify the run.',
  ];

  return redactSecretsInValue({
    schemaVersion: 1,
    stage: 'coding',
    reason: 'no_completion_marker',
    createdAt: input.createdAt ?? new Date().toISOString(),
    stopReason: input.stopReason,
    model: input.model,
    mutationFailureCount: input.mutationFailureCount,
    lastMutationFailure: input.lastMutationFailure,
    suggestedNextActions,
  }).value as NoMarkerHandoff;
}

export function writeNoMarkerHandoff(featureDir: string, handoff: NoMarkerHandoff): string {
  const handoffPath = getNoMarkerHandoffPath(featureDir);
  mkdirSync(dirname(handoffPath), { recursive: true });
  const tmpPath = `${handoffPath}.tmp.${process.pid}.${randomUUID()}`;
  try {
    writeFileSync(tmpPath, `${JSON.stringify(redactSecretsInValue(handoff).value, null, 2)}\n`, 'utf-8');
    renameSync(tmpPath, handoffPath);
  } catch (error) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Preserve the original write/rename failure.
    }
    throw error;
  }
  return handoffPath;
}

export function readNoMarkerHandoff(filePath: string): NoMarkerHandoffValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as unknown;
  } catch (error) {
    const message = error instanceof SyntaxError
      ? `No-marker handoff at ${filePath} contains malformed JSON.`
      : `Failed to read no-marker handoff at ${filePath}: ${(error as Error).message}`;
    return { ok: false, message };
  }

  return validateNoMarkerHandoff(parsed);
}

export function validateNoMarkerHandoff(value: unknown): NoMarkerHandoffValidationResult {
  if (!isRecord(value)) {
    return invalid('No-marker handoff must be a JSON object.', 'artifact');
  }
  if (value.schemaVersion !== 1) {
    return invalid('No-marker handoff schemaVersion must be 1.', 'schemaVersion');
  }
  if (value.stage !== 'coding') {
    return invalid('No-marker handoff stage must be "coding".', 'stage');
  }
  if (value.reason !== 'no_completion_marker') {
    return invalid('No-marker handoff reason must be "no_completion_marker".', 'reason');
  }
  if (typeof value.createdAt !== 'string') {
    return invalid('No-marker handoff createdAt must be a string.', 'createdAt');
  }
  if (typeof value.stopReason !== 'string') {
    return invalid('No-marker handoff stopReason must be a string.', 'stopReason');
  }
  if (typeof value.model !== 'string') {
    return invalid('No-marker handoff model must be a string.', 'model');
  }
  if (!Number.isInteger(value.mutationFailureCount) || value.mutationFailureCount < 0) {
    return invalid('No-marker handoff mutationFailureCount must be a non-negative integer.', 'mutationFailureCount');
  }
  if (value.lastMutationFailure !== null && !isCodingMutationFailure(value.lastMutationFailure)) {
    return invalid('No-marker handoff lastMutationFailure must be null or a mutation failure object.', 'lastMutationFailure');
  }
  if (!Array.isArray(value.suggestedNextActions) || !value.suggestedNextActions.every((item) => typeof item === 'string')) {
    return invalid('No-marker handoff suggestedNextActions must be an array of strings.', 'suggestedNextActions');
  }

  return { ok: true, value: value as NoMarkerHandoff };
}

function isCodingMutationFailure(value: unknown): value is CodingMutationFailure {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.tool === 'string'
    && typeof value.error === 'string'
    && typeof value.message === 'string'
    && (value.retryHint === undefined || typeof value.retryHint === 'string');
}

function invalid(message: string, field?: string): NoMarkerHandoffValidationResult {
  return field ? { ok: false, message, field } : { ok: false, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
