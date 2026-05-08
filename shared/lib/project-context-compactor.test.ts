import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it } from 'node:test';
import { compactProjectContext } from './project-context-compactor.ts';

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'project-context-compactor-'));
  mkdirSync(join(repo, '.wavemill'), { recursive: true });
  return repo;
}

function cleanup(repo: string): void {
  rmSync(repo, { recursive: true, force: true });
}

function writeContext(repo: string, content: string): void {
  writeFileSync(join(repo, '.wavemill', 'project-context.md'), content, 'utf-8');
}

function makeEntries(count: number): string {
  return Array.from({ length: count }, (_, index) => {
    const day = String((index % 28) + 1).padStart(2, '0');
    return `### 2026-05-${day}\n\nEntry ${index + 1}`;
  }).join('\n\n---\n\n');
}

describe('compactProjectContext', () => {
  it('preserves content above Recent Work header verbatim', async () => {
    const repo = makeRepo();
    try {
      const preamble = '# Header\n\nKeep this exact spacing.\n\n';
      writeContext(repo, `${preamble}## Recent Work\n\n### 2026-05-01\n\nA\n\n---\n\n### 2026-05-02\n\nB`);

      await compactProjectContext({ repoDir: repo, thresholdKb: 0, keepRecent: 1 });
      const updated = readFileSync(join(repo, '.wavemill', 'project-context.md'), 'utf-8');
      assert.equal(updated.startsWith(`${preamble}## Recent Work`), true);
    } finally {
      cleanup(repo);
    }
  });

  it('keeps only the most recent N entries', async () => {
    const repo = makeRepo();
    try {
      writeContext(repo, `# Context\n\n## Recent Work\n\n${makeEntries(60)}`);
      const result = await compactProjectContext({ repoDir: repo, thresholdKb: 0, keepRecent: 25 });
      assert.equal(result.entriesKept, 25);
      assert.equal(result.entriesArchived, 35);
    } finally {
      cleanup(repo);
    }
  });

  it('uses collision-safe archive naming', async () => {
    const repo = makeRepo();
    try {
      const now = new Date();
      const stamp = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
      writeFileSync(join(repo, '.wavemill', `project-context-archive-${stamp}.md`), 'existing', 'utf-8');
      writeContext(repo, '# Context\n\n## Recent Work\n\n### 2026-05-01\n\nA\n\n---\n\n### 2026-05-02\n\nB');

      const result = await compactProjectContext({ repoDir: repo, thresholdKb: 0, keepRecent: 1 });
      assert.match(result.archivedPath ?? '', new RegExp(`project-context-archive-${stamp}-1\\.md$`));
    } finally {
      cleanup(repo);
    }
  });

  it('refuses to compact when Recent Work header is absent', async () => {
    const repo = makeRepo();
    try {
      writeContext(repo, '# Context\n\nNo section here');
      await assert.rejects(
        compactProjectContext({ repoDir: repo, thresholdKb: 0, keepRecent: 1 }),
        /header not found/
      );
    } finally {
      cleanup(repo);
    }
  });

  it('dry run does not write files', async () => {
    const repo = makeRepo();
    try {
      const content = `# Context\n\n## Recent Work\n\n${makeEntries(10)}`;
      writeContext(repo, content);
      const result = await compactProjectContext({ repoDir: repo, thresholdKb: 0, keepRecent: 1, dryRun: true });

      const after = readFileSync(join(repo, '.wavemill', 'project-context.md'), 'utf-8');
      assert.equal(after, content);
      assert.equal(result.archivedPath, null);
    } finally {
      cleanup(repo);
    }
  });

  it('skips when file is under threshold', async () => {
    const repo = makeRepo();
    try {
      writeContext(repo, '# Context\n\n## Recent Work\n\n### 2026-05-01\n\nA');
      const result = await compactProjectContext({ repoDir: repo, thresholdKb: 999, keepRecent: 1 });
      assert.equal(result.skipped, true);
      assert.equal(result.archivedPath, null);
    } finally {
      cleanup(repo);
    }
  });

  it('skips when file is under threshold in dry-run mode', async () => {
    const repo = makeRepo();
    try {
      writeContext(repo, '# Context\n\n## Recent Work\n\n### 2026-05-01\n\nA');
      const result = await compactProjectContext({ repoDir: repo, thresholdKb: 999, keepRecent: 1, dryRun: true });
      assert.equal(result.skipped, true);
      assert.equal(result.dryRun, true);
    } finally {
      cleanup(repo);
    }
  });

  it('preserves entry bodies when compacting heading-format entries', async () => {
    const repo = makeRepo();
    try {
      const content = [
        '# Context',
        '',
        '## Recent Work',
        '',
        '### 2026-05-01',
        '',
        'Body of first entry with multiple lines.',
        '',
        '### 2026-05-02',
        '',
        'Body of second entry.',
        '',
        '### 2026-05-03',
        '',
        'Body of third entry.',
      ].join('\n');
      writeContext(repo, content);

      await compactProjectContext({ repoDir: repo, thresholdKb: 0, keepRecent: 2 });
      const updated = readFileSync(join(repo, '.wavemill', 'project-context.md'), 'utf-8');

      assert.ok(updated.includes('Body of second entry.'), 'second entry body preserved');
      assert.ok(updated.includes('Body of third entry.'), 'third entry body preserved');
      assert.ok(!updated.includes('Body of first entry'), 'first entry body removed');
    } finally {
      cleanup(repo);
    }
  });
});
