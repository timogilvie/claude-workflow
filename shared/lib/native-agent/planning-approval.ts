import { createInterface } from 'node:readline/promises';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Readable, Writable } from 'node:stream';

export type NativePlanningApprovalMode = 'interactive' | 'external';

export type NativePlanningApprovalCommand =
  | 'approve'
  | 'reject'
  | 'abort'
  | 'status'
  | 'help'
  | 'unknown';

export type NativePlanningApprovalDecision =
  | 'approved'
  | 'rejected'
  | 'aborted'
  | 'external'
  | 'eof';

export interface NativePlanningApprovalGateOptions {
  issue: string;
  planPath: string;
  approvalMarkerPath: string;
  workflowAbortMarkerPath: string;
  transcriptPath: string;
  provider: string;
  model: string;
  mode?: NativePlanningApprovalMode;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  maxPreviewChars?: number;
}

export interface NativePlanningApprovalGateResult {
  decision: NativePlanningApprovalDecision;
  approvalMarkerPath: string;
  workflowAbortMarkerPath: string;
}

const DEFAULT_PREVIEW_CHARS = 60_000;

function write(output: NodeJS.WritableStream, text: string): void {
  output.write(text);
}

function marker(path: string, content = ''): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf-8');
}

export function parseNativePlanningApprovalCommand(input: string): NativePlanningApprovalCommand {
  const normalized = input.trim().toLowerCase();
  switch (normalized) {
    case 'approve':
    case 'approved':
    case 'yes':
    case 'y':
      return 'approve';
    case 'reject':
    case 'rejected':
    case 'no':
    case 'n':
      return 'reject';
    case 'abort':
    case 'stop':
      return 'abort';
    case 'status':
    case 's':
      return 'status';
    case 'help':
    case 'h':
    case '?':
      return 'help';
    default:
      return normalized === '' ? 'help' : 'unknown';
  }
}

export function resolveNativePlanningApprovalMode(
  explicitMode: string | undefined,
  input: NodeJS.ReadableStream = process.stdin,
): NativePlanningApprovalMode {
  const normalized = explicitMode?.trim().toLowerCase();
  if (normalized === 'interactive' || normalized === 'external') {
    return normalized;
  }
  if (normalized) {
    throw new Error(`invalid native planning approval mode "${explicitMode}". Use interactive or external.`);
  }
  return input.isTTY ? 'interactive' : 'external';
}

function readPlanPreview(planPath: string, maxPreviewChars: number): { text: string; truncated: boolean } {
  const text = existsSync(planPath) ? readFileSync(planPath, 'utf-8') : '';
  if (text.length <= maxPreviewChars) {
    return { text, truncated: false };
  }
  return { text: text.slice(0, maxPreviewChars), truncated: true };
}

function printSummary(options: Required<Pick<
  NativePlanningApprovalGateOptions,
  'issue' | 'planPath' | 'approvalMarkerPath' | 'workflowAbortMarkerPath' | 'transcriptPath' | 'provider' | 'model'
>>, output: NodeJS.WritableStream): void {
  write(output, [
    '',
    'Native plan ready for approval',
    `Issue: ${options.issue}`,
    `Model: ${options.provider}:${options.model}`,
    `Plan: ${options.planPath}`,
    `Transcript: ${options.transcriptPath}`,
    '',
  ].join('\n'));
}

function printHelp(output: NodeJS.WritableStream): void {
  write(output, [
    'Commands:',
    '  approve   create .plan-approved and let wavemill launch the next phase',
    '  reject    leave the plan awaiting approval',
    '  abort     create .workflow-aborted',
    '  status    reprint plan and marker paths',
    '',
  ].join('\n'));
}

export async function runNativePlanningApprovalGate(
  options: NativePlanningApprovalGateOptions,
): Promise<NativePlanningApprovalGateResult> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const mode = options.mode ?? resolveNativePlanningApprovalMode(undefined, input);
  const maxPreviewChars = options.maxPreviewChars ?? DEFAULT_PREVIEW_CHARS;
  const summary = {
    issue: options.issue,
    planPath: options.planPath,
    approvalMarkerPath: options.approvalMarkerPath,
    workflowAbortMarkerPath: options.workflowAbortMarkerPath,
    transcriptPath: options.transcriptPath,
    provider: options.provider,
    model: options.model,
  };

  printSummary(summary, output);

  const preview = readPlanPreview(options.planPath, maxPreviewChars);
  if (preview.text.trim() !== '') {
    write(output, `${preview.text.trimEnd()}\n`);
    if (preview.truncated) {
      write(output, `\n[plan preview truncated; full plan is at ${options.planPath}]\n`);
    }
    write(output, '\n');
  }

  if (mode === 'external') {
    write(output, [
      'Native planning is awaiting external approval.',
      `Approve with: touch ${options.approvalMarkerPath}`,
      `Abort with: touch ${options.workflowAbortMarkerPath}`,
      '',
    ].join('\n'));
    return {
      decision: 'external',
      approvalMarkerPath: options.approvalMarkerPath,
      workflowAbortMarkerPath: options.workflowAbortMarkerPath,
    };
  }

  printHelp(output);
  const rl = createInterface({
    input: input as Readable,
    output: output as Writable,
    terminal: Boolean(input.isTTY && output.isTTY),
  });

  try {
    while (true) {
      let answer = '';
      try {
        answer = await rl.question('native-plan> ');
      } catch {
        write(output, [
          '',
          'Native planning is still awaiting approval.',
          `Approve with: touch ${options.approvalMarkerPath}`,
          '',
        ].join('\n'));
        return {
          decision: 'eof',
          approvalMarkerPath: options.approvalMarkerPath,
          workflowAbortMarkerPath: options.workflowAbortMarkerPath,
        };
      }

      switch (parseNativePlanningApprovalCommand(answer)) {
        case 'approve':
          marker(options.approvalMarkerPath);
          write(output, `Plan approved. Created ${options.approvalMarkerPath}\n`);
          return {
            decision: 'approved',
            approvalMarkerPath: options.approvalMarkerPath,
            workflowAbortMarkerPath: options.workflowAbortMarkerPath,
          };
        case 'reject':
          write(output, [
            'Plan left awaiting approval.',
            `Approve later with: touch ${options.approvalMarkerPath}`,
            '',
          ].join('\n'));
          return {
            decision: 'rejected',
            approvalMarkerPath: options.approvalMarkerPath,
            workflowAbortMarkerPath: options.workflowAbortMarkerPath,
          };
        case 'abort':
          marker(options.workflowAbortMarkerPath);
          write(output, `Workflow abort requested. Created ${options.workflowAbortMarkerPath}\n`);
          return {
            decision: 'aborted',
            approvalMarkerPath: options.approvalMarkerPath,
            workflowAbortMarkerPath: options.workflowAbortMarkerPath,
          };
        case 'status':
          printSummary(summary, output);
          break;
        case 'help':
          printHelp(output);
          break;
        case 'unknown':
          write(output, 'Unknown command. Type approve, reject, abort, status, or help.\n');
          break;
      }
    }
  } finally {
    rl.close();
  }
}
