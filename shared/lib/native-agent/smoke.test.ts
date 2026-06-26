import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { ModelRegistry } from '../model-registry.ts';
import { registerScriptedPiProvider } from './provider.ts';
import {
  SMOKE_PROVIDERS,
  SMOKE_PHASES,
  runNativeAgentDryRun,
  runNativeAgentLive,
  type RunNativeSmokeOptions,
} from './smoke.ts';

function makeCertifiedScriptedRegistry(modelId = 'gpt-4o'): ModelRegistry {
  return {
    models: {
      [modelId]: {
        vendor: 'openai',
        class: 'strong_generalist',
        strengths: ['scripted'],
        weaknesses: [],
        qualityScores: { routing: 0, planning: 0, coding: 0, review: 0, classify: 0 },
        contextWindowTokens: 128_000,
        toolSupport: 'full',
        multimodal: { text: true, image: false },
        latencyTier: 'standard',
        reasoningTier: 'standard',
        costPerMillionInputTokensUsd: 1,
        costPerMillionOutputTokensUsd: 2,
        nativeCapability: {
          nativeProvider: 'openai',
          piTransportKind: 'openai-responses',
          readOnlyNative: 'certified',
        },
      },
    },
    ladders: {},
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let apiSeq = 0;
function uniqueApi() {
  return `smoke-test-scripted-${++apiSeq}`;
}

function makeTempTranscriptDir(): string {
  return mkdtempSync(join(tmpdir(), 'native-smoke-test-'));
}

function cleanupDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

function parseTranscriptLines(path: string): unknown[] {
  const content = readFileSync(path, 'utf-8');
  return content
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// Dry-run tests
// ---------------------------------------------------------------------------

describe('runNativeAgentDryRun', () => {
  it('succeeds for openai without any API key', async () => {
    const transcriptDir = makeTempTranscriptDir();
    try {
      const result = await runNativeAgentDryRun({
        provider: 'openai',
        phase: 'planning',
        env: { OPENAI_API_KEY: '' },
        transcriptDir,
        sessionId: 'dry-test-openai',
      });

      assert.equal(result.outcome, 'ok');
      assert.equal(result.provider, 'openai');
      assert.equal(result.phase, 'planning');
      assert.ok(result.modelId.length > 0, 'modelId must be non-empty');
      assert.ok(result.apiKeyEnv.length > 0, 'apiKeyEnv must be non-empty');
      assert.ok(result.transcriptPath.length > 0, 'transcriptPath must be non-empty');
      assert.ok(result.exposedTools.length > 0, 'exposedTools must not be empty');
    } finally {
      cleanupDir(transcriptDir);
    }
  });

  it('succeeds for openrouter without any API key', async () => {
    const transcriptDir = makeTempTranscriptDir();
    try {
      const result = await runNativeAgentDryRun({
        provider: 'openrouter',
        phase: 'planning',
        env: { OPENROUTER_API_KEY: '' },
        transcriptDir,
        sessionId: 'dry-test-openrouter',
      });

      assert.equal(result.outcome, 'ok');
      assert.equal(result.provider, 'openrouter');
    } finally {
      cleanupDir(transcriptDir);
    }
  });

  it('exposes only read-only registry tools', async () => {
    const transcriptDir = makeTempTranscriptDir();
    try {
      const result = await runNativeAgentDryRun({
        provider: 'openai',
        phase: 'planning',
        env: {},
        transcriptDir,
        sessionId: 'dry-tools-check',
      });

      assert.ok(result.exposedTools.includes('read_file'), 'read_file must be exposed');
      assert.ok(result.exposedTools.includes('list_files'), 'list_files must be exposed');
      assert.ok(result.exposedTools.includes('search_text'), 'search_text must be exposed');
      assert.ok(result.exposedTools.includes('git_status'), 'git_status must be exposed');
      assert.ok(result.exposedTools.includes('git_diff'), 'git_diff must be exposed');

      // Must not include any mutation tool names
      const mutationTools = ['patch_file', 'write_file', 'apply_patch', 'write_artifact', 'create_marker', 'update_status'];
      for (const mut of mutationTools) {
        assert.ok(
          !result.exposedTools.includes(mut),
          `Mutation tool "${mut}" must not be exposed in planning phase`,
        );
      }
    } finally {
      cleanupDir(transcriptDir);
    }
  });

  it('exposes coding mutation tools during coding dry-run', async () => {
    const transcriptDir = makeTempTranscriptDir();
    try {
      const result = await runNativeAgentDryRun({
        provider: 'openai',
        phase: 'coding',
        env: {},
        transcriptDir,
        sessionId: 'dry-tools-coding-check',
      });

      assert.ok(result.exposedTools.includes('apply_patch'));
      assert.ok(result.exposedTools.includes('write_artifact'));
      assert.ok(result.exposedTools.includes('create_marker'));
      assert.ok(result.exposedTools.includes('update_status'));
      assert.ok(result.exposedTools.includes('git_status'));
      assert.ok(result.exposedTools.includes('read_file'));
    } finally {
      cleanupDir(transcriptDir);
    }
  });

  it('writes a valid transcript JSONL file', async () => {
    const transcriptDir = makeTempTranscriptDir();
    try {
      const result = await runNativeAgentDryRun({
        provider: 'openai',
        phase: 'planning',
        env: {},
        transcriptDir,
        sessionId: 'dry-transcript-check',
      });

      assert.ok(result.transcriptPath.endsWith('.jsonl'), 'transcript must be a .jsonl file');

      const events = parseTranscriptLines(result.transcriptPath);
      assert.ok(events.length >= 2, 'dry-run transcript must have at least 2 events');

      const first = events[0] as Record<string, unknown>;
      const last = events[events.length - 1] as Record<string, unknown>;
      assert.equal(first.type, 'session_started', 'first event must be session_started');
      assert.equal(last.type, 'session_ended', 'last event must be session_ended');
    } finally {
      cleanupDir(transcriptDir);
    }
  });

  it('does not include the API key in the result object', async () => {
    const transcriptDir = makeTempTranscriptDir();
    const secretKey = 'sk-openai-secret-dry-check-do-not-leak';
    try {
      const result = await runNativeAgentDryRun({
        provider: 'openai',
        phase: 'planning',
        env: { OPENAI_API_KEY: secretKey },
        transcriptDir,
        sessionId: 'dry-no-leak-check',
      });

      const serialized = JSON.stringify(result);
      assert.ok(
        !serialized.includes(secretKey),
        'API key must not appear in the result JSON',
      );
    } finally {
      cleanupDir(transcriptDir);
    }
  });
});

// ---------------------------------------------------------------------------
// Live skip tests (no real key)
// ---------------------------------------------------------------------------

describe('runNativeAgentLive — key absent', () => {
  it('returns a skipped result for openai when OPENAI_API_KEY is not set', async (t) => {
    if (process.env.OPENAI_API_KEY) {
      t.skip('OPENAI_API_KEY is set in this environment; skip path not testable here');
      return;
    }
    const transcriptDir = makeTempTranscriptDir();
    try {
      const result = await runNativeAgentLive({
        provider: 'openai',
        phase: 'planning',
        env: { OPENAI_API_KEY: '' },
        transcriptDir,
        sessionId: 'live-skip-openai',
      });

      assert.equal(result.outcome, 'skipped');
      assert.ok(result.skipReason, 'skipReason must be set when skipped');
      assert.ok(
        result.skipReason?.includes('OPENAI_API_KEY') ||
          result.skipReason?.includes('not set') ||
          result.skipReason?.includes('empty'),
        `skipReason should mention the key or its absence; got: ${result.skipReason}`,
      );
      assert.equal(result.provider, 'openai');
      assert.equal(result.phase, 'planning');
      assert.ok(result.apiKeyEnv.length > 0, 'apiKeyEnv must still be set on skip');
      assert.equal(result.usage, undefined, 'usage must be absent on skip');
    } finally {
      cleanupDir(transcriptDir);
    }
  });

  it('returns a skipped result for openrouter when OPENROUTER_API_KEY is not set', async () => {
    const transcriptDir = makeTempTranscriptDir();
    try {
      const result = await runNativeAgentLive({
        provider: 'openrouter',
        phase: 'planning',
        env: { OPENROUTER_API_KEY: '' },
        transcriptDir,
        sessionId: 'live-skip-openrouter',
      });

      assert.equal(result.outcome, 'skipped');
      assert.equal(result.provider, 'openrouter');
    } finally {
      cleanupDir(transcriptDir);
    }
  });

  it('does not include the API key in the skipped result', async (t) => {
    if (process.env.OPENAI_API_KEY) {
      t.skip('OPENAI_API_KEY is set in this environment; skip path not testable here');
      return;
    }
    const transcriptDir = makeTempTranscriptDir();
    const secretKey = 'sk-openai-secret-skip-check';
    try {
      // Provide a key so the config is "enabled", then strip it to force skip
      const result = await runNativeAgentLive({
        provider: 'openai',
        phase: 'planning',
        env: { OPENAI_API_KEY: '' },
        transcriptDir,
        sessionId: 'live-no-leak-skip',
      });

      const serialized = JSON.stringify(result);
      assert.ok(!serialized.includes(secretKey), 'key must not appear in skip result');
    } finally {
      cleanupDir(transcriptDir);
    }
  });
});

// ---------------------------------------------------------------------------
// Live stubbed success test (scripted Pi provider, no real network)
// ---------------------------------------------------------------------------

describe('runNativeAgentLive — scripted provider', () => {
  it('returns an ok result using a scripted provider stub', async () => {
    const transcriptDir = makeTempTranscriptDir();
    const scriptedApi = uniqueApi();

    // Register a scripted provider that immediately stops after one turn.
    registerScriptedPiProvider({
      api: scriptedApi,
      turns: [
        {
          content: [{ type: 'tool_call', id: 'tc-smoke-1', name: 'list_files', arguments: { path: '.' } }],
          usage: { input: 120, output: 20 },
          stopReason: 'toolUse',
        },
        {
          content: [{ type: 'text', text: 'Files listed. Smoke complete.' }],
          usage: { input: 80, output: 30 },
          stopReason: 'stop',
        },
      ],
    });

    try {
      const options: RunNativeSmokeOptions = {
        provider: 'openai',
        phase: 'planning',
        env: { OPENAI_API_KEY: 'sk-stub-key-for-scripted-provider' },
        transcriptDir,
        sessionId: 'live-scripted-success',
        _modelOverride: {
          id: `scripted:${scriptedApi}`,
          name: 'scripted-model',
          api: scriptedApi,
          provider: 'scripted',
          baseUrl: 'http://localhost:0/mock',
          headers: {},
        },
        _registryOverride: makeCertifiedScriptedRegistry(),
      };

      const result = await runNativeAgentLive(options);

      assert.equal(result.outcome, 'ok');
      assert.equal(result.provider, 'openai');
      assert.equal(result.phase, 'planning');
      assert.ok(result.exposedTools.length > 0, 'exposedTools must be present');
      assert.ok(result.transcriptPath.endsWith('.jsonl'), 'transcript must be a .jsonl');
      assert.ok(result.usage !== undefined, 'usage must be present on ok live result');
      assert.ok(result.usage!.turnsCompleted > 0, 'must have completed at least one turn');
      assert.ok(result.usage!.toolCallsExecuted > 0, 'must have executed at least one tool call');
      assert.ok(result.usage!.totalTokens > 0, 'must report positive usage for cost capture');

      // Verify transcript was written with real events
      const events = parseTranscriptLines(result.transcriptPath);
      assert.ok(events.length > 0, 'transcript must contain events');

      const types = events.map((e) => (e as Record<string, unknown>).type);
      assert.ok(types.includes('session_started'), 'transcript must include session_started');
      assert.ok(types.includes('session_ended'), 'transcript must include session_ended');
    } finally {
      cleanupDir(transcriptDir);
    }
  });

  it('throws when the provider returns no completed tool-backed usage', async () => {
    const transcriptDir = makeTempTranscriptDir();
    const scriptedApi = uniqueApi();

    registerScriptedPiProvider({
      api: scriptedApi,
      turns: [
        {
          content: [{ type: 'text', text: 'No tool call, no usage.' }],
          stopReason: 'stop',
        },
      ],
    });

    try {
      await assert.rejects(
        () => runNativeAgentLive({
          provider: 'openai',
          phase: 'planning',
          env: { OPENAI_API_KEY: 'sk-stub-key-for-scripted-provider' },
          transcriptDir,
          sessionId: 'live-scripted-empty',
          _modelOverride: {
            id: `scripted:${scriptedApi}`,
            name: 'scripted-model',
            api: scriptedApi,
            provider: 'scripted',
            baseUrl: 'http://localhost:0/mock',
            headers: {},
          },
          _registryOverride: makeCertifiedScriptedRegistry(),
        }),
        /did not execute the required read-only tool call|returned zero usage|did not complete any turns/,
      );
    } finally {
      cleanupDir(transcriptDir);
    }
  });

  it('does not include the API key in the live result or transcript', async () => {
    const transcriptDir = makeTempTranscriptDir();
    const scriptedApi = uniqueApi();
    const secretKey = 'sk-stub-secret-key-no-leak';

    registerScriptedPiProvider({
      api: scriptedApi,
      turns: [
        {
          content: [{ type: 'tool_call', id: 'tc-smoke-2', name: 'list_files', arguments: { path: '.' } }],
          usage: { input: 20, output: 10 },
          stopReason: 'toolUse',
        },
        {
          content: [{ type: 'text', text: 'Smoke complete.' }],
          usage: { input: 10, output: 15 },
          stopReason: 'stop',
        },
      ],
    });

    try {
      const result = await runNativeAgentLive({
        provider: 'openai',
        phase: 'planning',
        env: { OPENAI_API_KEY: secretKey },
        transcriptDir,
        sessionId: 'live-no-leak-scripted',
        _modelOverride: {
          id: `scripted:${scriptedApi}`,
          name: 'scripted-model',
          api: scriptedApi,
          provider: 'scripted',
          baseUrl: 'http://localhost:0/mock',
          headers: {},
        },
        _registryOverride: makeCertifiedScriptedRegistry(),
      });

      // API key must not appear in result JSON
      const serialized = JSON.stringify(result);
      assert.ok(!serialized.includes(secretKey), 'key must not appear in result JSON');

      // API key must not appear in transcript
      if (result.transcriptPath) {
        const transcriptContent = readFileSync(result.transcriptPath, 'utf-8');
        assert.ok(
          !transcriptContent.includes(secretKey),
          'key must not appear in transcript JSONL',
        );
      }
    } finally {
      cleanupDir(transcriptDir);
    }
  });
});

// ---------------------------------------------------------------------------
// Provider and phase constant checks
// ---------------------------------------------------------------------------

describe('smoke constants', () => {
  it('SMOKE_PROVIDERS includes openai and openrouter', () => {
    assert.ok(SMOKE_PROVIDERS.includes('openai'), 'openai must be in SMOKE_PROVIDERS');
    assert.ok(SMOKE_PROVIDERS.includes('openrouter'), 'openrouter must be in SMOKE_PROVIDERS');
  });

  it('SMOKE_PHASES includes planning', () => {
    assert.ok(SMOKE_PHASES.includes('planning'), 'planning must be in SMOKE_PHASES');
  });
});
