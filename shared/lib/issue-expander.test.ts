import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  buildIssueExpansionCallOptions,
  expandIssue,
  parseIssueInput,
} from './issue-expander.ts';
import { NativeExpansionUnavailableError } from './native-expansion.ts';

function makeRepo(config?: unknown): string {
  const repoDir = mkdtempSync(join(tmpdir(), 'issue-expander-test-'));
  if (config) {
    writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify(config), 'utf-8');
  }
  return repoDir;
}

describe('issue-expander', () => {
  it('uses cliCmd for explicit Claude command overrides', () => {
    const options = buildIssueExpansionCallOptions('/custom/claude');
    assert.equal(options.cliCmd, '/custom/claude');
    assert.equal(options.mode, 'stream');
    assert.ok(options.cliFlags?.includes('--append-system-prompt'));
  });

  it('uses durable Claude settings for packet expansion', () => {
    const options = buildIssueExpansionCallOptions('/custom/claude');
    assert.equal(options.taskType, 'planning');
    assert.equal(options.retry, true);
    assert.equal(options.maxRetries, 2);
    assert.equal(options.timeout, 600_000);
    assert.equal(options.activityTimeout, undefined);
    assert.equal(options.maxBuffer, 50 * 1024 * 1024);
  });

  it('falls back to CLAUDE_CMD when no explicit override is provided', () => {
    const original = process.env.CLAUDE_CMD;
    process.env.CLAUDE_CMD = '/env/claude';

    try {
      const options = buildIssueExpansionCallOptions();
      assert.equal(options.cliCmd, '/env/claude');
    } finally {
      if (original === undefined) {
        delete process.env.CLAUDE_CMD;
      } else {
        process.env.CLAUDE_CMD = original;
      }
    }
  });

  it('parseIssueInput accepts canonical identifiers', () => {
    assert.equal(parseIssueInput('HOK-1494'), 'HOK-1494');
  });

  it('parseIssueInput canonicalizes lowercase identifiers', () => {
    assert.equal(parseIssueInput('hok-1494'), 'HOK-1494');
  });

  it('parseIssueInput trims surrounding whitespace', () => {
    assert.equal(parseIssueInput(' HOK-1494 '), 'HOK-1494');
  });

  it('parseIssueInput accepts Linear issue URLs', () => {
    assert.equal(
      parseIssueInput('https://linear.app/hokusai/issue/HOK-1494/fix'),
      'HOK-1494'
    );
  });

  it('parseIssueInput accepts case-insensitive Linear issue URLs', () => {
    assert.equal(
      parseIssueInput('https://Linear.App/hokusai/issue/hok-1494/fix'),
      'HOK-1494'
    );
  });

  for (const invalidInput of [
    'FOOBAR',
    'HOK-',
    'HOK-1494/extra',
    'https://example.com/HOK-1494',
    '',
    '   ',
  ]) {
    it(`parseIssueInput rejects invalid input: ${JSON.stringify(invalidInput)}`, () => {
      assert.throws(
        () => parseIssueInput(invalidInput),
        /Expected format: TEAM-123 or Linear issue URL/
      );
    });
  }

  it('expandIssue uses Claude path when native expansion is disabled', async () => {
    const repoDir = makeRepo();
    const calls: string[] = [];
    try {
      const result = await expandIssue({
        promptTemplate: 'prompt',
        issueContext: 'issue',
        repoDir,
      }, {
        expandIssueWithClaude: async () => {
          calls.push('claude');
          return 'claude result';
        },
        importNativeExpansion: async () => {
          throw new Error('native module should not be imported');
        },
      });

      assert.equal(result.text, 'claude result');
      assert.deepEqual(calls, ['claude']);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('expandIssue uses Claude path when nativeAgent is enabled but task-expansion is removed', async () => {
    const repoDir = makeRepo({
      nativeAgent: {
        enabled: true,
        allowedPhases: ['planning', 'review'],
      },
    });
    const calls: string[] = [];
    try {
      const result = await expandIssue({
        promptTemplate: 'prompt',
        issueContext: 'issue',
        repoDir,
      }, {
        expandIssueWithClaude: async () => {
          calls.push('claude');
          return 'claude result';
        },
        importNativeExpansion: async () => {
          throw new Error('native module should not be imported');
        },
      });

      assert.equal(result.text, 'claude result');
      assert.deepEqual(calls, ['claude']);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('expandIssue uses native path when task expansion is enabled', async () => {
    const repoDir = makeRepo({
      nativeAgent: {
        enabled: true,
        allowedPhases: ['task-expansion'],
        providers: {
          openai: {},
        },
      },
    });
    try {
      const result = await expandIssue({
        promptTemplate: 'prompt',
        issueContext: 'issue',
        repoDir,
      }, {
        importNativeExpansion: async () => ({
          NativeExpansionUnavailableError,
          runNativeExpansion: async () => ({
            text: 'native result',
            native: {
              agent: 'native-openai',
              model: 'gpt-4o',
              provider: 'openai',
              api: 'openai-responses',
              transcriptPath: '/tmp/native.jsonl',
              cost: 0,
              durationMs: 1,
              stopReason: 'stop',
              totalInputTokens: 1,
              totalOutputTokens: 1,
              deniedToolCalls: [],
            },
          }),
        }),
      });

      assert.equal(result.text, 'native result');
      assert.equal(result.native?.agent, 'native-openai');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('expandIssue falls back to Claude when native prerequisites are unavailable and fallback is enabled', async () => {
    const repoDir = makeRepo({
      nativeAgent: {
        enabled: true,
        allowedPhases: ['task-expansion'],
        expansion: {
          fallbackOnUnavailable: true,
        },
        providers: {
          openai: {},
        },
      },
    });
    const error = new NativeExpansionUnavailableError('missing_key', 'OPENAI_API_KEY is not set');
    try {
      const result = await expandIssue({
        promptTemplate: 'prompt',
        issueContext: 'issue',
        repoDir,
      }, {
        expandIssueWithClaude: async () => 'claude fallback',
        importNativeExpansion: async () => ({
          NativeExpansionUnavailableError,
          runNativeExpansion: async () => {
            throw error;
          },
        }),
      });

      assert.equal(result.text, 'claude fallback');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('expandIssue rethrows native prerequisite failures when fallback is disabled', async () => {
    const repoDir = makeRepo({
      nativeAgent: {
        enabled: true,
        allowedPhases: ['task-expansion'],
        providers: {
          openai: {},
        },
      },
    });
    const error = new NativeExpansionUnavailableError('uncertified', 'model is uncertified');
    try {
      await assert.rejects(
        () => expandIssue({
          promptTemplate: 'prompt',
          issueContext: 'issue',
          repoDir,
        }, {
          importNativeExpansion: async () => ({
            NativeExpansionUnavailableError,
            runNativeExpansion: async () => {
              throw error;
            },
          }),
        }),
        /uncertified/,
      );
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
