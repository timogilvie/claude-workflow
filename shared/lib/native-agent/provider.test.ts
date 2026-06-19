/**
 * Tests for shared/lib/native-agent/provider.ts
 *
 * Verifies usage mapping, mock-turn execution through the ToolCallingProvider
 * seam, and seam isolation (Pi types must not appear in any test import).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mapPiUsageToSessionModelUsage,
  createToolCallingProvider,
  registerMockProvider,
} from './provider.ts';

// ─── 1. Usage mapping ─────────────────────────────────────────────────────────

describe('mapPiUsageToSessionModelUsage', () => {
  it('maps captured Pi usage to SessionModelUsage field names', () => {
    const result = mapPiUsageToSessionModelUsage({
      input: 1200,
      output: 350,
      cacheRead: 800,
      cacheWrite: 64,
      totalTokens: 2414,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });

    assert.deepEqual(result, {
      inputTokens: 1200,
      outputTokens: 350,
      cacheReadTokens: 800,
      cacheCreationTokens: 64,
    });
  });

  it('defaults missing cache fields to 0', () => {
    const result = mapPiUsageToSessionModelUsage({
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });

    assert.equal(result.cacheReadTokens, 0);
    assert.equal(result.cacheCreationTokens, 0);
    assert.equal(result.inputTokens, 10);
    assert.equal(result.outputTokens, 5);
  });

  it('returns all-zero result for undefined usage', () => {
    const result = mapPiUsageToSessionModelUsage(undefined);

    assert.deepEqual(result, {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });

  it('passes negative values through unchanged', () => {
    const result = mapPiUsageToSessionModelUsage({
      input: -1,
      output: -2,
      cacheRead: -3,
      cacheWrite: -4,
      totalTokens: -10,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });

    assert.equal(result.inputTokens, -1);
    assert.equal(result.outputTokens, -2);
    assert.equal(result.cacheReadTokens, -3);
    assert.equal(result.cacheCreationTokens, -4);
  });
});

// ─── 2. Mock turn through the provider seam ───────────────────────────────────

describe('createToolCallingProvider (text-only mock turn)', () => {
  it('runs a mock turn and returns a neutral ProviderTurnResult', async () => {
    const API = 'hokusai-mock-provider-test';

    registerMockProvider(API, () => ({
      text: 'Planning complete.',
      usage: { input: 1200, output: 350, cacheRead: 800, cacheWrite: 64 },
      finishReason: 'stop',
      modelId: 'hokusai-mini',
      providerName: 'hokusai',
    }));

    const provider = createToolCallingProvider({
      api: API,
      modelId: 'hokusai-mini',
      providerName: 'hokusai',
    });

    const result = await provider.createTurn({
      systemPrompt: 'You are a read-only planning agent.',
      messages: [{ role: 'user', content: 'Plan the change.' }],
    });

    assert.equal(result.text, 'Planning complete.');
    assert.equal(result.provider, 'hokusai');
    assert.equal(result.model, 'hokusai-mini');
    assert.equal(result.finishReason, 'stop');
    assert.deepEqual(result.usage, {
      inputTokens: 1200,
      outputTokens: 350,
      cacheReadTokens: 800,
      cacheCreationTokens: 64,
    });
    assert.ok(typeof result.id === 'string' && result.id.length > 0);
    assert.ok(Array.isArray(result.toolCalls) && result.toolCalls.length === 0);
    // raw is present but opaque
    assert.ok(result.raw !== null && result.raw !== undefined);
  });
});

describe('createToolCallingProvider (unsupported history)', () => {
  it('throws for unsupported non-user history roles in the single-turn seam', async () => {
    const provider = createToolCallingProvider({
      api: 'hokusai-unused-history-role-test',
      modelId: 'hokusai-mini',
      providerName: 'hokusai',
    });

    await assert.rejects(
      provider.createTurn({ messages: [{ role: 'assistant', content: 'Earlier answer.' }] }),
      /Unsupported native-agent message role/,
    );
  });
});

// ─── 3. Tool-call normalization ───────────────────────────────────────────────

describe('createToolCallingProvider (tool-call mock turn)', () => {
  it('normalizes scripted Pi tool calls to NativeToolCall with no Pi imports', async () => {
    const API = 'hokusai-mock-tool-call-test';

    registerMockProvider(API, () => ({
      toolCalls: [
        { id: 'call_1', name: 'read_file', arguments: { path: 'notes.md' } },
        { id: 'call_2', name: 'read_file', arguments: { path: '../secrets.env' } },
      ],
      usage: { input: 1200, output: 40 },
      finishReason: 'tool_calls',
    }));

    const provider = createToolCallingProvider({
      api: API,
      modelId: 'hokusai-mini',
      providerName: 'hokusai',
    });

    const result = await provider.createTurn({
      messages: [{ role: 'user', content: 'Read notes.md and the secrets file.' }],
    });

    assert.equal(result.finishReason, 'tool_calls');
    assert.equal(result.toolCalls.length, 2);
    assert.deepEqual(result.toolCalls[0], { id: 'call_1', name: 'read_file', arguments: { path: 'notes.md' } });
    assert.deepEqual(result.toolCalls[1], { id: 'call_2', name: 'read_file', arguments: { path: '../secrets.env' } });
    assert.equal(result.text, '');
    assert.equal(result.usage?.inputTokens, 1200);
    assert.equal(result.usage?.outputTokens, 40);
    assert.equal(result.usage?.cacheReadTokens, 0);
    assert.equal(result.usage?.cacheCreationTokens, 0);
  });
});

describe('registerMockProvider', () => {
  it('throws when the mock finish reason cannot be emitted as a Pi done event', async () => {
    const API = 'hokusai-mock-error-finish-test';

    registerMockProvider(API, () => ({
      text: 'failed',
      finishReason: 'error',
    }));

    const provider = createToolCallingProvider({
      api: API,
      modelId: 'hokusai-mini',
      providerName: 'hokusai',
    });

    await assert.rejects(
      provider.createTurn({ messages: [{ role: 'user', content: 'Trigger an error.' }] }),
      /Unsupported mock provider finish reason/,
    );
  });
});

// ─── 4. Seam isolation ────────────────────────────────────────────────────────

describe('seam isolation', () => {
  it('Pi package names appear only in provider.ts and messages.ts source files', async () => {
    const { spawnSync } = await import('node:child_process');
    const { readdirSync, readFileSync } = await import('node:fs');
    const { join, resolve, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    // provider.test.ts is in shared/lib/native-agent/ — 3 levels up = repo root
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

    // Recursively collect .ts source files (not .test.ts) under shared/, src/, tools/
    function collectSources(dir: string): string[] {
      const results: string[] = [];
      let entries: ReturnType<typeof readdirSync>;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return results;
      }
      for (const entry of entries) {
        if (entry.name === 'node_modules') continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          results.push(...collectSources(full));
        } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
          results.push(full);
        }
      }
      return results;
    }

    const searchDirs = ['shared', 'src', 'tools'].map((d) => join(repoRoot, d));
    const sources: string[] = [];
    for (const d of searchDirs) {
      sources.push(...collectSources(d));
    }

    const piPattern = /@earendil-works\/pi-ai|@earendil-works\/pi-agent-core/;
    const allowedSuffixes = [
      'shared/lib/native-agent/provider.ts',
      'shared/lib/native-agent/messages.ts',
    ];

    const violations: string[] = [];
    for (const file of sources) {
      const content = readFileSync(file, 'utf8');
      if (piPattern.test(content)) {
        const relative = file.replace(repoRoot + '/', '');
        const isAllowed = allowedSuffixes.some((s) => relative === s || relative.endsWith('/' + s));
        if (!isAllowed) {
          violations.push(relative);
        }
      }
    }

    assert.deepEqual(
      violations,
      [],
      `Unexpected Pi imports outside the seam boundary:\n  ${violations.join('\n  ')}`,
    );

    // Also verify the allowed files DO contain Pi imports (seam is actually used)
    const providerFile = resolve(repoRoot, 'shared/lib/native-agent/provider.ts');
    const messagesFile = resolve(repoRoot, 'shared/lib/native-agent/messages.ts');
    assert.ok(piPattern.test(readFileSync(providerFile, 'utf8')), 'provider.ts should import Pi');
    assert.ok(piPattern.test(readFileSync(messagesFile, 'utf8')), 'messages.ts should import Pi');

    // Use rg if available for an independent cross-check (non-fatal if absent)
    const rg = spawnSync('rg', [
      '--no-heading', '--with-filename', '--line-number',
      '-e', 'from.*@earendil-works/pi-ai',
      '-e', 'from.*@earendil-works/pi-agent-core',
      'shared', 'src', 'tools',
      '--glob', '*.ts',
      '--glob', '!*.test.ts',
    ], { cwd: repoRoot, encoding: 'utf8' });

    if (rg.status !== null && rg.status !== 1) {
      const rgLines = (rg.stdout ?? '').trim().split('\n').filter(Boolean);
      for (const line of rgLines) {
        const allowed = allowedSuffixes.some((s) => line.includes(s));
        assert.ok(allowed, `rg cross-check: unexpected Pi import outside seam: ${line}`);
      }
    }
  });
});
