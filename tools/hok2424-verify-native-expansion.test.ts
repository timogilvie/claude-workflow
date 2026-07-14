import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { splitTaskPacket } from '../shared/lib/task-packet-utils.ts';
import {
  assessArtifactCompleteness,
  assessCertificationGate,
  assessFallbackSemantics,
  assessHappyPath,
  assessMutationPolicy,
  assessProvenance,
  assessStructure,
  extractNumberedSections,
  getConfiguredNativeExpansionModels,
  pickRequestedModel,
  type HappyPathObservation,
  type MutationObservation,
} from './hok2424-verify-native-expansion.ts';

function makePacket(): string {
  return [
    '# Task Packet',
    '',
    '## Objective',
    '',
    'Quick reference.',
    '',
    '<!-- SPLIT: HEADER ABOVE, DETAILS BELOW -->',
    '',
    '## 1. Objective',
    '',
    'Verify task expansion.',
    '',
    '## 2. Technical Context',
    '',
    'Context.',
    '',
    '## 3. Implementation Approach',
    '',
    'Approach.',
    '',
    '## 4. Success Criteria',
    '',
    'Criteria.',
    '',
    '## 5. Implementation Constraints',
    '',
    'Constraints.',
    '',
    '## 6. Validation Steps',
    '',
    'Validation.',
    '',
    '## 7. Definition of Done',
    '',
    'Done.',
    '',
    '## 8. Rollback Plan',
    '',
    'Rollback.',
    '',
    '## 9. Release Readiness',
    '',
    '- **database_change_risk**: none',
    '',
    '## 10. Proposed Labels',
    '',
    '- verification',
  ].join('\n');
}

function makeHappyObservation(): { observation: HappyPathObservation; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'hok2424-tool-test-'));
  const artifactsDir = join(root, 'artifacts');
  mkdirSync(artifactsDir, { recursive: true });
  const text = makePacket();
  const split = splitTaskPacket(text);
  const taskPacket = join(artifactsDir, 'task-packet.md');
  const header = join(artifactsDir, 'task-packet-header.md');
  const details = join(artifactsDir, 'task-packet-details.md');
  const sidecar = join(artifactsDir, 'task-packet.native.json');
  const transcript = join(artifactsDir, 'transcript.jsonl');
  const manifest = join(artifactsDir, 'manifest.json');
  const registry = join(artifactsDir, 'resources.jsonl');

  writeFileSync(taskPacket, `${text}\n`, 'utf-8');
  writeFileSync(header, split.header, 'utf-8');
  writeFileSync(details, split.details, 'utf-8');
  writeFileSync(sidecar, '{}\n', 'utf-8');
  writeFileSync(transcript, '{"type":"session_started"}\n', 'utf-8');
  writeFileSync(manifest, '{}\n', 'utf-8');
  writeFileSync(registry, '{}\n', 'utf-8');

  return {
    observation: {
      repoDir: root,
      session: 'session-1',
      requestedModel: 'qwen/qwen3-coder',
      live: false,
      text,
      native: {
        agent: 'native-openrouter',
        model: 'qwen/qwen3-coder',
        provider: 'openrouter',
        api: 'openai-completions',
        transcriptPath: transcript,
        cost: 0.42,
        durationMs: 100,
        stopReason: 'stop',
        totalInputTokens: 120,
        totalOutputTokens: 60,
        deniedToolCalls: [],
      },
      sidecar: {
        agent: 'native-openrouter',
        model: 'qwen/qwen3-coder',
        provider: 'openrouter',
        api: 'openai-completions',
        transcriptPath: transcript,
        cost: 0.42,
        durationMs: 100,
        stopReason: 'stop',
        totalInputTokens: 120,
        totalOutputTokens: 60,
        deniedToolCalls: [],
      },
      artifacts: {
        taskPacket,
        header,
        details,
        sidecar,
        transcript,
        manifest,
        registry,
      },
      validationPassed: true,
      validationIssueCount: 0,
      manifest: {
        manifestSchemaVersion: '1.0.0',
        sessionId: 'session-1',
        workflowType: 'verification',
        createdAt: '2026-07-13T00:00:00.000Z',
        updatedAt: '2026-07-13T00:00:00.000Z',
        phases: {
          'task-expansion': [{ id: 'runtime:test', version: 'sha256:test' }],
        },
        resources: [{ id: 'runtime:test', version: 'sha256:test' }],
        digest: 'digest',
      },
      resources: [{
        schemaVersion: '1.0.0',
        id: 'runtime:test@sha256:test',
        type: 'runtime',
        name: 'runtime:test',
        version: 'sha256:test',
        contentHash: 'abc',
        createdAt: '2026-07-13T00:00:00.000Z',
      }],
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe('hok2424 native expansion verification helpers', () => {
  it('reads configured task-expansion models and enforces explicit model selection', () => {
    const config = {
      nativeAgent: {
        providers: {
          openrouter: {
            models: [
              'moonshotai/kimi-k2.7-code',
              'qwen/qwen3-coder',
            ],
          },
        },
      },
    };

    assert.deepEqual(getConfiguredNativeExpansionModels(config), [
      'moonshotai/kimi-k2.7-code',
      'qwen/qwen3-coder',
    ]);
    assert.equal(pickRequestedModel(config), 'qwen/qwen3-coder');
    assert.throws(() => pickRequestedModel(config, 'z-ai/glm-5.2'), /not configured/i);
  });

  it('fails C1 when the expansion resolves to the wrong provider', () => {
    const { observation, cleanup } = makeHappyObservation();
    try {
      observation.native.provider = 'openai';
      const result = assessHappyPath(observation);
      assert.equal(result.status, 'fail');
      assert.match(result.detail, /provider=openai/);
    } finally {
      cleanup();
    }
  });

  it('fails C2 when packet artifacts are missing or validation failed', () => {
    const { observation, cleanup } = makeHappyObservation();
    try {
      rmSync(observation.artifacts.header, { force: true });
      const result = assessArtifactCompleteness(observation);
      assert.equal(result.status, 'fail');
      assert.match(result.detail, /missing artifact paths/i);
    } finally {
      cleanup();
    }
  });

  it('fails C3 when provenance fields are incomplete', () => {
    const { observation, cleanup } = makeHappyObservation();
    try {
      observation.sidecar = {
        ...observation.sidecar,
        api: '',
        transcriptPath: '',
        deniedToolCalls: undefined as unknown as [],
      };
      const result = assessProvenance(observation);
      assert.equal(result.status, 'fail');
      assert.match(result.detail, /missing transcriptPath/);
      assert.match(result.detail, /missing provider\/model\/api identity/);
    } finally {
      cleanup();
    }
  });

  it('fails C4 when tracked content changes or the denial is missing', () => {
    const observation: MutationObservation = {
      requestedModel: 'qwen/qwen3-coder',
      deniedToolCalls: [],
      gitStatusBefore: '',
      gitStatusAfter: ' M notes.md',
      trackedHashBefore: 'before',
      trackedHashAfter: 'after',
      transcriptPath: '/tmp/transcript.jsonl',
      manifestPath: '/tmp/manifest.json',
    };

    const result = assessMutationPolicy(observation);
    assert.equal(result.status, 'fail');
    assert.match(result.detail, /denial missing/i);
    assert.match(result.detail, /git status changed/i);
    assert.match(result.detail, /hash changed/i);
  });

  it('fails C5 when missing or stale certification does not fail closed', () => {
    const result = assessCertificationGate([
      { caseId: 'missing', status: 'ready' },
      { caseId: 'stale', status: 'uncertified', reason: 'reason=missing_artifact' },
      { caseId: 'fresh', status: 'ready' },
    ]);

    assert.equal(result.status, 'fail');
    assert.match(result.detail, /missing certification/i);
    assert.match(result.detail, /stale certification/i);
  });

  it('fails C6 when fallback warnings are absent or the native error is swallowed', () => {
    const result = assessFallbackSemantics({
      fallbackText: 'claude fallback',
      warningText: '',
      nonAvailabilityError: '',
    });

    assert.equal(result.status, 'fail');
    assert.match(result.detail, /warning was not surfaced/i);
    assert.match(result.detail, /swallowed/i);
  });

  it('extracts numbered task-packet sections and fails C7 when one is missing', () => {
    const baseline = makePacket();
    const native = baseline.replace('## 6. Validation Steps\n\nValidation.\n\n', '');

    assert.ok(extractNumberedSections(baseline).includes('6. Validation Steps'));
    const result = assessStructure({
      baselinePath: '/repo/features/.../task-packet.md',
      baselineSections: extractNumberedSections(baseline),
      nativeSections: extractNumberedSections(native),
      missingSections: ['6. Validation Steps'],
    });

    assert.equal(result.status, 'fail');
    assert.match(result.detail, /6\. Validation Steps/);
  });
});
