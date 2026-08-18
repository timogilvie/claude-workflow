import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
// CLI smoke tests for tools/audit-openrouter-aliases.ts (HOK-2773).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'audit-aliases-tool-'));
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

function runTool(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('npx', ['tsx', 'tools/audit-openrouter-aliases.ts', ...args], {
    cwd: process.cwd(),
    encoding: 'utf-8',
    env: { ...process.env },
    maxBuffer: 10 * 1024 * 1024,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('audit-openrouter-aliases tool', () => {
  it('--offline --json emits valid JSON with auditedModels non-empty and exit 0 (no selectable findings)', () => {
    const result = runTool(['--offline', '--json']);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const parsed = JSON.parse(result.stdout);
    assert.ok(Array.isArray(parsed.auditedModels));
    assert.ok(parsed.auditedModels.length > 0);
    assert.equal(parsed.catalogSize, null);
    // deepseek-coder-v2 is flagged but not selectable, so exit 0.
    const deepseek = parsed.findings.find((f: { modelId: string }) => f.modelId === 'deepseek-coder-v2');
    assert.ok(deepseek);
    assert.equal(deepseek.selectable, false);
  });

  it('--catalog-file with a tiny catalog flags selectable missing models (exit 1) and blocked models as not selectable', () => {
    const dir = makeTmpDir();
    try {
      const catalogPath = join(dir, 'catalog.json');
      // A catalog with only one healthy model. Every other selectable
      // native-openrouter model will be flagged missing-from-catalog and
      // selectable, so the audit exits 1. Blocked retired models are also
      // flagged but remain not selectable.
      writeFileSync(catalogPath, JSON.stringify({
        data: [
          { id: 'qwen/qwen3-coder', context_length: 262_144, supported_parameters: ['tools'] },
        ],
      }));
      const result = runTool(['--catalog-file', catalogPath, '--json']);
      assert.equal(result.status, 1, result.stderr || result.stdout);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.catalogSize, 1);
      assert.ok(parsed.selectableFindingCount > 0);
      // Blocked retired models are flagged but not selectable.
      const grok = parsed.findings.find((f: { modelId: string }) => f.modelId === 'grok-code-fast');
      assert.ok(grok);
      assert.equal(grok.selectable, false);
      const deepseek = parsed.findings.find((f: { modelId: string }) => f.modelId === 'deepseek-coder-v2');
      assert.ok(deepseek);
      assert.equal(deepseek.selectable, false);
    } finally {
      cleanup(dir);
    }
  });

  it('--offline and --catalog-file are mutually exclusive (exit 2)', () => {
    const result = runTool(['--offline', '--catalog-file', 'foo.json']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /mutually exclusive/);
  });
});
