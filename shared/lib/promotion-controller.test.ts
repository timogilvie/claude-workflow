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
  baseIntegrated?: boolean;
  alreadyPromoted?: boolean;
  openPrs?: Array<{ number: number; url: string; body?: string }>;
  mergedPrs?: Array<{ number: number; title: string; labels?: Array<{ name: string }> }>;
  checks?: Array<{ name: string; state?: string; conclusion?: string | null; bucket?: string | null }>;
  integrationTreeLog?: string;
  integrationTree?: string;
  promotionTree?: string;
  pushError?: string;
  fetchError?: string;
  mergeTreeResult?: 'clean' | 'conflicts' | 'unknown';
  statusPorcelain?: string;
} = {}): {
  shellRunner: (cmd: string, opts?: { encoding?: string; cwd?: string }) => string;
  calls: string[];
} {
  const calls: string[] = [];
  let tempFileCount = 0;
  let integrationTip = 'integration-sha';
  let remoteBaseMerged = overrides.baseIntegrated ?? true;

  return {
    calls,
    shellRunner: (cmd) => {
      calls.push(cmd);

      if (cmd === 'mktemp') {
        tempFileCount += 1;
        return tempFileCount === 1 ? '/tmp/promotion-body.txt' : `/tmp/promotion-body-${tempFileCount}.txt`;
      }

      if (cmd === "git fetch --quiet origin 'main'") {
        if (overrides.fetchError) throw new Error(overrides.fetchError);
        return '';
      }
      if (cmd === "git fetch --quiet origin 'main' 'auto/integration'") return '';
      if (cmd === 'git status --porcelain') return `${overrides.statusPorcelain ?? ''}`;
      if (cmd === "git switch 'auto/integration'") return '';
      if (cmd === "git merge --no-edit 'origin/main'") {
        remoteBaseMerged = true;
        integrationTip = 'updated-integration-sha';
        return '';
      }
      if (cmd === "git push origin 'auto/integration'") return '';

      if (cmd === "git rev-parse 'auto/integration' 2>/dev/null") return `${integrationTip}\n`;
      if (cmd === "git rev-parse 'main' 2>/dev/null") return 'main-sha\n';
      if (cmd === "git rev-parse 'origin/main' 2>/dev/null") return 'origin-main-sha\n';
      if (cmd === "git rev-parse 'integration-sha^{tree}'") return `${overrides.integrationTree ?? 'integration-tree'}\n`;
      if (cmd === "git rev-parse 'updated-integration-sha^{tree}'") return `${overrides.integrationTree ?? 'integration-tree'}\n`;
      if (cmd === "git rev-parse 'main-sha^{tree}'") return `${overrides.promotionTree ?? 'main-tree'}\n`;
      if (cmd === "git rev-parse 'origin-main-sha^{tree}'") return `${overrides.promotionTree ?? 'main-tree'}\n`;
      if (cmd === "git log --format='%H %T' 'auto/integration'") {
        const defaultLog = `${integrationTip} ${overrides.integrationTree ?? 'integration-tree'}\nold-sha old-tree\n`;
        return overrides.integrationTreeLog ?? defaultLog;
      }

      if (cmd === "git merge-base --is-ancestor 'origin-main-sha' 'integration-sha'") {
        if (remoteBaseMerged) return '';
        throw new Error('not ancestor');
      }
      if (cmd === "git merge-base --is-ancestor 'origin-main-sha' 'updated-integration-sha'") {
        if (remoteBaseMerged) return '';
        throw new Error('not ancestor');
      }
      if (cmd === "git merge-base --is-ancestor 'integration-sha' 'origin/main'") {
        if (overrides.alreadyPromoted) return '';
        throw new Error('not ancestor');
      }
      if (cmd === "git merge-base --is-ancestor 'updated-integration-sha' 'origin/main'") {
        if (overrides.alreadyPromoted) return '';
        throw new Error('not ancestor');
      }
      if (cmd === "git merge-base --is-ancestor 'origin-main-sha' 'main-sha'") {
        if (overrides.baseIntegrated ?? true) return '';
        throw new Error('not ancestor');
      }
      if (cmd === "git merge-base --is-ancestor 'origin-main-sha' 'reconciled-sha'") {
        if (overrides.baseIntegrated ?? true) return '';
        throw new Error('not ancestor');
      }
      if (cmd.includes('git merge-base --is-ancestor')) {
        if (overrides.alreadyPromoted || overrides.baseIntegrated) return '';
        throw new Error('not ancestor');
      }

      if (cmd === "git merge-tree --write-tree 'auto/integration' 'origin/main'") {
        if (overrides.mergeTreeResult === 'conflicts') throw new Error('merge-tree conflict');
        if (overrides.mergeTreeResult === 'unknown') throw new Error('merge-tree unavailable');
        return 'merged-tree-sha\n';
      }

      if (cmd.includes('gh pr list --state merged')) {
        return JSON.stringify(overrides.mergedPrs ?? [
          { number: 101, title: 'Add release guardrails', labels: [{ name: 'wavemill' }] },
        ]);
      }

      if (cmd.includes("git log --first-parent --oneline -n 10 'origin/main..auto/integration'")) {
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
      if (cmd === "git update-ref 'refs/heads/auto/integration' 'reconciled-sha' 'integration-sha'") {
        integrationTip = 'reconciled-sha';
        return '';
      }
      if (cmd === "git update-ref 'refs/heads/auto/integration' 'integration-sha' 'reconciled-sha'") return '';
      if (cmd === "git update-ref 'refs/heads/auto/integration' 'origin-main-sha' 'integration-sha'") {
        integrationTip = 'origin-main-sha';
        return '';
      }
      if (cmd === "git update-ref 'refs/heads/auto/integration' 'integration-sha' 'main-sha'") return '';
      if (
        cmd ===
        "git push --force-with-lease='refs/heads/auto/integration:integration-sha' origin 'refs/heads/auto/integration:refs/heads/auto/integration'"
      ) {
        if (overrides.pushError) throw new Error(overrides.pushError);
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
    const shell = shellHarness({ alreadyPromoted: true });

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
      baseIntegrated: false,
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
      assert(shell.calls.some((cmd) => cmd.includes("git commit-tree 'integration-sha^{tree}' -p 'origin-main-sha'")));
      assert(shell.calls.some((cmd) => cmd === "git update-ref 'refs/heads/auto/integration' 'reconciled-sha' 'integration-sha'"));
      assert(shell.calls.some((cmd) => cmd.includes("git push --force-with-lease='refs/heads/auto/integration:integration-sha'")));
      assert(shell.calls.some((cmd) => cmd.includes("git merge-base --is-ancestor 'reconciled-sha' 'origin/main'")));
    } finally {
      repo.cleanup();
    }
  });

  it('blocks when the integration branch is behind the fetched remote promotion base', async () => {
    const repo = makeRepo();
    const shell = shellHarness({
      baseIntegrated: false,
      openPrs: [{ number: 77, url: 'https://github.com/example/repo/pull/77', body: '' }],
    });

    try {
      const result = await runPromotion({
        repoDir: repo.repoDir,
        shellRunner: shell.shellRunner,
        interactive: false,
      });

      assert.equal(result.status, 'blocked');
      assert.equal(result.blockReason, 'base-behind');
      assert.match(result.blockSummary ?? '', /behind protected base/);
      assert.equal(result.prUrl, 'https://github.com/example/repo/pull/77');
      assert.match(result.checkSummary ?? '', /^passing:/);
      assert(shell.calls.includes("git fetch --quiet origin 'main'"));
      assert(shell.calls.includes("git rev-parse 'origin/main' 2>/dev/null"));
      assert(!shell.calls.some((cmd) => cmd.includes("git rev-parse 'main' 2>/dev/null")));
      assert(!shell.calls.some((cmd) => cmd.includes('gh api --method PATCH')));
      assert(!shell.calls.some((cmd) => cmd.includes('gh pr create')));
    } finally {
      repo.cleanup();
    }
  });

  it('blocks with base-unknown when fetching the remote promotion branch fails', async () => {
    const repo = makeRepo();
    const shell = shellHarness({
      fetchError: 'fatal: no such remote',
      openPrs: [{ number: 77, url: 'https://github.com/example/repo/pull/77', body: '' }],
    });

    try {
      const result = await runPromotion({
        repoDir: repo.repoDir,
        shellRunner: shell.shellRunner,
        interactive: false,
      });

      assert.equal(result.status, 'blocked');
      assert.equal(result.blockReason, 'base-unknown');
      assert.match(result.blockSummary ?? '', /failed to fetch origin\/main/);
      assert(!shell.calls.some((cmd) => cmd.includes("git rev-parse 'main' 2>/dev/null")));
      assert(!shell.calls.some((cmd) => cmd.includes("git merge-base --is-ancestor 'main-sha'")));
    } finally {
      repo.cleanup();
    }
  });

  it('does not update the integration branch when the user declines a clean base update', async () => {
    const repo = makeRepo();
    const shell = shellHarness({ baseIntegrated: false });

    try {
      const result = await runPromotion({
        repoDir: repo.repoDir,
        shellRunner: shell.shellRunner,
        interactive: true,
        confirmUpdate: async () => false,
      });

      assert.equal(result.status, 'blocked');
      assert.equal(result.blockReason, 'base-behind');
      assert(shell.calls.includes("git merge-tree --write-tree 'auto/integration' 'origin/main'"));
      assert(!shell.calls.some((cmd) => cmd === "git switch 'auto/integration'"));
      assert(!shell.calls.some((cmd) => cmd === "git push origin 'auto/integration'"));
    } finally {
      repo.cleanup();
    }
  });

  it('updates the integration branch when the user accepts a clean base update', async () => {
    const repo = makeRepo();
    const shell = shellHarness({
      baseIntegrated: false,
      openPrs: [{ number: 77, url: 'https://github.com/example/repo/pull/77', body: '' }],
    });

    try {
      const result = await runPromotion({
        repoDir: repo.repoDir,
        shellRunner: shell.shellRunner,
        healthChecker: async () => ({ state: 'healthy' }),
        interactive: true,
        confirmUpdate: async () => true,
      });

      assert.equal(result.status, 'updated');
      assert(shell.calls.includes("git fetch --quiet origin 'main' 'auto/integration'"));
      assert(shell.calls.includes("git switch 'auto/integration'"));
      assert(shell.calls.includes("git merge --no-edit 'origin/main'"));
      assert(shell.calls.includes("git push origin 'auto/integration'"));
      assert(shell.calls.filter((cmd) => cmd === "git rev-parse 'auto/integration' 2>/dev/null").length >= 2);
      assert(shell.calls.some((cmd) => cmd.includes("gh api --method PATCH 'repos/example/repo/pulls/77' --input")));
    } finally {
      repo.cleanup();
    }
  });

  it('auto-updates the integration branch in non-interactive mode when configured and clean', async () => {
    const repo = makeRepo({
      integration: {
        integrationBranch: 'auto/integration',
        promotionBranch: 'main',
        autoUpdatePromotionBranch: true,
      },
    });
    const shell = shellHarness({
      baseIntegrated: false,
      openPrs: [{ number: 77, url: 'https://github.com/example/repo/pull/77', body: '' }],
    });

    try {
      const result = await runPromotion({
        repoDir: repo.repoDir,
        shellRunner: shell.shellRunner,
        healthChecker: async () => ({ state: 'healthy' }),
        interactive: false,
      });

      assert.equal(result.status, 'updated');
      assert(shell.calls.includes("git fetch --quiet origin 'main' 'auto/integration'"));
      assert(shell.calls.includes("git merge --no-edit 'origin/main'"));
      assert(shell.calls.includes("git push origin 'auto/integration'"));
    } finally {
      repo.cleanup();
    }
  });

  it('blocks with conflict guidance when merging the protected base would conflict', async () => {
    const repo = makeRepo();
    const shell = shellHarness({
      baseIntegrated: false,
      mergeTreeResult: 'conflicts',
    });

    try {
      const result = await runPromotion({
        repoDir: repo.repoDir,
        shellRunner: shell.shellRunner,
        interactive: true,
        confirmUpdate: async () => true,
      });

      assert.equal(result.status, 'blocked');
      assert.equal(result.blockReason, 'base-behind-conflicts');
      assert.match(result.blockSummary ?? '', /expected to conflict/);
      assert(!shell.calls.some((cmd) => cmd === "git switch 'auto/integration'"));
      assert(!shell.calls.some((cmd) => cmd === "git push origin 'auto/integration'"));
    } finally {
      repo.cleanup();
    }
  });

  it('blocks with base-unknown when merge prediction is unavailable', async () => {
    const repo = makeRepo();
    const shell = shellHarness({
      baseIntegrated: false,
      mergeTreeResult: 'unknown',
    });

    try {
      const result = await runPromotion({
        repoDir: repo.repoDir,
        shellRunner: shell.shellRunner,
        interactive: false,
      });

      assert.equal(result.status, 'blocked');
      assert.equal(result.blockReason, 'base-unknown');
      assert.match(result.blockSummary ?? '', /merge-tree unavailable/);
      assert(!shell.calls.some((cmd) => cmd === "git switch 'auto/integration'"));
    } finally {
      repo.cleanup();
    }
  });

  it('restores local integration ref and explains protected branch rejection', async () => {
    const repo = makeRepo();
    const shell = shellHarness({
      baseIntegrated: false,
      integrationTree: 'current-integration-tree',
      promotionTree: 'promoted-tree',
      integrationTreeLog: [
        'integration-sha current-integration-tree',
        'previous-integration-sha promoted-tree',
        'older-sha old-tree',
      ].join('\n'),
      pushError: [
        'remote: error: GH006: Protected branch update failed for refs/heads/auto/integration.',
        'remote: - Cannot force-push to this branch',
      ].join('\n'),
    });

    try {
      await assert.rejects(
        runPromotion({
          repoDir: repo.repoDir,
          shellRunner: shell.shellRunner,
          healthChecker: async () => ({ state: 'healthy' }),
        }),
        /GitHub rejected the required reconciliation push to protected branch `auto\/integration`/,
      );
      assert(shell.calls.some((cmd) => cmd === "git update-ref 'refs/heads/auto/integration' 'reconciled-sha' 'integration-sha'"));
      assert(shell.calls.some((cmd) => cmd === "git update-ref 'refs/heads/auto/integration' 'integration-sha' 'reconciled-sha'"));
      assert(!shell.calls.some((cmd) => cmd.includes('gh pr create')));
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
