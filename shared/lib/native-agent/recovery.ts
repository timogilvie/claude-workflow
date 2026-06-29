import type { LoopStopReason } from './loop.ts';
import type { NativePatchRuntimeRejectionCode } from './patch-contract.ts';
import type { TranscriptEvent, TranscriptToolResult } from './transcript.ts';
import { redactSecretsInValue } from './tools/redaction.ts';

export interface ToolObservation {
  tool: string;
  isError: boolean;
  argsFingerprint?: string;
  mutating: boolean;
  patchRejectionCode?: NativePatchRuntimeRejectionCode;
}

export interface RuntimeTurnObservation {
  turnIndex: number;
  toolEvents: ToolObservation[];
  touchedArtifacts: string[];
}

export type StallType =
  | 'repeated_tool_failure'
  | 'repeated_patch_rejection'
  | 'no_touched_artifacts'
  | 'no_new_info'
  | 'budget_exhausted';

export interface StallDetectorConfig {
  repeatedToolFailureThreshold: number;
  repeatedPatchRejectionThreshold: number;
  noTouchedArtifactsTurns: number;
  noNewInfoReadOnlyTurns: number;
}

export interface StallEvidence {
  stallType: StallType;
  detail: string;
  count: number;
  threshold: number;
  involved: string[];
}

export interface LastUsefulActivity {
  turnIndex: number;
  description: string;
}

export type StallDetection =
  | { stalled: false }
  | {
    stalled: true;
    primary: StallEvidence;
    all: StallEvidence[];
    lastUsefulActivity: LastUsefulActivity | null;
  };

export interface BlockedStageResult {
  status: 'blocked';
  stallType: StallType;
  message: string;
  diagnostics: StallEvidence[];
  nextActionHints: string[];
  lastUsefulActivity: LastUsefulActivity | null;
}

export const RECOVERY_ARTIFACT_SCHEMA_VERSION = 1 as const;
export const RECOVERY_ARTIFACT_RELATIVE_DIR = '.wavemill/native-agent';

export interface RecoveryArtifactBudgetSnapshot {
  turnsCompleted?: number;
  toolCallsExecuted?: number;
  totalCostUsd?: number;
}

export interface RecoveryArtifact {
  schemaVersion: typeof RECOVERY_ARTIFACT_SCHEMA_VERSION;
  stage?: string;
  stallType: StallType;
  stopReason?: LoopStopReason;
  detectedAtTurn: number;
  summary: string;
  diagnostics: StallEvidence[];
  lastUsefulActivity: LastUsefulActivity | null;
  nextActionHints: string[];
  recentTurns: RuntimeTurnObservation[];
  budget?: RecoveryArtifactBudgetSnapshot;
}

export interface BuildRecoveryArtifactInput {
  detection: Extract<StallDetection, { stalled: true }>;
  turns: readonly RuntimeTurnObservation[];
  stage?: string;
  stopReason?: LoopStopReason;
  recentTurnLimit?: number;
  budget?: RecoveryArtifactBudgetSnapshot;
}

export interface StallMonitor {
  recordTurn(turn: RuntimeTurnObservation): void;
  evaluate(stopReason?: LoopStopReason): StallDetection;
  shouldStop(stopReason?: LoopStopReason): boolean;
}

const DEFAULT_STALL_DETECTOR_CONFIG: StallDetectorConfig = {
  repeatedToolFailureThreshold: 3,
  repeatedPatchRejectionThreshold: 3,
  noTouchedArtifactsTurns: 5,
  noNewInfoReadOnlyTurns: 4,
};

const BUDGET_STOP_REASONS = new Set<LoopStopReason>([
  'turn_limit',
  'token_limit',
  'tool_call_limit',
  'cost_limit',
  'wall_clock_limit',
]);

const STALL_PRIORITY: readonly StallType[] = [
  'repeated_patch_rejection',
  'repeated_tool_failure',
  'no_new_info',
  'no_touched_artifacts',
  'budget_exhausted',
] as const;

export function detectStall(
  turns: readonly RuntimeTurnObservation[],
  opts: { config?: Partial<StallDetectorConfig>; stopReason?: LoopStopReason } = {},
): StallDetection {
  if (turns.length === 0) {
    return { stalled: false };
  }

  const config = resolveConfig(opts.config);
  const evidence: StallEvidence[] = [];

  const repeatedPatchRejection = detectRepeatedPatchRejection(turns, config.repeatedPatchRejectionThreshold);
  if (repeatedPatchRejection) {
    evidence.push(repeatedPatchRejection);
  }

  const repeatedToolFailure = detectRepeatedToolFailure(turns, config.repeatedToolFailureThreshold);
  if (repeatedToolFailure) {
    evidence.push(repeatedToolFailure);
  }

  const noNewInfo = detectNoNewInfo(turns, config.noNewInfoReadOnlyTurns);
  if (noNewInfo) {
    evidence.push(noNewInfo);
  }

  const noTouchedArtifacts = detectNoTouchedArtifacts(turns, config.noTouchedArtifactsTurns);
  if (noTouchedArtifacts) {
    evidence.push(noTouchedArtifacts);
  }

  const budgetExhausted = detectBudgetExhausted(turns, opts.stopReason);
  if (budgetExhausted) {
    evidence.push(budgetExhausted);
  }

  if (evidence.length === 0) {
    return { stalled: false };
  }

  const prioritized = [...evidence].sort((left, right) => {
    return STALL_PRIORITY.indexOf(left.stallType) - STALL_PRIORITY.indexOf(right.stallType);
  });

  return {
    stalled: true,
    primary: prioritized[0]!,
    all: prioritized,
    lastUsefulActivity: findLastUsefulActivity(turns),
  };
}

export function buildBlockedStageResult(
  detection: Extract<StallDetection, { stalled: true }>,
  context: { stage?: string } = {},
): BlockedStageResult {
  const nextActionHints = buildNextActionHints(detection.primary);
  const stageLabel = context.stage ? `${context.stage} stage` : 'Runtime';
  const lastUseful = detection.lastUsefulActivity
    ? ` Last useful activity: turn ${detection.lastUsefulActivity.turnIndex} (${detection.lastUsefulActivity.description}).`
    : ' No useful activity was recorded before the stall.';

  return {
    status: 'blocked',
    stallType: detection.primary.stallType,
    message: `${stageLabel} blocked by ${humanizeStallType(detection.primary.stallType)}.${lastUseful}`,
    diagnostics: detection.all,
    nextActionHints,
    lastUsefulActivity: detection.lastUsefulActivity,
  };
}

export function buildRecoveryArtifact(input: BuildRecoveryArtifactInput): RecoveryArtifact {
  const recentTurnLimit = Math.max(1, input.recentTurnLimit ?? 5);
  const blocked = buildBlockedStageResult(input.detection, { stage: input.stage });
  const artifact: RecoveryArtifact = {
    schemaVersion: RECOVERY_ARTIFACT_SCHEMA_VERSION,
    ...(input.stage ? { stage: input.stage } : {}),
    stallType: input.detection.primary.stallType,
    ...(input.stopReason ? { stopReason: input.stopReason } : {}),
    detectedAtTurn: input.turns.at(-1)?.turnIndex ?? 0,
    summary: blocked.message,
    diagnostics: input.detection.all,
    lastUsefulActivity: input.detection.lastUsefulActivity,
    nextActionHints: blocked.nextActionHints,
    recentTurns: input.turns.slice(-recentTurnLimit).map(cloneTurnObservation),
    ...(input.budget ? { budget: input.budget } : {}),
  };

  return redactSecretsInValue(artifact).value as RecoveryArtifact;
}

export function serializeRecoveryArtifact(artifact: RecoveryArtifact): string {
  return `${JSON.stringify(sortKeysDeep(artifact), null, 2)}\n`;
}

export function createStallMonitor(config: Partial<StallDetectorConfig> = {}): StallMonitor {
  const turns: RuntimeTurnObservation[] = [];

  return {
    recordTurn(turn) {
      turns.push(cloneTurnObservation(turn));
    },
    evaluate(stopReason) {
      return detectStall(turns, { config, stopReason });
    },
    shouldStop(stopReason) {
      return this.evaluate(stopReason).stalled;
    },
  };
}

export function deriveTurnObservations(events: readonly TranscriptEvent[]): RuntimeTurnObservation[] {
  const turns: RuntimeTurnObservation[] = [];
  let current = createTurnObservation(0);
  let hasCurrent = false;
  let fallbackTurnIndex = 0;

  for (const event of events) {
    if (event.type === 'turn_started') {
      if (hasCurrent && current.toolEvents.length > 0) {
        turns.push(finalizeTurnObservation(current));
      }
      current = createTurnObservation(event.turnIndex);
      hasCurrent = true;
      fallbackTurnIndex = event.turnIndex;
      continue;
    }

    if (event.type === 'tool_result') {
      if (!hasCurrent) {
        current = createTurnObservation(fallbackTurnIndex);
        hasCurrent = true;
      }
      current.toolEvents.push(toolObservationFromTranscript(event));
      for (const changedFile of extractChangedFiles(event.details)) {
        pushUnique(current.touchedArtifacts, changedFile);
      }
      continue;
    }

    if (event.type === 'turn_ended') {
      if (!hasCurrent) {
        current = createTurnObservation(event.turnIndex);
        hasCurrent = true;
      }
      current.turnIndex = event.turnIndex;
      turns.push(finalizeTurnObservation(current));
      hasCurrent = false;
      fallbackTurnIndex = event.turnIndex + 1;
      current = createTurnObservation(fallbackTurnIndex);
    }
  }

  if (hasCurrent && (current.toolEvents.length > 0 || current.touchedArtifacts.length > 0)) {
    turns.push(finalizeTurnObservation(current));
  }

  return turns;
}

function resolveConfig(config: Partial<StallDetectorConfig> | undefined): StallDetectorConfig {
  return {
    repeatedToolFailureThreshold: positiveThreshold(
      config?.repeatedToolFailureThreshold,
      DEFAULT_STALL_DETECTOR_CONFIG.repeatedToolFailureThreshold,
    ),
    repeatedPatchRejectionThreshold: positiveThreshold(
      config?.repeatedPatchRejectionThreshold,
      DEFAULT_STALL_DETECTOR_CONFIG.repeatedPatchRejectionThreshold,
    ),
    noTouchedArtifactsTurns: positiveThreshold(
      config?.noTouchedArtifactsTurns,
      DEFAULT_STALL_DETECTOR_CONFIG.noTouchedArtifactsTurns,
    ),
    noNewInfoReadOnlyTurns: positiveThreshold(
      config?.noNewInfoReadOnlyTurns,
      DEFAULT_STALL_DETECTOR_CONFIG.noNewInfoReadOnlyTurns,
    ),
  };
}

function positiveThreshold(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value as number) > 0 ? (value as number) : fallback;
}

function detectRepeatedToolFailure(
  turns: readonly RuntimeTurnObservation[],
  threshold: number,
): StallEvidence | null {
  const flattened = flattenToolEvents(turns);
  if (flattened.length === 0) {
    return null;
  }

  const last = flattened.at(-1);
  if (!last?.isError) {
    return null;
  }

  let count = 0;
  for (let index = flattened.length - 1; index >= 0; index -= 1) {
    const event = flattened[index]!;
    if (!event.isError || event.tool !== last.tool) {
      break;
    }
    count += 1;
  }

  if (count < threshold) {
    return null;
  }

  return {
    stallType: 'repeated_tool_failure',
    detail: `${last.tool} failed ${count} consecutive time(s).`,
    count,
    threshold,
    involved: [last.tool],
  };
}

function detectRepeatedPatchRejection(
  turns: readonly RuntimeTurnObservation[],
  threshold: number,
): StallEvidence | null {
  const flattened = flattenToolEvents(turns);
  if (flattened.length === 0) {
    return null;
  }

  const codes: string[] = [];
  let count = 0;
  for (let index = flattened.length - 1; index >= 0; index -= 1) {
    const event = flattened[index]!;
    if (!event.patchRejectionCode) {
      break;
    }
    count += 1;
    pushUnique(codes, event.patchRejectionCode);
  }

  if (count < threshold) {
    return null;
  }

  return {
    stallType: 'repeated_patch_rejection',
    detail: `Patch application was rejected ${count} consecutive time(s).`,
    count,
    threshold,
    involved: codes,
  };
}

function detectNoTouchedArtifacts(
  turns: readonly RuntimeTurnObservation[],
  threshold: number,
): StallEvidence | null {
  let count = 0;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (turns[index]!.touchedArtifacts.length > 0) {
      break;
    }
    count += 1;
  }

  if (count < threshold) {
    return null;
  }

  return {
    stallType: 'no_touched_artifacts',
    detail: `No artifacts were touched for ${count} consecutive turn(s).`,
    count,
    threshold,
    involved: [],
  };
}

function detectNoNewInfo(
  turns: readonly RuntimeTurnObservation[],
  threshold: number,
): StallEvidence | null {
  const seenBeforeTurn: Set<string>[] = [];
  const seen = new Set<string>();
  for (const turn of turns) {
    seenBeforeTurn.push(new Set(seen));
    for (const event of turn.toolEvents) {
      if (event.argsFingerprint) {
        seen.add(fingerprintKey(event.tool, event.argsFingerprint));
      }
    }
  }

  let count = 0;
  const involved = new Set<string>();
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]!;
    const priorFingerprints = seenBeforeTurn[index]!;
    if (!isReadOnlyTurn(turn)) {
      break;
    }
    if (turn.toolEvents.length === 0) {
      break;
    }

    const currentTurnKeys: string[] = [];
    let repeatedOnly = true;
    for (const event of turn.toolEvents) {
      if (!event.argsFingerprint) {
        repeatedOnly = false;
        break;
      }
      const key = fingerprintKey(event.tool, event.argsFingerprint);
      if (!priorFingerprints.has(key)) {
        repeatedOnly = false;
        break;
      }
      currentTurnKeys.push(key);
      involved.add(event.tool);
    }

    if (!repeatedOnly) {
      break;
    }

    count += 1;
  }

  if (count < threshold) {
    return null;
  }

  return {
    stallType: 'no_new_info',
    detail: `${count} consecutive read-only turn(s) repeated already-seen tool inputs.`,
    count,
    threshold,
    involved: [...involved].sort(),
  };
}

function detectBudgetExhausted(
  turns: readonly RuntimeTurnObservation[],
  stopReason: LoopStopReason | undefined,
): StallEvidence | null {
  if (!stopReason || !BUDGET_STOP_REASONS.has(stopReason)) {
    return null;
  }

  return {
    stallType: 'budget_exhausted',
    detail: `Runtime stopped after ${turns.length} turn(s) because ${stopReason} was reached.`,
    count: turns.length,
    threshold: turns.length,
    involved: [stopReason],
  };
}

function findLastUsefulActivity(turns: readonly RuntimeTurnObservation[]): LastUsefulActivity | null {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]!;
    if (turn.touchedArtifacts.length > 0) {
      return {
        turnIndex: turn.turnIndex,
        description: `touched ${turn.touchedArtifacts.join(', ')}`,
      };
    }

    const successfulMutation = turn.toolEvents.find((event) => event.mutating && !event.isError);
    if (successfulMutation) {
      return {
        turnIndex: turn.turnIndex,
        description: `successful mutating call via ${successfulMutation.tool}`,
      };
    }
  }

  return null;
}

function buildNextActionHints(evidence: StallEvidence): string[] {
  switch (evidence.stallType) {
    case 'repeated_patch_rejection':
      return [
        `The patch was rejected ${evidence.count} times (${evidence.involved.join(', ') || 'unknown code'}). Re-read the live file region before retrying.`,
        'Prefer a smaller patch or tighter anchors so the edit targets the current file contents.',
      ];
    case 'repeated_tool_failure':
      return [
        `Inspect the failing ${evidence.involved[0] ?? 'tool'} invocation and correct its inputs before retrying.`,
        'If the failure is environmental, capture the stderr or diagnostics and hand off with the recovery artifact.',
      ];
    case 'no_new_info':
      return [
        'Stop repeating the same read-only calls and widen the search space or switch to a mutating step.',
        'Use the repeated fingerprints in the artifact to identify which reads were no longer producing new information.',
      ];
    case 'no_touched_artifacts':
      return [
        'No files changed across the recent turns; either produce a concrete edit or stop and hand off.',
        'Check whether the task is blocked on missing context, permissions, or an invalid patch strategy.',
      ];
    case 'budget_exhausted':
      return [
        'Resume from the recovery artifact with a tighter next action so the remaining budget is spent on one concrete step.',
        'Increase the relevant runtime budget only if the prior turns were still making progress.',
      ];
  }
}

function humanizeStallType(stallType: StallType): string {
  return stallType.replace(/_/g, ' ');
}

function flattenToolEvents(
  turns: readonly RuntimeTurnObservation[],
): Array<ToolObservation & { turnIndex: number }> {
  return turns.flatMap((turn) => turn.toolEvents.map((event) => ({ ...event, turnIndex: turn.turnIndex })));
}

function isReadOnlyTurn(turn: RuntimeTurnObservation): boolean {
  if (turn.touchedArtifacts.length > 0) {
    return false;
  }
  return !turn.toolEvents.some((event) => event.mutating && !event.isError);
}

function fingerprintKey(tool: string, argsFingerprint: string): string {
  return `${tool}:${argsFingerprint}`;
}

function cloneTurnObservation(turn: RuntimeTurnObservation): RuntimeTurnObservation {
  return {
    turnIndex: turn.turnIndex,
    toolEvents: turn.toolEvents.map((event) => ({ ...event })),
    touchedArtifacts: [...turn.touchedArtifacts],
  };
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortKeysDeep(entry));
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      result[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return result;
  }
  return value;
}

function createTurnObservation(turnIndex: number): RuntimeTurnObservation {
  return { turnIndex, toolEvents: [], touchedArtifacts: [] };
}

function finalizeTurnObservation(turn: RuntimeTurnObservation): RuntimeTurnObservation {
  return {
    turnIndex: turn.turnIndex,
    toolEvents: turn.toolEvents.map((event) => ({ ...event })),
    touchedArtifacts: [...new Set(turn.touchedArtifacts)],
  };
}

function toolObservationFromTranscript(event: TranscriptToolResult): ToolObservation {
  const details = asRecord(event.details);
  const diagnostics = asRecord(details?.diagnostics);
  const patchRejectionCode = details?.error === 'patch_rejected' && typeof diagnostics?.code === 'string'
    ? diagnostics.code as NativePatchRuntimeRejectionCode
    : undefined;

  return {
    tool: event.toolName,
    isError: event.isError,
    argsFingerprint: typeof event.metadata?.provenance?.argsFingerprint === 'string'
      ? event.metadata.provenance.argsFingerprint
      : undefined,
    mutating: inferMutatingTool(event.toolName, details, patchRejectionCode),
    ...(patchRejectionCode ? { patchRejectionCode } : {}),
  };
}

function extractChangedFiles(details: unknown): string[] {
  const record = asRecord(details);
  if (!record || !Array.isArray(record.changedFiles)) {
    return [];
  }

  return record.changedFiles.filter((value): value is string => typeof value === 'string');
}

function inferMutatingTool(
  toolName: string,
  details: Record<string, unknown> | null,
  patchRejectionCode: NativePatchRuntimeRejectionCode | undefined,
): boolean {
  if (patchRejectionCode) {
    return true;
  }

  if (extractChangedFiles(details).length > 0) {
    return true;
  }

  const normalizedName = toolName.toLowerCase();
  if (
    normalizedName.includes('write') ||
    normalizedName.includes('patch') ||
    normalizedName.includes('edit') ||
    normalizedName.includes('commit') ||
    normalizedName.includes('delete') ||
    normalizedName.includes('create')
  ) {
    return true;
  }

  return false;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function pushUnique(values: string[], value: string): void {
  if (!values.includes(value)) {
    values.push(value);
  }
}
