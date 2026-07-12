import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { registerScriptedPiProvider } from './native-agent/provider.ts';
import {
  buildCertificationPath,
  CERTIFICATION_SCHEMA_VERSION,
  type NativeCertificationArtifact,
} from './native-agent/certification/index.ts';
import { runNativeExpansion, NativeExpansionUnavailableError } from './native-expansion.ts';
import type { ModelRegistry } from './model-registry.ts';
import { createToolRegistry } from './native-agent/tools/registry.ts';
import { createReadOnlyTools } from './native-agent/tools/read-only.ts';
import { createGitTools } from './native-agent/tools/git.ts';

function makeRepo(configOverride?: unknown): string {
  const repoDir = mkdtempSync(join(tmpdir(), 'native-expansion-'));
  execFileSync('git', ['init', repoDir], { stdio: 'pipe' });
  execFileSync('git', ['-C', repoDir, 'config', 'user.email', 'native@wavemill.test'], { stdio: 'pipe' });
  execFileSync('git', ['-C', repoDir, 'config', 'user.name', 'Native Expansion Test'], { stdio: 'pipe' });
  writeFileSync(join(repoDir, 'notes.md'), '# Notes\n\nNative expansion fixture.\n', 'utf-8');
  writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify(configOverride ?? {
    nativeAgent: {
      enabled: true,
      allowedPhases: ['task-expansion'],
      providers: {
        openai: {},
      },
    },
  }), 'utf-8');
  execFileSync('git', ['-C', repoDir, 'add', '.'], { stdio: 'pipe' });
  execFileSync('git', ['-C', repoDir, 'commit', '-m', 'init'], { stdio: 'pipe' });
  return repoDir;
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

function makeRegistry(modelId: string, provider: 'openai' | 'openrouter' = 'openai'): ModelRegistry {
  return {
    models: {
      [modelId]: {
        nativeCapability: {
          readOnlyNative: 'certified',
          nativeProvider: provider,
          piTransportKind: provider === 'openai' ? 'openai-responses' : 'openai-completions',
          certification: {
            maxCertifiedPhase: 'workflow',
            certifiedAt: new Date().toISOString(),
            certificationSuiteVersion: 'v1',
          },
        },
      } as never,
    },
    ladders: {},
  };
}

function writeCertification(
  repoDir: string,
  modelId: string,
  provider: 'openai' | 'openrouter' = 'openai',
  overrides: Partial<NativeCertificationArtifact> = {},
): void {
  const path = buildCertificationPath(repoDir, provider, modelId, 'v1');
  mkdirSync(dirname(path), { recursive: true });
  const artifact: NativeCertificationArtifact = {
    schemaVersion: CERTIFICATION_SCHEMA_VERSION,
    provider,
    model: modelId,
    phase: 'workflow',
    suiteVersion: 'v1',
    certifiedAt: new Date().toISOString(),
    scenarios: [{ scenarioId: 's1', passed: true }],
    ...overrides,
  };
  writeFileSync(path, JSON.stringify(artifact, null, 2), 'utf-8');
}

function makePrompt(): string {
  return [
    '# Task Packet',
    '',
    '{{ISSUE_CONTEXT}}',
    '',
    '<!-- SPLIT: HEADER ABOVE, DETAILS BELOW -->',
    '',
    '## 1. Objective',
    '',
    'Ship native task expansion.',
  ].join('\n');
}

function makeToolRegistryWithDeniedMutation(repoDir: string) {
  return createToolRegistry([
    ...createReadOnlyTools(repoDir),
    ...createGitTools(repoDir),
    {
      metadata: {
        name: 'patch_file',
        description: 'Write or patch a file.',
        class: 'mutation',
        allowedPhases: [],
        executionMode: 'sequential',
        outputCapPolicy: { strategy: 'none' },
      },
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
      async execute() {
        throw new Error('patch_file must be policy-blocked before execution');
      },
    },
  ]);
}

describe('runNativeExpansion', () => {
  it('returns valid task packet text and transcript metadata', async () => {
    const repoDir = makeRepo();
    const api = `native-expansion-success-${Date.now()}`;
    writeCertification(repoDir, 'gpt-4o');

    registerScriptedPiProvider({
      api,
      turns: [
        {
          content: [{ type: 'tool_call', id: 'read-1', name: 'read_file', arguments: { path: 'notes.md' } }],
          usage: { input: 100, output: 20 },
          stopReason: 'toolUse',
        },
        {
          content: [{
            type: 'text',
            text: [
              '# Header',
              '',
              'Overview',
              '',
              '<!-- SPLIT: HEADER ABOVE, DETAILS BELOW -->',
              '',
              '## 1. Objective',
              '',
              'Implement the native expansion path.',
            ].join('\n'),
          }],
          usage: { input: 80, output: 40 },
          stopReason: 'stop',
        },
      ],
    });

    try {
      const result = await runNativeExpansion({
        promptTemplate: makePrompt(),
        issueContext: 'Issue context',
        codebaseContext: 'Codebase context',
        mode: 'normal',
        repoDir,
        env: { OPENAI_API_KEY: 'sk-test-native-expansion' },
        registry: makeRegistry('gpt-4o'),
        toolRegistryOverride: makeToolRegistryWithDeniedMutation(repoDir),
        modelOverride: {
          id: `scripted:${api}`,
          name: 'scripted-model',
          api,
          provider: 'scripted',
          baseUrl: 'http://localhost:0/mock',
          headers: {},
        },
      });

      assert.match(result.text, /## 1\. Objective/);
      assert.equal(result.native.agent, 'native-openai');
      assert.equal(result.native.model, 'gpt-4o');
      assert.equal(result.native.provider, 'openai');
      assert.equal(result.native.api, api);
      assert.equal(result.native.deniedToolCalls.length, 0);
      assert.ok(result.native.transcriptPath.endsWith('.jsonl'));
      assert.ok(readFileSync(result.native.transcriptPath, 'utf-8').includes('"tool_result"'));
    } finally {
      cleanup(repoDir);
    }
  });

  it('records denied mutation tool calls without mutating the filesystem', async () => {
    const repoDir = makeRepo();
    const api = `native-expansion-denied-${Date.now()}`;
    writeCertification(repoDir, 'gpt-4o');
    const notesPath = join(repoDir, 'notes.md');
    const before = readFileSync(notesPath, 'utf-8');
    const beforeMtime = statSync(notesPath).mtimeMs;

    registerScriptedPiProvider({
      api,
      turns: [
        {
          content: [{ type: 'tool_call', id: 'patch-1', name: 'patch_file', arguments: { path: 'notes.md', content: 'mutate' } }],
          usage: { input: 100, output: 20 },
          stopReason: 'toolUse',
        },
        {
          content: [{
            type: 'text',
            text: [
              '# Header',
              '',
              'Overview',
              '',
              '<!-- SPLIT: HEADER ABOVE, DETAILS BELOW -->',
              '',
              '## 1. Objective',
              '',
              'Mutation was denied.',
            ].join('\n'),
          }],
          usage: { input: 60, output: 40 },
          stopReason: 'stop',
        },
      ],
    });

    try {
      const result = await runNativeExpansion({
        promptTemplate: makePrompt(),
        issueContext: 'Issue context',
        codebaseContext: 'Codebase context',
        mode: 'normal',
        repoDir,
        env: { OPENAI_API_KEY: 'sk-test-native-expansion' },
        registry: makeRegistry('gpt-4o'),
        toolRegistryOverride: makeToolRegistryWithDeniedMutation(repoDir),
        modelOverride: {
          id: `scripted:${api}`,
          name: 'scripted-model',
          api,
          provider: 'scripted',
          baseUrl: 'http://localhost:0/mock',
          headers: {},
        },
      });

      assert.equal(result.native.deniedToolCalls.length, 1);
      assert.equal(result.native.provider, 'openai');
      assert.equal(result.native.api, api);
      assert.match(result.native.deniedToolCalls[0].reason, /^phase_denied:/);
      assert.equal(readFileSync(notesPath, 'utf-8'), before);
      assert.equal(statSync(notesPath).mtimeMs, beforeMtime);
    } finally {
      cleanup(repoDir);
    }
  });

  it('throws when the planning-phase allow-list is empty', async () => {
    const repoDir = makeRepo();
    writeCertification(repoDir, 'gpt-4o');
    try {
      await assert.rejects(
        () => runNativeExpansion({
          promptTemplate: makePrompt(),
          issueContext: 'Issue context',
          codebaseContext: 'Codebase context',
          mode: 'normal',
          repoDir,
          env: { OPENAI_API_KEY: 'sk-test-native-expansion' },
          registry: makeRegistry('gpt-4o'),
          toolRegistryOverride: {
            getTools: () => [],
            list: () => [],
            register: () => {},
            has: () => false,
          },
        }),
        /empty read-only tool allow-list/i,
      );
    } finally {
      cleanup(repoDir);
    }
  });

  it('throws when the provider returns invalid task packet markdown', async () => {
    const repoDir = makeRepo();
    const api = `native-expansion-invalid-${Date.now()}`;
    writeCertification(repoDir, 'gpt-4o');
    registerScriptedPiProvider({
      api,
      turns: [
        {
          content: [{ type: 'text', text: 'not a task packet' }],
          usage: { input: 10, output: 10 },
          stopReason: 'stop',
        },
      ],
    });

    try {
      await assert.rejects(
        () => runNativeExpansion({
          promptTemplate: makePrompt(),
          issueContext: 'Issue context',
          codebaseContext: 'Codebase context',
          mode: 'normal',
          repoDir,
          env: { OPENAI_API_KEY: 'sk-test-native-expansion' },
          registry: makeRegistry('gpt-4o'),
          modelOverride: {
            id: `scripted:${api}`,
            name: 'scripted-model',
            api,
            provider: 'scripted',
            baseUrl: 'http://localhost:0/mock',
            headers: {},
          },
        }),
        /invalid task-packet markdown/i,
      );
    } finally {
      cleanup(repoDir);
    }
  });

  it('throws a missing_key error when no provider key is available', async () => {
    const repoDir = makeRepo({
      nativeAgent: {
        enabled: true,
        allowedPhases: ['task-expansion'],
        providers: {
          openai: {
            apiKeyEnv: 'WAVEMILL_TEST_MISSING_NATIVE_KEY',
          },
        },
      },
    });
    try {
      await assert.rejects(
        () => runNativeExpansion({
          promptTemplate: makePrompt(),
          issueContext: 'Issue context',
          codebaseContext: 'Codebase context',
          mode: 'normal',
          repoDir,
          env: { WAVEMILL_TEST_MISSING_NATIVE_KEY: '' },
          registry: makeRegistry('gpt-4o'),
        }),
        (error: unknown) => error instanceof NativeExpansionUnavailableError
          && error.kind === 'missing_key'
          && /openai:gpt-4o/.test(error.message)
          && /WAVEMILL_TEST_MISSING_NATIVE_KEY/.test(error.message)
          && /wavemill native-agent models report --json/.test(error.message),
      );
    } finally {
      cleanup(repoDir);
    }
  });

  it('throws an uncertified error when the model is not certified', async () => {
    const repoDir = makeRepo();
    try {
      await assert.rejects(
        () => runNativeExpansion({
          promptTemplate: makePrompt(),
          issueContext: 'Issue context',
          codebaseContext: 'Codebase context',
          mode: 'normal',
          repoDir,
          env: { OPENAI_API_KEY: 'sk-test-native-expansion' },
          registry: {
            models: {
              'gpt-4o': {
                nativeCapability: {
                  readOnlyNative: 'unsupported',
                  nativeProvider: 'openai',
                  piTransportKind: 'openai-responses',
                },
              } as never,
            },
            ladders: {},
          },
        }),
        (error: unknown) => error instanceof NativeExpansionUnavailableError
          && error.kind === 'uncertified'
          && /openai:gpt-4o/.test(error.message)
          && /reason=wrong_suite/.test(error.message)
          && /wavemill native-agent models report --json/.test(error.message),
      );
    } finally {
      cleanup(repoDir);
    }
  });
});
