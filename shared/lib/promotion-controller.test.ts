import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { runPromotion } from './promotion-controller.ts';

function makeRepo(config: Record<string, unknown> = {}): { repoDir: string; cleanup: () => void } {
  const repoDir = mkdtempSync(join(tmpdir(), 'wavemill-promote-'));
  writeFileSync(
    join(repoDir, '.wavemill-config.json'),
    JSON.stringify({
      integration: {
        integrationBranch: 'auto/integration',
        promotionBranch: 'main',
      },
      ...config,
    }),
  );
  return {
    repoDir,
    cleanup: () => rmSync(repoDir, { recursive: true, force: true }),
  };
}

function shellHarness(overrides: {
  isAncestor?: boolean;
  openPrs?: Array<{ number: number; url: string; body?: string }>;
  mergedPrs?: Array<{ number: number; title: string; labels?: Array<{ name: string }> }>;
  checks?: Array<{ name: string; state?: string; conclusion?: string | null }>;
} = {}): {
  shellRunner: (cmd: string, opts?: { encoding?: string; cwd?: string }) => string;
  calls: string[];
  bodies: string[];
} {
  const calls: string[] = [];
  const bodies: string[] = [];

  return {
    calls,
    bodies,
    shellRunner: (cmd) => {
      calls.push(cmd);

      if (cmd === 'mktemp') {
        return '/tmp/promotion-body.txt';
      }

      if (cmd.includes("cat > '/tmp/promotion-body.txt' <<'EOF'")) {
        bodies.push(cmd);
        return '';
      }

      if (cmd.includes("git rev-parse 'auto/integration'")) return 'integration-sha\n';
      if (cmd.includes("git rev-parse 'main'")) return 'main-sha\n';

      if (cmd.includes('git merge-base --is-ancestor')) {
        if (overrides.isAncestor) return '';
        throw new Error('not ancestor');
      }

      if (cmd.includes('gh pr list --state merged')) {
        return JSON.stringify(overrides.mergedPrs ?? [
          { number: 101, title: 'Add release guardrails', labels: [{ name: 'wavemill' }] },
        ]);
      }

      if (cmd.includes("git log --no-merges --oneline -n 10 'main..auto/integration'")) {
        return 'abc123 Add release guardrails\n';
      }

      if (cmd.includes("gh pr list --head 'auto/integration' --base 'main' --state open --json number,url,body")) {
        return JSON.stringify(overrides.openPrs ?? []);
      }

      if (cmd.includes('gh pr edit')) return '';
      if (cmd.includes('gh pr create')) return 'https://github.com/example/repo/pull/88\n';
      if (cmd.includes("rm -f '/tmp/promotion-body.txt'")) return '';

      if (cmd.includes('gh pr checks')) {
        return JSON.stringify(overrides.checks ?? [
          { name: 'ci', state: 'COMPLETED', conclusion: 'success' },
        ]);
      }

      throw new Error(`Unhandled command: ${cmd}`);
    },
  };
}

describe('runPromotion', () => {
  it('updates the existing promotion PR body with a fresh summary', async () => {
    const repo = makeRepo();
    const shell = shellHarness({
      openPrs: [{ number: 77, url: 'https://github.com/example/repo/pull/77', body: 'Existing context' }],
    });

    try {
      const result = await runPromotion({
        repoDir: repo.repoDir,
        shellRunner: shell.shellRunner,
        healthChecker: async () => ({ state: 'healthy' }),
      });

      assert.equal(result.status, 'updated');
      assert.equal(result.prUrl, 'https://github.com/example/repo/pull/77');
      assert.match(result.checkSummary ?? '', /^passing:/);
      assert(shell.calls.some((cmd) => cmd.includes('gh pr edit 77 --body-file')));
      assert(!shell.calls.some((cmd) => cmd.includes('gh pr create')));
      assert.match(shell.bodies[0] ?? '', /Promotion Summary/);
      assert.match(shell.bodies[0] ?? '', /PR #101: Add release guardrails/);
    } finally {
      repo.cleanup();
    }
  });

  it('returns noop when promotion branch already contains integration', async () => {
    const repo = makeRepo();
    const shell = shellHarness({ isAncestor: true });

    try {
      const result = await runPromotion({
        repoDir: repo.repoDir,
        shellRunner: shell.shellRunner,
      });

      assert.deepEqual(result, { status: 'noop' });
      assert(!shell.calls.some((cmd) => cmd.includes('gh pr create')));
      assert(!shell.calls.some((cmd) => cmd.includes('gh pr edit')));
    } finally {
      repo.cleanup();
    }
  });

  it('reports pending checks without merging', async () => {
    const repo = makeRepo();
    const shell = shellHarness({
      openPrs: [{ number: 77, url: 'https://github.com/example/repo/pull/77', body: '' }],
      checks: [{ name: 'ci', state: 'IN_PROGRESS', conclusion: null }],
    });

    try {
      const result = await runPromotion({
        repoDir: repo.repoDir,
        shellRunner: shell.shellRunner,
      });

      assert.equal(result.status, 'updated');
      assert.match(result.checkSummary ?? '', /^pending:/);
      assert(!shell.calls.some((cmd) => cmd.includes('pr merge')));
    } finally {
      repo.cleanup();
    }
  });

  it('reports failing checks without merging', async () => {
    const repo = makeRepo();
    const shell = shellHarness({
      openPrs: [{ number: 77, url: 'https://github.com/example/repo/pull/77', body: '' }],
      checks: [{ name: 'ci', state: 'COMPLETED', conclusion: 'failure' }],
    });

    try {
      const result = await runPromotion({
        repoDir: repo.repoDir,
        shellRunner: shell.shellRunner,
      });

      assert.equal(result.status, 'updated');
      assert.match(result.checkSummary ?? '', /^failing:/);
      assert(!shell.calls.some((cmd) => cmd.includes('pr merge')));
    } finally {
      repo.cleanup();
    }
  });

  it('does not contain auto-merge logic', () => {
    const source = readFileSync(new URL('./promotion-controller.ts', import.meta.url), 'utf-8');
    assert(!source.includes('gh pr merge'));
  });
});
