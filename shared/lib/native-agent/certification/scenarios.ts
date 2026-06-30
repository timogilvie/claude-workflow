/**
 * Certification scenario catalog.
 *
 * Defines the scenario type model, classification taxonomy, and the default
 * catalog of deterministic certification scenarios for native provider/model
 * phase certification.
 *
 * ## Design
 *
 * Each CertificationScenario carries an executable `assertion` function (iff
 * `classification === 'deterministic'`) that runs pure, offline checks against
 * scripted providers, compat fixtures, and in-memory helpers. Live-judged
 * scenarios carry no assertion and are returned as `not-run` by the runner.
 *
 * @module native-agent/certification/scenarios
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CERTIFICATION_SCHEMA_VERSION,
  PHASE_ORDER,
  phaseSatisfies,
  type CertificationPhase,
  type NativeCertificationArtifact,
} from './schema.ts';
import { checkCertificationEligibility } from '../certification/loader.ts';
import { writeCertification } from '../certification/store.ts';
import { findFixture } from '../fixtures/compat/index.ts';
import {
  createPiToolCallingProvider,
  registerScriptedPiProvider,
  type ProviderConversationState,
} from '../provider.ts';
import {
  TranscriptWriter,
  type TranscriptSessionStarted,
  type TranscriptSessionEnded,
} from '../transcript.ts';
import { validateToolCompat } from '../tool-compat-validator.ts';
import type { ModelRegistry, NativeProviderName, PiTransportKind } from '../../model-registry.ts';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ScenarioClassification = 'deterministic' | 'live-judged';

export type ScenarioCategory = 'tool' | 'usage' | 'transcript' | 'phase';

export type HarnessUnsupportedReason =
  | 'fixture-not-found'
  | 'capability-validator-rejected'
  | 'shape-mismatch'
  | 'registry-missing-model';

export type HarnessNotRunReason = 'requires-live-judge';

export type ScenarioAssertionOutcome =
  | { kind: 'pass' }
  | { kind: 'fail'; detail: string }
  | { kind: 'unsupported'; reason: HarnessUnsupportedReason; detail: string };

export interface ScenarioContext {
  provider: NativeProviderName;
  model: string;
  transport: PiTransportKind;
  registry?: ModelRegistry;
}

export type ScenarioAssertion = (ctx: ScenarioContext) => Promise<ScenarioAssertionOutcome>;

export interface CertificationScenario {
  id: string;
  phase: CertificationPhase;
  category: ScenarioCategory;
  classification: ScenarioClassification;
  description: string;
  /** Required iff classification === 'deterministic' */
  assertion?: ScenarioAssertion;
  /** Optional human-readable caveat surfaced into the report's knownLimitations */
  knownLimitation?: string;
}

// ---------------------------------------------------------------------------
// Module-level counters for unique API names across test runs
// ---------------------------------------------------------------------------

let _usageApiSeq = 0;
let _transcriptSeq = 0;

// ---------------------------------------------------------------------------
// Concrete assertions
// ---------------------------------------------------------------------------

async function assertGitStatusOpenAiCompletions(ctx: ScenarioContext): Promise<ScenarioAssertionOutcome> {
  const TOOL = 'git_status';
  const TRANSPORT = 'openai-completions' as PiTransportKind;

  const fixture = findFixture(TOOL, TRANSPORT);
  if (!fixture) {
    return {
      kind: 'unsupported',
      reason: 'fixture-not-found',
      detail: `Tool "${TOOL}" has no compat fixture for transport "${TRANSPORT}"`,
    };
  }

  const result = validateToolCompat({
    model: ctx.model,
    provider: ctx.provider,
    transport: TRANSPORT,
    tools: [
      {
        name: fixture.toolDescriptor.name,
        description: fixture.toolDescriptor.description,
        executionMode: 'sequential',
      },
    ],
    registry: ctx.registry,
  });

  if (!result.ok) {
    return {
      kind: 'unsupported',
      reason: 'capability-validator-rejected',
      detail: result.diagnostics.map((d) => d.message).join('; '),
    };
  }

  return { kind: 'pass' };
}

async function assertUsageRecordsInputOutputTokens(ctx: ScenarioContext): Promise<ScenarioAssertionOutcome> {
  const api = `cert-harness-usage-${++_usageApiSeq}`;

  registerScriptedPiProvider({
    api,
    provider: ctx.provider,
    turns: [
      {
        content: [{ type: 'text', text: 'done' }],
        usage: { input: 100, output: 25 },
        stopReason: 'stop',
      },
    ],
  });

  const provider = createPiToolCallingProvider();
  const state: ProviderConversationState = {
    messages: [{ role: 'user', content: 'test' }],
  };

  const result = await provider.createTurn({
    model: { id: ctx.model, api, provider: ctx.provider },
    state,
  });

  if (result.usage.inputTokens !== 100) {
    return {
      kind: 'fail',
      detail: `Expected inputTokens=100, got ${result.usage.inputTokens}`,
    };
  }
  if (result.usage.outputTokens !== 25) {
    return {
      kind: 'fail',
      detail: `Expected outputTokens=25, got ${result.usage.outputTokens}`,
    };
  }

  return { kind: 'pass' };
}

async function assertTranscriptSessionStartedThenEnded(ctx: ScenarioContext): Promise<ScenarioAssertionOutcome> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'native-cert-harness-'));
  try {
    const sessionId = `cert-harness-transcript-${++_transcriptSeq}`;
    const transcriptPath = join(tmpDir, `${sessionId}.jsonl`);
    const api = ctx.transport === 'openai-responses' ? 'openai-responses' : 'openai-completions';

    const writer = new TranscriptWriter({
      sessionId,
      model: ctx.model,
      api,
      provider: ctx.provider,
      path: transcriptPath,
    });

    const now = Date.now();
    const sessionStarted: TranscriptSessionStarted = {
      seq: 0,
      sessionId,
      timestamp: now,
      type: 'session_started',
      model: ctx.model,
      api,
      provider: ctx.provider,
    };
    const sessionEnded: TranscriptSessionEnded = {
      seq: 1,
      sessionId,
      timestamp: now,
      type: 'session_ended',
      messageCount: 0,
    };

    writer.write(sessionStarted);
    writer.write(sessionEnded);

    const content = readFileSync(transcriptPath, 'utf-8');
    const events = content
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);

    if (events.length < 2) {
      return {
        kind: 'fail',
        detail: `Expected at least 2 events, got ${events.length}`,
      };
    }

    const first = events[0];
    const last = events[events.length - 1];

    if (first['type'] !== 'session_started') {
      return {
        kind: 'fail',
        detail: `Expected first event type=session_started, got ${String(first['type'])}`,
      };
    }
    if (last['type'] !== 'session_ended') {
      return {
        kind: 'fail',
        detail: `Expected last event type=session_ended, got ${String(last['type'])}`,
      };
    }
    if (first['sessionId'] !== sessionId) {
      return {
        kind: 'fail',
        detail: `Expected sessionId=${sessionId}, got ${String(first['sessionId'])}`,
      };
    }
    if (first['provider'] !== ctx.provider) {
      return {
        kind: 'fail',
        detail: `Expected provider=${ctx.provider}, got ${String(first['provider'])}`,
      };
    }
    if (first['model'] !== ctx.model) {
      return {
        kind: 'fail',
        detail: `Expected model=${ctx.model}, got ${String(first['model'])}`,
      };
    }

    return { kind: 'pass' };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function assertPhaseReadOnlySatisfies(_ctx: ScenarioContext): Promise<ScenarioAssertionOutcome> {
  if (!phaseSatisfies('read-only', 'read-only')) {
    return { kind: 'fail', detail: 'phaseSatisfies(read-only, read-only) should be true' };
  }
  if (!phaseSatisfies('patch', 'read-only')) {
    return { kind: 'fail', detail: 'phaseSatisfies(patch, read-only) should be true' };
  }
  if (phaseSatisfies('read-only', 'patch')) {
    return { kind: 'fail', detail: 'phaseSatisfies(read-only, patch) should be false' };
  }
  return { kind: 'pass' };
}

async function assertPhasePersistenceRoundtrip(ctx: ScenarioContext): Promise<ScenarioAssertionOutcome> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'native-cert-harness-'));
  try {
    // Use provider from ctx (valid path segment: 'openai' | 'openrouter'),
    // but hardcode model to avoid any path-segment issues from test model names.
    const provider = ctx.provider;
    const model = 'test-model';
    const suiteVersion = 'v1';

    const artifact: NativeCertificationArtifact = {
      schemaVersion: CERTIFICATION_SCHEMA_VERSION,
      provider,
      model,
      phase: 'read-only',
      suiteVersion,
      certifiedAt: new Date().toISOString(),
      scenarios: [{ scenarioId: 'roundtrip-test', passed: true }],
    };

    writeCertification(tmpDir, artifact);

    const eligibility = checkCertificationEligibility(
      tmpDir,
      provider,
      model,
      suiteVersion,
      'read-only',
      new Date(),
    );

    if (!eligibility.eligible) {
      return {
        kind: 'fail',
        detail: `Expected eligible: true, got eligible: false with reason: ${(eligibility as { reason: string }).reason}`,
      };
    }

    return { kind: 'pass' };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Default scenario catalog
// ---------------------------------------------------------------------------

// Expected-unsupported cases are covered by scenario-runner tests instead of
// permanent catalog entries because any unsupported deterministic scenario makes
// the harness fail aggregate certification.
const DEFAULT_SCENARIOS: CertificationScenario[] = [
  {
    id: 'tool.compat.git_status.openai-completions',
    phase: 'read-only',
    category: 'tool',
    classification: 'deterministic',
    description:
      'git_status compat fixture is present for openai-completions and passes tool compat validation for the given model/provider.',
    assertion: assertGitStatusOpenAiCompletions,
  },
  {
    id: 'usage.scripted.records-input-output-tokens',
    phase: 'read-only',
    category: 'usage',
    classification: 'deterministic',
    description:
      'A scripted Pi provider turn with explicit usage fields maps correctly to inputTokens/outputTokens via mapPiUsageToSessionModelUsage.',
    assertion: assertUsageRecordsInputOutputTokens,
  },
  {
    id: 'transcript.scripted.session_started_then_ended',
    phase: 'read-only',
    category: 'transcript',
    classification: 'deterministic',
    description:
      'A TranscriptWriter session produces a JSONL file where the first event is session_started and the last is session_ended with matching sessionId, provider, and model.',
    assertion: assertTranscriptSessionStartedThenEnded,
  },
  {
    id: 'phase.read-only.satisfies-read-only',
    phase: 'read-only',
    category: 'phase',
    classification: 'deterministic',
    description:
      'Phase ordering: read-only satisfies read-only; patch satisfies read-only; read-only does not satisfy patch.',
    assertion: assertPhaseReadOnlySatisfies,
  },
  {
    id: 'phase.fixture.persistence-roundtrip',
    phase: 'read-only',
    category: 'phase',
    classification: 'deterministic',
    description:
      'A valid NativeCertificationArtifact written via writeCertification and evaluated via checkCertificationEligibility returns eligible: true.',
    assertion: assertPhasePersistenceRoundtrip,
  },
  {
    id: 'live.judge.tool-output-summary-quality',
    phase: 'read-only',
    category: 'tool',
    classification: 'live-judged',
    description:
      'Live LLM judge evaluates the quality of tool-output summaries. Not runnable offline; returned as not-run by the deterministic harness.',
    knownLimitation: 'Live-judged scenarios require a paid provider call and are not run by the deterministic harness.',
  },
];

// Re-export PHASE_ORDER for catalog integrity checks
export { PHASE_ORDER };

/**
 * Return the default certification scenario catalog.
 *
 * Returns a fresh array (not a reference to the internal catalog) so callers
 * can safely add, remove, or reorder entries without affecting subsequent calls.
 */
export function getDefaultScenarios(): CertificationScenario[] {
  return [...DEFAULT_SCENARIOS];
}
