import { applyNativePatch, type NativePatchAppliedResult } from '../patch-runtime.ts';
import type { MutationRecorder } from '../cleanup.ts';
import {
  formatNativePatchContractSummary,
  NATIVE_PATCH_EXAMPLE,
  validateNativePatch,
  type NativePatch,
  type NativePatchRejectedResult,
  type NativePatchRuntimeRejection,
  type NativePatchValidationError,
} from '../patch-contract.ts';
import type { ToolDescriptor, ToolPhase, WavemillToolResult } from './types.ts';

export interface ApplyPatchParams {
  patch: NativePatch;
}

export interface ApplyPatchSuccessDetails extends NativePatchAppliedResult {
  tool: 'apply_patch';
}

export interface ApplyPatchErrorDetails {
  ok: false;
  tool: 'apply_patch';
  error: 'invalid_patch' | 'patch_rejected' | 'io_error';
  message: string;
  retryHint?: string;
  diagnostics?: NativePatchValidationError[] | NativePatchRuntimeRejection;
}

export type ApplyPatchDetails = ApplyPatchSuccessDetails | ApplyPatchErrorDetails;

export interface ApplyPatchToolOptions {
  phase?: ToolPhase;
  recorder?: MutationRecorder;
}

interface AfterToolCallContext {
  toolCall: { name: string };
  result: { details: unknown };
}

const nativePatchContractSummary = formatNativePatchContractSummary();

const applyPatchParameters = {
  type: 'object',
  properties: {
    patch: {
      type: 'object',
      description: [
        'NativePatch payload containing one or more atomic edit operations.',
        'Envelope fields: version must be 1, atomic must be true, operations must be a non-empty array.',
        'Each operation needs op and path. For op "edit", include oldText and newText. For op "edit-diff", include diff.',
      ].join(' '),
      properties: {
        version: {
          type: 'number',
          enum: [1],
          description: 'Always 1.',
        },
        atomic: {
          type: 'boolean',
          enum: [true],
          description: 'Always true.',
        },
        operations: {
          type: 'array',
          minItems: 1,
          description: 'Non-empty list of atomic edit operations.',
          items: {
            type: 'object',
            properties: {
              op: {
                type: 'string',
                enum: ['edit', 'edit-diff'],
                description: 'Use edit with oldText/newText or edit-diff with diff.',
              },
              path: {
                type: 'string',
                description: 'Repo-relative POSIX path with no traversal.',
              },
              oldText: {
                type: 'string',
                description: 'Required for edit; exact text currently in the file.',
              },
              newText: {
                type: 'string',
                description: 'Required for edit; replacement text different from oldText.',
              },
              diff: {
                type: 'string',
                description: 'Required for edit-diff; unified diff hunk for this file.',
              },
              anchorBefore: {
                type: 'string',
                description: 'Optional context before the edit.',
              },
              anchorAfter: {
                type: 'string',
                description: 'Optional context after the edit.',
              },
              expectedOccurrences: {
                type: 'number',
                description: 'Optional expected number of oldText occurrences.',
              },
            },
          },
        },
        fuzzyMatch: {
          type: 'object',
          description: 'Optional envelope-level fuzzy matching settings.',
        },
      },
    },
  },
  required: ['patch'],
  additionalProperties: false,
};

export function createApplyPatchTool(
  worktreePath: string,
  options: ApplyPatchToolOptions = {},
): ToolDescriptor<ApplyPatchParams, ApplyPatchDetails> {
  const phase = options.phase ?? 'coding';
  return {
    metadata: {
      name: 'apply_patch',
      description: `Apply an atomic native patch to source files inside the active worktree.\n\n${nativePatchContractSummary}`,
      class: 'mutation',
      allowedPhases: ['coding'],
      executionMode: 'sequential',
      outputCapPolicy: { strategy: 'none' },
    },
    parameters: applyPatchParameters,
    async execute(_toolCallId, params) {
      return executeApplyPatch(worktreePath, params, phase, options.recorder);
    },
  };
}

export async function applyPatchAfterToolCall(
  context: AfterToolCallContext,
): Promise<{ isError?: boolean } | undefined> {
  if (context.toolCall.name !== 'apply_patch') {
    return undefined;
  }
  const details = context.result.details as ApplyPatchDetails | undefined;
  if (!details || typeof details !== 'object' || !('ok' in details)) {
    return undefined;
  }
  return details.ok ? undefined : { isError: true };
}

async function executeApplyPatch(
  worktreePath: string,
  params: ApplyPatchParams,
  phase: ToolPhase,
  recorder?: MutationRecorder,
): Promise<WavemillToolResult<ApplyPatchDetails>> {
  const validation = validateNativePatch(params.patch);
  if (!validation.ok) {
    const message = 'Patch payload did not match the NativePatch contract.';
    const details: ApplyPatchErrorDetails = {
      ok: false,
      tool: 'apply_patch',
      error: 'invalid_patch',
      message,
      retryHint: 'Fix the listed schema errors and retry; follow the valid example in this message.',
      diagnostics: validation.errors,
    };
    return {
      content: [{ type: 'text', text: formatInvalidPatchMessage(message, validation.errors) }],
      details,
    };
  }

  try {
    const result = await applyNativePatch(worktreePath, validation.value, { phase });
    if (result.ok) {
      for (const changedFile of result.changedFiles) {
        recorder?.recordMutation({
          tool: 'apply_patch',
          status: 'completed',
          path: changedFile,
        });
      }
      recorder?.recordPatchSnapshots(result.snapshots);
      const details: ApplyPatchSuccessDetails = {
        ...result,
        tool: 'apply_patch',
      };
      return {
        content: [{ type: 'text', text: summarizeApplyPatch(details) }],
        details,
      };
    }
    recorder?.recordMutation({
      tool: 'apply_patch',
      status: 'failed',
      path: validation.value.operations[0]?.path,
      reason: result.rejection.message,
    });
    return rejectedPatchResult(result);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    recorder?.recordMutation({
      tool: 'apply_patch',
      status: 'failed',
      path: validation.value.operations[0]?.path,
      reason: message,
    });
    const details: ApplyPatchErrorDetails = {
      ok: false,
      tool: 'apply_patch',
      error: 'io_error',
      message: `Failed to apply patch: ${message}`,
      retryHint: 'Check filesystem state and retry the patch.',
    };
    return {
      content: [{ type: 'text', text: details.message }],
      details,
    };
  }
}

function rejectedPatchResult(
  result: NativePatchRejectedResult,
): WavemillToolResult<ApplyPatchDetails> {
  const details: ApplyPatchErrorDetails = {
    ok: false,
    tool: 'apply_patch',
    error: 'patch_rejected',
    message: result.rejection.message,
    retryHint: result.rejection.hint,
    diagnostics: result.rejection,
  };
  return {
    content: [{ type: 'text', text: `${result.rejection.code}: ${result.rejection.message}` }],
    details,
  };
}

function formatInvalidPatchMessage(
  message: string,
  errors: NativePatchValidationError[],
): string {
  return [
    message,
    ...errors.map((error) => `- ${error.path}: ${error.message}`),
    'Required envelope: {"version": 1, "atomic": true, "operations": [...]}.',
    'Operations: {op: "edit", path, oldText, newText} or {op: "edit-diff", path, diff}.',
    `Valid example: ${JSON.stringify(NATIVE_PATCH_EXAMPLE)}`,
  ].join('\n');
}

function summarizeApplyPatch(result: ApplyPatchSuccessDetails): string {
  const fileSummary = result.fileChanges
    .map((change) => `${change.path} (+${change.linesAdded} -${change.linesRemoved})`)
    .join(', ');
  return `Applied patch to ${result.changedFiles.length} file(s); ${result.linesAdded} line(s) added, ${result.linesRemoved} removed${fileSummary ? `: ${fileSummary}` : ''}.`;
}
