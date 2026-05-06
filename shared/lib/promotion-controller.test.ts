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
  checks?: Array<{ name: string; state?: string; conclusion?: string | null; bucket?: string | null }>;
  integrationTreeLog?: string;
  integrationTree?: string;
  promotionTree?: string;
} = {}): {
  shellRunner: (cmd: string, opts?: { encoding?: string; cwd?: string }) => string;
  calls: string[];
} {
  const calls: string[] = [];
  let tempFileCount = 0;

  return {
    calls,
    shellRunner: (cmd) => {
      calls.push(cmd);

      if (cmd === 'mktemp') {
        tempFileCount += 1;
        return tempFileCount === 1 ? '/tmp/promotion-body.txt' : `/tmp/promotion-body-${tempFileCount}.txt`;
      }

      if (cmd === "git rev-parse 'auto/integration' 2>/dev/null") return 'integration-sha\n';
      if (cmd === "git rev-parse 'main' 2>/dev/null") return 'main-sha\n';
      if (cmd === "git rev-parse 'integration-sha^{tree}'") return `${overrides.integrationTree ?? 'integration-tree'}\n`;
      if (cmd === "git rev-parse 'main-sha^{tree}'") return `${overrides.promotionTree ?? 'main-tree'}\n`;
      if (cmd === "git log --format='%H %T' 'auto/integration'") {
        return overrides.integrationTreeLog ?? 'integration-sha integration-tree\nold-sha old-tree\n';
      }

      if (cmd.includes('git merge-base --is-ancestor')) {
        if (overrides.isAncestor) return '';
        throw new Error('not ancestor');
      }

      if (cmd.includes('gh pr list --state merged')) {
        return JSON.stringify(overrides.mergedPrs ?? [
          { number: 101, title: 'Add release guardrails', labels: [{ name: 'wavemill' }] },
        ]);
      }

      if (cmd.includes("git log --first-parent --oneline -n 10 'main..auto/integration'")) {
        return 'abc123 Add release guardrails (#101)\n';
      }

      if (cmd.includes("git log --first-parent --oneline -n 10 'previous-integration-sha..auto/integration'")) {
        return 'abc123 Add release guardrails (#101)\n';
      }

      if (cmd.includes("gh pr list --head 'auto/integration' --base 'main' --state open --json number,url,body")) {
        return JSON.stringify(overrides.openPrs ?? []);
      }

      if (cmd === 'gh repo view --json nameWithOwner --jq .nameWithOwner') return 'example/repo\n';
      if (cmd.includes("gh api --method PATCH 'repos/example/repo/pulls/77' --input")) return '';
      if (cmd.includes('gh pr create')) return 'https://github.com/example/repo/pull/88\n';
      if (cmd.includes("rm -f '/tmp/promotion-body.txt'")) return '';
      if (cmd.includes("rm -f '/tmp/promotion-body-")) return '';
      if (cmd.includes("git commit-tree 'integration-sha^{tree}'")) return 'reconciled-sha\n';
      if (cmd === "git update-ref 'refs/heads/auto/integration' 'reconciled-sha' 'integration-sha'") return '';
      if (cmd === "git update-ref 'refs/heads/auto/integration' 'main-sha' 'integration-sha'") return '';
      if (
        cmd ===
        "git push --force-with-lease='refs/heads/auto/integration:integration-sha' origin 'refs/heads/auto/integration:refs/heads/auto/integration'"
      ) {
        return '';
      }

      if (cmd.includes('gh pr checks')) {
        return JSON.stringify(overrides.checks ?? [
          { name: 'ci', state: 'COMPLETED', bucket: 'pass' },
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
      assert(shell.calls.some((cmd) => cmd.includes("gh api --method PATCH 'repos/example/repo/pulls/77' --input")));
      assert(!shell.calls.some((cmd) => cmd.includes('gh pr create')));
      // Body is written directly via writeFileSync; rm -f is mocked so file persists
      const writtenBody = readFileSync('/tmp/promotion-body.txt', 'utf-8');
      const parsedBody = JSON.parse(writtenBody).body;
      assert.match(parsedBody, /Promotion Summary/);
      assert.match(parsedBody, /PR #101: Add release guardrails/);
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
      assert(!shell.calls.some((cmd) => cmd.includes('gh api --method PATCH')));
    } finally {
      repo.cleanup();
    }
  });

  it('rewrites integration onto main when a prior squash promotion is present by tree', async () => {
    const repo = makeRepo();
    const shell = shellHarness({
      integrationTree: 'current-integration-tree',
      promotionTree: 'promoted-tree',
      integrationTreeLog: [
        'integration-sha current-integration-tree',
        'previous-integration-sha promoted-tree',
        'older-sha old-tree',
      ].join('\n'),
      openPrs: [{ number: 77, url: 'https://github.com/example/repo/pull/77', body: '' }],
    });

    try {
      const result = await runPromotion({
        repoDir: repo.repoDir,
        shellRunner: shell.shellRunner,
        healthChecker: async () => ({ state: 'healthy' }),
      });

      assert.equal(result.status, 'updated');
      assert(shell.calls.some((cmd) => cmd.includes("git commit-tree 'integration-sha^{tree}' -p 'main-sha'")));
      assert(shell.calls.some((cmd) => cmd === "git update-ref 'refs/heads/auto/integration' 'reconciled-sha' 'integration-sha'"));
      assert(shell.calls.some((cmd) => cmd.includes("git push --force-with-lease='refs/heads/auto/integration:integration-sha'")));
      assert(shell.calls.some((cmd) => cmd.includes("git merge-base --is-ancestor 'reconciled-sha' 'main'")));
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

  it('reports pending checks when gh has not created checks yet', async () => {
    const repo = makeRepo();
    const shell = shellHarness({
      openPrs: [{ number: 77, url: 'https://github.com/example/repo/pull/77', body: '' }],
    });
    const shellRunner = (cmd: string, opts?: { encoding?: string; cwd?: string }) => {
      if (cmd.includes('gh pr checks')) {
        shell.calls.push(cmd);
        return "no checks reported on the 'auto/integration' branch";
      }
      return shell.shellRunner(cmd, opts);
    };

    try {
      const result = await runPromotion({
        repoDir: repo.repoDir,
        shellRunner,
      });

      assert.equal(result.status, 'updated');
      assert.equal(result.checkSummary, 'pending: No PR checks reported.');
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

  it('reports failing checks from gh bucket output without merging', async () => {
    const repo = makeRepo();
    const shell = shellHarness({
      openPrs: [{ number: 77, url: 'https://github.com/example/repo/pull/77', body: '' }],
      checks: [{ name: 'ci', state: 'COMPLETED', bucket: 'fail' }],
    });

    try {
      const result = await runPromotion({
        repoDir: repo.repoDir,
        shellRunner: shell.shellRunner,
      });

      assert.equal(result.status, 'updated');
      assert.match(result.checkSummary ?? '', /^failing:/);
      assert.match(result.checkSummary ?? '', /ci: fail/);
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
