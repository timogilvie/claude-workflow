import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendJsonlRecord } from './jsonl-utils.ts';
import { readChallengeComparisons, type ChallengeComparison } from './challenge-comparison.ts';
import { getLifecycleConfig, getRegistryConfig } from './config.ts';
import { readEvalRecords } from './eval-persistence.ts';
import { resolveManifestDir } from './resource-manifest.ts';
import {
  getResource,
  listResources,
  resolveRegistryDir,
  type ResourceRef,
  type ResourceType,
  type ResourceVersion,
} from './resource-registry.ts';
import { resolveFromMainRepo } from './git-utils.ts';

export type LifecycleState = 'draft' | 'canary' | 'stable' | 'rejected' | 'rolled_back';
export type LifecycleStateOrInit = LifecycleState | 'init';

export interface LifecycleActor {
  kind: string;
  user: string;
  sessionId?: string;
}

export interface LifecycleResourceRef extends ResourceRef {
  type: ResourceType;
  name: string;
}

export interface EvalEvidence {
  kind: 'eval';
  path: string;
  recordIds: string[];
  aggregate: {
    meanScore: number;
    count: number;
    minScore: number;
  };
}

export interface ChallengeEvidence {
  kind: 'challenge';
  path: string;
  challengePairIds: string[];
  wins: number;
  total: number;
}

export interface ManualEvidence {
  kind: 'manual';
  note: string;
}

export type Evidence = EvalEvidence | ChallengeEvidence | ManualEvidence;

export interface TransitionRecord {
  schemaVersion: string;
  transitionId: string;
  timestamp: string;
  resource: LifecycleResourceRef;
  fromState: LifecycleState | null;
  toState: LifecycleState;
  actor: LifecycleActor;
  rationale: string;
  evidence?: Evidence[];
  previousStable?: ResourceRef;
  metadata?: Record<string, unknown>;
}

export interface PointerSlot extends ResourceRef {
  trafficPercent?: number;
  updatedAt?: string;
}

export interface PointerEntry {
  stable?: PointerSlot;
  canary?: PointerSlot;
  previousStable?: PointerSlot;
  history?: PointerSlot[];
}

export interface ActivePointerDocument {
  schemaVersion: string;
  updatedAt: string;
  entries: Record<string, PointerEntry>;
}

export interface PromotionEvaluation {
  eligible: boolean;
  reasons: string[];
  evidence: Evidence[];
  aggregate: {
    evalCount: number;
    meanScore: number | null;
    minScore: number | null;
    challengeWins: number;
    challengeTotal: number;
    differsFromStable: boolean;
  };
}

export interface PromoteOptions {
  toState: 'canary' | 'stable';
  rationale: string;
  evidence?: Evidence[];
  trafficPercent?: number;
  force?: boolean;
  actor: LifecycleActor;
}

export interface RejectOptions {
  rationale: string;
  actor: LifecycleActor;
}

export interface RollbackOptions {
  rationale: string;
  actor: LifecycleActor;
}

export interface PromoteResult {
  record: TransitionRecord;
  pointerEntry: PointerEntry;
}

const LIFECYCLE_SCHEMA_VERSION = '1.0.0';
const TRANSITIONS_FILENAME = 'lifecycle.jsonl';
const ACTIVE_POINTERS_FILENAME = 'active-pointers.json';
const ACTIVE_POINTERS_LOCK = 'active-pointers.lock';
const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

type ValidationError = { instancePath?: string; message?: string };
type ValidatorFunction = ((data: unknown) => boolean) & { errors?: ValidationError[] | null };

let transitionValidator: ValidatorFunction | null | undefined;
let activePointerValidator: ValidatorFunction | null | undefined;
let hasWarnedMalformedLifecycle = false;

export const LEGAL_TRANSITIONS: Record<LifecycleStateOrInit, LifecycleState[]> = {
  init: ['draft', 'canary', 'stable', 'rejected'],
  draft: ['canary', 'stable', 'rejected'],
  canary: ['stable', 'rejected', 'rolled_back'],
  stable: ['canary', 'rolled_back'],
  rejected: [],
  rolled_back: ['stable'],
};

function loadValidator(schemaPath: string, memo: ValidatorFunction | null | undefined): ValidatorFunction | null {
  if (memo !== undefined) {
    return memo;
  }
  try {
    const AjvCtor = (require('ajv/dist/2020').default || require('ajv/dist/2020')) as {
      new (options: { allErrors: boolean; strict: boolean }): { compile(schema: unknown): ValidatorFunction };
    };
    const schema = JSON.parse(readFileSync(schemaPath, 'utf-8'));
    return new AjvCtor({ allErrors: true, strict: false }).compile(schema);
  } catch (error) {
    console.warn(`[resource-lifecycle] Schema validation disabled: ${(error as Error).message}`);
    return null;
  }
}

function getTransitionValidator(): ValidatorFunction | null {
  transitionValidator = loadValidator(
    resolve(__dirname, '../schemas/resource-lifecycle-transition.schema.json'),
    transitionValidator,
  );
  return transitionValidator;
}

function getActivePointerValidator(): ValidatorFunction | null {
  activePointerValidator = loadValidator(
    resolve(__dirname, '../schemas/resource-active-pointer.schema.json'),
    activePointerValidator,
  );
  return activePointerValidator;
}

function validateWithSchema(
  value: unknown,
  schemaValidator: ValidatorFunction | null,
  label: string,
): void {
  if (!schemaValidator) {
    return;
  }
  if (schemaValidator(value)) {
    return;
  }
  const details = (schemaValidator.errors || [])
    .map((error) => `${error.instancePath || 'root'} ${error.message || 'invalid'}`)
    .join('; ');
  throw new Error(`Invalid ${label}: ${details}`);
}

export function validateTransitionRecord(record: TransitionRecord): void {
  validateWithSchema(record, getTransitionValidator(), 'lifecycle transition');
}

export function validateActivePointerDocument(document: ActivePointerDocument): void {
  validateWithSchema(document, getActivePointerValidator(), 'active pointer document');
}

export class InvalidTransitionError extends Error {
  readonly from: LifecycleState | 'init';
  readonly to: LifecycleState;
  readonly resourceId: string;

  constructor(
    from: LifecycleState | 'init',
    to: LifecycleState,
    resourceId: string,
  ) {
    super(`Illegal lifecycle transition for ${resourceId}: ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
    this.from = from;
    this.to = to;
    this.resourceId = resourceId;
  }
}

export class PointerLockError extends Error {
  readonly lockFile: string;

  constructor(lockFile: string) {
    super(`Failed to acquire pointer lock: ${lockFile}`);
    this.name = 'PointerLockError';
    this.lockFile = lockFile;
  }
}

export class PromotionGateError extends Error {
  readonly reasons: string[];

  constructor(reasons: string[]) {
    super(`Promotion gate rejected candidate: ${reasons.join('; ')}`);
    this.name = 'PromotionGateError';
    this.reasons = reasons;
  }
}

export class NoPreviousStableError extends Error {
  constructor(resourceKey: string) {
    super(`No previous stable version exists for ${resourceKey}`);
    this.name = 'NoPreviousStableError';
  }
}

export function canTransition(from: LifecycleState | null | 'init', to: LifecycleState): boolean {
  const normalized = from ?? 'init';
  return LEGAL_TRANSITIONS[normalized].includes(to);
}

function normalizeState(from: LifecycleState | null): LifecycleState | 'init' {
  return from ?? 'init';
}

function pointerKey(type: ResourceType, name: string): string {
  return `${type}:${name}`;
}

function pointerMatches(slot: PointerSlot | undefined, resourceRef: ResourceRef): boolean {
  return Boolean(slot && slot.id === resourceRef.id && slot.version === resourceRef.version);
}

function toPointerSlot(resourceRef: ResourceRef, updatedAt: string, trafficPercent?: number): PointerSlot {
  return {
    id: resourceRef.id,
    version: resourceRef.version,
    updatedAt,
    ...(trafficPercent !== undefined ? { trafficPercent } : {}),
  };
}

function trimHistory(history: PointerSlot[] | undefined, maxDepth: number): PointerSlot[] | undefined {
  if (!history || history.length === 0 || maxDepth <= 0) {
    return undefined;
  }
  return history.slice(0, maxDepth);
}

function findResourceByRef(resourceRef: ResourceRef, repoDir?: string): ResourceVersion | null {
  return listResources({}, repoDir).find((record) => record.id === resourceRef.id && record.version === resourceRef.version) || null;
}

function getResourceVersionForRef(resourceRef: LifecycleResourceRef, repoDir?: string): ResourceVersion | null {
  return getResource(resourceRef.id, resourceRef.version, repoDir)
    || listResources({ type: resourceRef.type, name: resourceRef.name }, repoDir)
      .find((record) => record.version === resourceRef.version)
    || null;
}

function listTransitionRecords(repoDir?: string): TransitionRecord[] {
  const { transitionLog } = resolveLifecycleFiles(repoDir);
  if (!existsSync(transitionLog)) {
    return [];
  }

  const content = readFileSync(transitionLog, 'utf-8');
  const records: TransitionRecord[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    try {
      const record = JSON.parse(line) as TransitionRecord;
      validateTransitionRecord(record);
      records.push(record);
    } catch {
      if (!hasWarnedMalformedLifecycle) {
        console.warn('[resource-lifecycle] Skipping malformed lifecycle transition records');
        hasWarnedMalformedLifecycle = true;
      }
    }
  }
  return records;
}

export function resolveLifecycleFiles(repoDir?: string): {
  transitionLog: string;
  activePointers: string;
  lockFile: string;
} {
  const registryDir = resolveRegistryDir(repoDir);
  return {
    transitionLog: resolve(registryDir, TRANSITIONS_FILENAME),
    activePointers: resolve(registryDir, ACTIVE_POINTERS_FILENAME),
    lockFile: resolve(registryDir, ACTIVE_POINTERS_LOCK),
  };
}

export function generateTransitionId(): string {
  return `tr_${Date.now().toString(36)}-${randomBytes(8).toString('hex')}`;
}

function emptyPointerDocument(): ActivePointerDocument {
  return {
    schemaVersion: LIFECYCLE_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    entries: {},
  };
}

export function readActivePointers(repoDir?: string): ActivePointerDocument {
  const { activePointers } = resolveLifecycleFiles(repoDir);
  if (!existsSync(activePointers)) {
    return emptyPointerDocument();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(activePointers, 'utf-8'));
  } catch (error) {
    throw new Error(
      `Failed to parse active pointers at ${activePointers}: ${(error as Error).message}. ` +
      `Back up ${activePointers} and delete it to regenerate from lifecycle history.`,
    );
  }
  validateActivePointerDocument(parsed as ActivePointerDocument);
  return parsed as ActivePointerDocument;
}

export function writeActivePointersAtomic(document: ActivePointerDocument, repoDir?: string): void {
  const { activePointers } = resolveLifecycleFiles(repoDir);
  validateActivePointerDocument(document);
  mkdirSync(dirname(activePointers), { recursive: true });
  const tmpPath = resolve(dirname(activePointers), `.active-pointers-${randomUUID()}.tmp`);
  writeFileSync(tmpPath, `${JSON.stringify(document, null, 2)}\n`, 'utf-8');
  renameSync(tmpPath, activePointers);
}

export async function withPointerLock<T>(repoDir: string | undefined, fn: () => Promise<T> | T): Promise<T> {
  const { lockFile } = resolveLifecycleFiles(repoDir);
  const delays = [25, 50, 100, 200, 400];
  mkdirSync(dirname(lockFile), { recursive: true });

  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      writeFileSync(lockFile, `${process.pid}\n`, { encoding: 'utf-8', flag: 'wx' });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' || attempt === delays.length) {
        throw new PointerLockError(lockFile);
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, delays[attempt]));
      continue;
    }

    try {
      return await fn();
    } finally {
      if (existsSync(lockFile)) {
        unlinkSync(lockFile);
      }
    }
  }

  throw new PointerLockError(lockFile);
}

export function getCurrentState(
  type: ResourceType,
  name: string,
  resourceVersion: string,
  repoDir?: string,
): LifecycleState | null {
  const transitions = listTransitionRecords(repoDir);
  for (let index = transitions.length - 1; index >= 0; index -= 1) {
    const record = transitions[index];
    if (record.resource.type === type && record.resource.name === name && record.resource.version === resourceVersion) {
      return record.toState;
    }
  }
  return null;
}

function currentPointerState(entry: PointerEntry | undefined, resourceRef: ResourceRef): LifecycleState | null {
  if (!entry) {
    return null;
  }
  if (pointerMatches(entry.canary, resourceRef)) {
    return 'canary';
  }
  if (pointerMatches(entry.stable, resourceRef)) {
    return 'stable';
  }
  if (pointerMatches(entry.previousStable, resourceRef)) {
    return 'rolled_back';
  }
  return null;
}

function inferCurrentState(resource: LifecycleResourceRef, repoDir?: string): LifecycleState | null {
  const fromLog = getCurrentState(resource.type, resource.name, resource.version, repoDir);
  if (fromLog) {
    return fromLog;
  }
  return currentPointerState(readActivePointers(repoDir).entries[pointerKey(resource.type, resource.name)], resource);
}

export function recordTransition(
  input: Omit<TransitionRecord, 'schemaVersion' | 'transitionId' | 'timestamp'> & {
    schemaVersion?: string;
    transitionId?: string;
    timestamp?: string;
  },
  repoDir?: string,
): TransitionRecord | null {
  if (getRegistryConfig(repoDir).enabled === false) {
    return null;
  }

  const currentState = inferCurrentState(input.resource, repoDir);
  const expectedFrom = normalizeState(currentState);
  const requestedFrom = normalizeState(input.fromState);
  const allowsImplicitDraft = currentState === null && requestedFrom === 'draft';
  if (requestedFrom !== expectedFrom && !allowsImplicitDraft) {
    throw new InvalidTransitionError(expectedFrom, input.toState, input.resource.id);
  }
  if (!canTransition(allowsImplicitDraft ? 'draft' : currentState, input.toState)) {
    throw new InvalidTransitionError(expectedFrom, input.toState, input.resource.id);
  }

  const record: TransitionRecord = {
    schemaVersion: input.schemaVersion || LIFECYCLE_SCHEMA_VERSION,
    transitionId: input.transitionId || generateTransitionId(),
    timestamp: input.timestamp || new Date().toISOString(),
    resource: input.resource,
    fromState: input.fromState,
    toState: input.toState,
    actor: input.actor,
    rationale: input.rationale,
    ...(input.evidence?.length ? { evidence: input.evidence } : {}),
    ...(input.previousStable ? { previousStable: input.previousStable } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
  validateTransitionRecord(record);

  const { transitionLog } = resolveLifecycleFiles(repoDir);
  mkdirSync(dirname(transitionLog), { recursive: true });
  appendJsonlRecord(transitionLog, record);
  return record;
}

function gatherMatchingManifestSessionIds(resourceRef: ResourceRef, repoDir?: string): string[] {
  const manifestDir = resolveManifestDir(repoDir);
  if (!existsSync(manifestDir)) {
    return [];
  }
  const sessionIds = new Set<string>();
  for (const manifest of readJsonManifestFiles(manifestDir)) {
    if (manifest.resources?.some((ref: ResourceRef) => ref.id === resourceRef.id && ref.version === resourceRef.version)) {
      sessionIds.add(manifest.sessionId);
    }
  }
  return [...sessionIds];
}

function readJsonManifestFiles(manifestDir: string): Array<{ sessionId: string; resources?: ResourceRef[] }> {
  if (!existsSync(manifestDir)) {
    return [];
  }
  return readDirJson(manifestDir)
    .map((path) => {
      try {
        return JSON.parse(readFileSync(path, 'utf-8')) as { sessionId: string; resources?: ResourceRef[] };
      } catch {
        return null;
      }
    })
    .filter((entry): entry is { sessionId: string; resources?: ResourceRef[] } => Boolean(entry));
}

function readDirJson(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((entry: string) => entry.endsWith('.json'))
      .map((entry: string) => resolve(dir, entry));
  } catch {
    return [];
  }
}

export function collectEvidenceForResource(resourceRef: LifecycleResourceRef, repoDir?: string): Evidence[] {
  const resource = getResourceVersionForRef(resourceRef, repoDir);
  if (!resource) {
    return [];
  }

  const sessionIds = new Set(gatherMatchingManifestSessionIds(resource, repoDir));
  const evalsFile = resolveFromMainRepo('.wavemill/evals/evals.jsonl', repoDir);
  const records = readEvalRecords({ dir: resolveFromMainRepo('.wavemill/evals', repoDir) })
    .filter((record) => {
      if (record.manifestRef?.sessionId && sessionIds.has(record.manifestRef.sessionId)) {
        return true;
      }
      return false;
    });

  const evidence: Evidence[] = [];
  if (records.length > 0) {
    const scores = records.map((record) => record.score);
    const meanScore = scores.reduce((sum, score) => sum + score, 0) / scores.length;
    evidence.push({
      kind: 'eval',
      path: evalsFile,
      recordIds: records.map((record) => record.id),
      aggregate: {
        meanScore,
        count: records.length,
        minScore: Math.min(...scores),
      },
    });
  }

  const challengeRecords = readChallengeComparisons(resolveFromMainRepo('.wavemill/evals', repoDir))
    .filter((record) => challengeRecordMatchesSessions(record, sessionIds));
  if (challengeRecords.length > 0) {
    evidence.push({
      kind: 'challenge',
      path: resolveFromMainRepo('.wavemill/evals/challenge-records.jsonl', repoDir),
      challengePairIds: challengeRecords.map((record) => record.challengePairId),
      wins: challengeRecords.filter((record) => challengeRecordIsWin(record, resource)).length,
      total: challengeRecords.length,
    });
  }

  return evidence;
}

function challengeRecordMatchesSessions(record: ChallengeComparison, sessionIds: Set<string>): boolean {
  if (sessionIds.size === 0) {
    return false;
  }
  for (const sessionId of sessionIds) {
    if (record.primaryPrUrl.includes(sessionId) || record.challengerPrUrl.includes(sessionId)) {
      return true;
    }
  }
  return false;
}

function challengeRecordIsWin(record: ChallengeComparison, resource: ResourceVersion): boolean {
  return record.winner === 'challenger'
    ? record.challengerModel === (resource.metadata?.runtimeModel ?? resource.metadata?.teacherModel ?? resource.version)
    : record.primaryModel === (resource.metadata?.runtimeModel ?? resource.metadata?.teacherModel ?? resource.version);
}

export function evaluatePromotion(
  resourceRef: LifecycleResourceRef,
  targetState: 'canary' | 'stable',
  repoDir?: string,
  configOverrides?: Partial<ReturnType<typeof getLifecycleConfig>>,
): PromotionEvaluation {
  const config = {
    ...getLifecycleConfig(repoDir),
    ...configOverrides,
    promotion: {
      ...getLifecycleConfig(repoDir).promotion,
      ...configOverrides?.promotion,
    },
    canary: {
      ...getLifecycleConfig(repoDir).canary,
      ...configOverrides?.canary,
    },
  };
  const resource = getResourceVersionForRef(resourceRef, repoDir);
  if (!resource) {
    return {
      eligible: false,
      reasons: ['resource version is not registered'],
      evidence: [],
      aggregate: {
        evalCount: 0,
        meanScore: null,
        minScore: null,
        challengeWins: 0,
        challengeTotal: 0,
        differsFromStable: false,
      },
    };
  }

  const evidence = collectEvidenceForResource(resourceRef, repoDir);
  const evalEvidence = evidence.filter((entry): entry is EvalEvidence => entry.kind === 'eval');
  const challengeEvidence = evidence.filter((entry): entry is ChallengeEvidence => entry.kind === 'challenge');
  const evalCount = evalEvidence.reduce((sum, entry) => sum + entry.aggregate.count, 0);
  const totalScore = evalEvidence.reduce((sum, entry) => sum + (entry.aggregate.meanScore * entry.aggregate.count), 0);
  const meanScore = evalCount > 0 ? totalScore / evalCount : null;
  const minScore = evalEvidence.length > 0
    ? Math.min(...evalEvidence.map((entry) => entry.aggregate.minScore))
    : null;
  const challengeWins = challengeEvidence.reduce((sum, entry) => sum + entry.wins, 0);
  const challengeTotal = challengeEvidence.reduce((sum, entry) => sum + entry.total, 0);
  const currentEntry = readActivePointers(repoDir).entries[pointerKey(resource.type, resource.name)];
  const currentStable = currentEntry?.stable ? findResourceByRef(currentEntry.stable, repoDir) : null;
  const differsFromStable = currentStable ? currentStable.contentHash !== resource.contentHash : true;
  const reasons: string[] = [];

  if (targetState === 'canary') {
    if (!differsFromStable) {
      reasons.push('candidate content matches current stable');
    }
  } else {
    if (evalCount < config.promotion.minEvalRecords) {
      reasons.push(`requires at least ${config.promotion.minEvalRecords} eval records`);
    }
    if (meanScore === null || meanScore < config.promotion.minMeanScore) {
      reasons.push(`requires mean score >= ${config.promotion.minMeanScore}`);
    }
    if (config.promotion.requireAllAboveAssisted && (minScore === null || minScore < 0.5)) {
      reasons.push('requires every eval score to be at least 0.5');
    }
    if (config.promotion.requireChallengeWin) {
      if (challengeTotal === 0) {
        console.warn('[resource-lifecycle] Challenge win required but no challenge evidence was found');
        reasons.push('requires at least one winning challenge');
      } else if (challengeWins < 1) {
        reasons.push('requires at least one winning challenge');
      }
    }
  }

  return {
    eligible: reasons.length === 0,
    reasons,
    evidence,
    aggregate: {
      evalCount,
      meanScore,
      minScore,
      challengeWins,
      challengeTotal,
      differsFromStable,
    },
  };
}

export async function promote(
  resourceRef: LifecycleResourceRef,
  options: PromoteOptions,
  repoDir?: string,
): Promise<PromoteResult | null> {
  if (getRegistryConfig(repoDir).enabled === false) {
    return null;
  }

  const resource = getResourceVersionForRef(resourceRef, repoDir);
  if (!resource) {
    throw new Error(`Unknown resource version: ${resourceRef.id}@${resourceRef.version}`);
  }

  const fromState = inferCurrentState(resourceRef, repoDir) ?? 'draft';
  if (!canTransition(fromState, options.toState)) {
    throw new InvalidTransitionError(fromState, options.toState, resourceRef.id);
  }

  let evaluation: PromotionEvaluation | null = null;
  if (options.toState === 'stable' && !options.force) {
    evaluation = evaluatePromotion(resourceRef, options.toState, repoDir);
    if (!evaluation.eligible) {
      throw new PromotionGateError(evaluation.reasons);
    }
  } else if (options.toState === 'canary') {
    evaluation = evaluatePromotion(resourceRef, options.toState, repoDir);
    if (!evaluation.eligible) {
      throw new PromotionGateError(evaluation.reasons);
    }
  }

  return withPointerLock(repoDir, () => {
    const now = new Date().toISOString();
    const document = readActivePointers(repoDir);
    const key = pointerKey(resource.type, resource.name);
    const entry = { ...(document.entries[key] || {}) };
    const previousStable = entry.stable ? { id: entry.stable.id, version: entry.stable.version } : undefined;
    let nextEntry: PointerEntry = entry;

    if (options.toState === 'canary') {
      nextEntry = {
        ...entry,
        canary: toPointerSlot(
          resourceRef,
          now,
          options.trafficPercent ?? getLifecycleConfig(repoDir).canary.defaultTrafficPercent,
        ),
      };
    } else {
      const history = [
        ...(entry.stable ? [entry.stable] : []),
        ...(entry.history || []),
      ];
      nextEntry = {
        ...entry,
        stable: toPointerSlot(resourceRef, now),
        previousStable: entry.stable ? { ...entry.stable } : entry.previousStable,
        canary: pointerMatches(entry.canary, resourceRef) ? undefined : entry.canary,
        history: trimHistory(history, getLifecycleConfig(repoDir).rollbackHistoryDepth),
      };
    }

    const record = recordTransition({
      resource: resourceRef,
      fromState,
      toState: options.toState,
      actor: options.actor,
      rationale: options.rationale,
      evidence: options.evidence || evaluation?.evidence,
      previousStable,
      metadata: {
        ...(options.force ? { force: true } : {}),
        ...(options.trafficPercent !== undefined ? { trafficPercent: options.trafficPercent } : {}),
      },
    }, repoDir);
    if (!record) {
      return null;
    }

    document.entries[key] = nextEntry;
    document.updatedAt = now;
    writeActivePointersAtomic(document, repoDir);
    return { record, pointerEntry: nextEntry };
  });
}

export async function reject(
  resourceRef: LifecycleResourceRef,
  options: RejectOptions,
  repoDir?: string,
): Promise<PromoteResult | null> {
  if (getRegistryConfig(repoDir).enabled === false) {
    return null;
  }
  const resource = getResourceVersionForRef(resourceRef, repoDir);
  if (!resource) {
    throw new Error(`Unknown resource version: ${resourceRef.id}@${resourceRef.version}`);
  }
  const fromState = inferCurrentState(resourceRef, repoDir) ?? 'draft';
  if (!['draft', 'canary'].includes(fromState)) {
    throw new InvalidTransitionError(fromState, 'rejected', resourceRef.id);
  }

  return withPointerLock(repoDir, () => {
    const document = readActivePointers(repoDir);
    const key = pointerKey(resource.type, resource.name);
    const entry = { ...(document.entries[key] || {}) };
    const record = recordTransition({
      resource: resourceRef,
      fromState,
      toState: 'rejected',
      actor: options.actor,
      rationale: options.rationale,
    }, repoDir);
    if (!record) {
      return null;
    }
    if (pointerMatches(entry.canary, resourceRef)) {
      entry.canary = undefined;
    }
    document.entries[key] = entry;
    document.updatedAt = new Date().toISOString();
    writeActivePointersAtomic(document, repoDir);
    return { record, pointerEntry: entry };
  });
}

export async function rollback(
  type: ResourceType,
  name: string,
  options: RollbackOptions,
  repoDir?: string,
): Promise<{ rolledBack: TransitionRecord; restored: TransitionRecord; pointerEntry: PointerEntry } | null> {
  if (getRegistryConfig(repoDir).enabled === false) {
    return null;
  }

  return withPointerLock(repoDir, () => {
    const document = readActivePointers(repoDir);
    const key = pointerKey(type, name);
    const entry = { ...(document.entries[key] || {}) };
    if (!entry.previousStable) {
      throw new NoPreviousStableError(key);
    }
    if (!entry.stable) {
      throw new Error(`Cannot rollback ${key} without a current stable version`);
    }

    const currentStableResource = findResourceByRef(entry.stable, repoDir);
    const previousStableResource = findResourceByRef(entry.previousStable, repoDir);
    if (!currentStableResource || !previousStableResource) {
      throw new Error(`Rollback resources missing from registry for ${key}`);
    }

    const rolledBackRecord = recordTransition({
      resource: {
        id: currentStableResource.id,
        version: currentStableResource.version,
        type,
        name,
      },
      fromState: 'stable',
      toState: 'rolled_back',
      actor: options.actor,
      rationale: options.rationale,
      previousStable: { id: entry.previousStable.id, version: entry.previousStable.version },
    }, repoDir);
    const restoredRecord = recordTransition({
      resource: {
        id: previousStableResource.id,
        version: previousStableResource.version,
        type,
        name,
      },
      fromState: 'rolled_back',
      toState: 'stable',
      actor: options.actor,
      rationale: options.rationale,
      previousStable: { id: entry.stable.id, version: entry.stable.version },
    }, repoDir);

    if (!rolledBackRecord || !restoredRecord) {
      return null;
    }

    const history = [
      entry.stable,
      ...(entry.history || []),
    ];
    const nextEntry: PointerEntry = {
      stable: { ...entry.previousStable, updatedAt: new Date().toISOString() },
      previousStable: { ...entry.stable },
      canary: entry.canary,
      history: trimHistory(history, getLifecycleConfig(repoDir).rollbackHistoryDepth),
    };
    document.entries[key] = nextEntry;
    document.updatedAt = new Date().toISOString();
    writeActivePointersAtomic(document, repoDir);
    return { rolledBack: rolledBackRecord, restored: restoredRecord, pointerEntry: nextEntry };
  });
}

export async function cancelCanary(
  type: ResourceType,
  name: string,
  options: RollbackOptions,
  repoDir?: string,
): Promise<PromoteResult | null> {
  if (getRegistryConfig(repoDir).enabled === false) {
    return null;
  }

  return withPointerLock(repoDir, () => {
    const document = readActivePointers(repoDir);
    const key = pointerKey(type, name);
    const entry = { ...(document.entries[key] || {}) };
    if (!entry.canary) {
      throw new Error(`No active canary for ${key}`);
    }
    const canaryResource = findResourceByRef(entry.canary, repoDir);
    if (!canaryResource) {
      throw new Error(`Canary resource missing from registry for ${key}`);
    }
    const record = recordTransition({
      resource: {
        id: canaryResource.id,
        version: canaryResource.version,
        type,
        name,
      },
      fromState: 'canary',
      toState: 'rolled_back',
      actor: options.actor,
      rationale: options.rationale,
    }, repoDir);
    if (!record) {
      return null;
    }
    entry.canary = undefined;
    document.entries[key] = entry;
    document.updatedAt = new Date().toISOString();
    writeActivePointersAtomic(document, repoDir);
    return { record, pointerEntry: entry };
  });
}

export function listTransitionsForResource(type: ResourceType, name: string, repoDir?: string): TransitionRecord[] {
  return listTransitionRecords(repoDir).filter((record) => record.resource.type === type && record.resource.name === name);
}

export function getPointerEntry(type: ResourceType, name: string, repoDir?: string): PointerEntry | null {
  return readActivePointers(repoDir).entries[pointerKey(type, name)] || null;
}

export function shouldRouteToCanary(entry: PointerEntry | null | undefined, sessionSeed?: string): boolean {
  if (!entry?.canary) {
    return false;
  }
  const trafficPercent = entry.canary.trafficPercent ?? 0;
  if (trafficPercent <= 0) {
    return false;
  }
  if (trafficPercent >= 100) {
    return true;
  }
  const seed = sessionSeed || process.env.WAVEMILL_SESSION;
  if (seed) {
    let total = 0;
    for (const char of seed) {
      total += char.charCodeAt(0);
    }
    return (total % 100) < trafficPercent;
  }
  return (randomBytes(1)[0] % 100) < trafficPercent;
}

export function buildLifecycleResourceRef(resource: ResourceVersion): LifecycleResourceRef {
  return {
    id: resource.id,
    version: resource.version,
    type: resource.type,
    name: resource.name,
  };
}
