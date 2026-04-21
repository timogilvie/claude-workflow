/**
 * Tests for prompt-utils.ts
 */

import { describe, test, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeActivePointersAtomic } from './resource-lifecycle.ts';
import { clearConfigCache } from './config.ts';
import { registerResource } from './resource-registry.ts';
import { fillPromptTemplate, fillPromptTemplatePositional, loadPromptTemplate } from './prompt-utils.ts';

describe('fillPromptTemplate', () => {
  test('replaces single variable', () => {
    const template = 'Issue: {{ISSUE_CONTEXT}}';
    const result = fillPromptTemplate(template, {
      ISSUE_CONTEXT: 'HOK-123: Fix login bug',
    });
    expect(result).toBe('Issue: HOK-123: Fix login bug');
  });

  test('replaces multiple variables', () => {
    const template = 'Issue: {{ISSUE_CONTEXT}}\n\nCodebase: {{CODEBASE_CONTEXT}}';
    const result = fillPromptTemplate(template, {
      ISSUE_CONTEXT: 'HOK-123: Fix bug',
      CODEBASE_CONTEXT: 'Uses React',
    });
    expect(result).toBe('Issue: HOK-123: Fix bug\n\nCodebase: Uses React');
  });

  test('ignores undefined variables', () => {
    const template = 'Issue: {{ISSUE_CONTEXT}}\n\nCodebase: {{CODEBASE_CONTEXT}}';
    const result = fillPromptTemplate(template, {
      ISSUE_CONTEXT: 'HOK-123',
    });
    expect(result).toBe('Issue: HOK-123\n\nCodebase: {{CODEBASE_CONTEXT}}');
  });

  test('handles empty string values', () => {
    const template = 'Issue: {{ISSUE_CONTEXT}}';
    const result = fillPromptTemplate(template, {
      ISSUE_CONTEXT: '',
    });
    expect(result).toBe('Issue: ');
  });

  test('is case-sensitive', () => {
    const template = 'Issue: {{issue_context}}';
    const result = fillPromptTemplate(template, {
      ISSUE_CONTEXT: 'HOK-123',
    });
    expect(result).toBe('Issue: {{issue_context}}'); // Not replaced
  });

  test('handles custom variable names', () => {
    const template = 'Custom: {{CUSTOM_VAR}}';
    const result = fillPromptTemplate(template, {
      CUSTOM_VAR: 'custom value',
    });
    expect(result).toBe('Custom: custom value');
  });

  test('replaces multiple occurrences of same variable', () => {
    const template = '{{ISSUE_CONTEXT}} and {{ISSUE_CONTEXT}}';
    const result = fillPromptTemplate(template, {
      ISSUE_CONTEXT: 'HOK-123',
    });
    expect(result).toBe('HOK-123 and HOK-123');
  });
});

describe('fillPromptTemplatePositional', () => {
  test('maps to ISSUE_CONTEXT by default', () => {
    const template = 'Issue: {{ISSUE_CONTEXT}}';
    const result = fillPromptTemplatePositional(template, 'HOK-123', '');
    expect(result).toBe('Issue: HOK-123');
  });

  test('maps to INITIATIVE_CONTEXT when template uses it', () => {
    const template = 'Initiative: {{INITIATIVE_CONTEXT}}';
    const result = fillPromptTemplatePositional(template, 'Epic-456', '');
    expect(result).toBe('Initiative: Epic-456');
  });

  test('fills both issue and codebase context', () => {
    const template = 'Issue: {{ISSUE_CONTEXT}}\n\nCodebase: {{CODEBASE_CONTEXT}}';
    const result = fillPromptTemplatePositional(template, 'HOK-123', 'Uses React');
    expect(result).toBe('Issue: HOK-123\n\nCodebase: Uses React');
  });

  test('handles missing codebase context (defaults to empty)', () => {
    const template = 'Issue: {{ISSUE_CONTEXT}}';
    const result = fillPromptTemplatePositional(template, 'HOK-123');
    expect(result).toBe('Issue: HOK-123');
  });
});

describe('loadPromptTemplate', () => {
  test('prefers canary content when active pointer routes there', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'prompt-utils-'));
    try {
      const promptsDir = join(repoDir, 'tools', 'prompts');
      mkdirSync(promptsDir, { recursive: true });
      const stablePath = join(promptsDir, 'issue-writer.md');
      const canaryPath = join(promptsDir, 'issue-writer-canary.md');
      writeFileSync(stablePath, 'stable prompt', 'utf-8');
      writeFileSync(canaryPath, 'canary prompt', 'utf-8');

      const stable = registerResource({
        type: 'prompt',
        name: 'issue-writer',
        content: 'stable prompt',
        version: 'v1',
        uri: stablePath,
      }, { repoDir });
      const canary = registerResource({
        type: 'prompt',
        name: 'issue-writer',
        content: 'canary prompt',
        version: 'v2',
        uri: canaryPath,
      }, { repoDir });
      writeActivePointersAtomic({
        schemaVersion: '1.0.0',
        updatedAt: '2026-04-21T00:00:00.000Z',
        entries: {
          'prompt:issue-writer': {
            stable: { id: stable!.id, version: stable!.version, updatedAt: '2026-04-21T00:00:00.000Z' },
            canary: { id: canary!.id, version: canary!.version, updatedAt: '2026-04-21T00:00:00.000Z', trafficPercent: 100 },
          },
        },
      }, repoDir);

      process.env.WAVEMILL_SESSION = 'session-a';
      const content = await loadPromptTemplate(stablePath, { repoDir, skipRegistry: true });
      expect(content).toBe('canary prompt');
    } finally {
      delete process.env.WAVEMILL_SESSION;
      clearConfigCache(repoDir);
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
