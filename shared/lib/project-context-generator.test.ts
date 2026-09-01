import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { generateProjectContext } from './project-context-generator.ts';
import { searchSubsystemSpecs } from './subsystem-search.ts';

function write(repoDir: string, relativePath: string, content: string): void {
  const path = join(repoDir, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf-8');
}

function git(repoDir: string, args: string[]): void {
  execFileSync('git', args, {
    cwd: repoDir,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}

test('refresh preserves curated memory and Recent Work while updating navigation', async (t) => {
  const repoDir = mkdtempSync(join(tmpdir(), 'wavemill-context-refresh-'));
  t.after(() => rmSync(repoDir, { recursive: true, force: true }));
  t.mock.method(console, 'log', () => undefined);

  write(repoDir, 'package.json', JSON.stringify({
    type: 'module',
    scripts: { test: 'node --test' },
  }));
  write(repoDir, 'shared/lib/model-router.ts', 'export const modelRouter = true;\n');
  write(repoDir, 'tools/stage-router.ts', 'export const stageRouter = true;\n');
  write(repoDir, 'src/workflow-router.ts', 'export const workflowRouter = true;\n');

  const recentWork = `## Recent Work (Append-Only Log)

### 2026-08-31 - Preserve this entry

This history must survive documentation refresh.
`;
  write(repoDir, '.wavemill/project-context.md', `# Project Context

## Architecture Overview

The controller coordinates planning, coding, review, and evaluation.

## Subsystem Documentation

- [Old](context/old.md)

---
${recentWork}`);
  write(repoDir, '.wavemill/context/router.md', `# Router

## Purpose

Routes work across model classes.

## Architectural Constraints

### DON'T
- Trigger constrained mode while any frontier sibling is healthy.

## Expanded Packet Reroute

Use routeExpandedPackets for approved task packets.
`);
  write(repoDir, '.wavemill/context/eval-system.md', `# Evaluation System

## Purpose

Persists evaluation evidence for routing and reporting.
`);

  git(repoDir, ['init']);
  git(repoDir, ['config', 'user.email', 'test@example.com']);
  git(repoDir, ['config', 'user.name', 'Test User']);
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-m', 'initial repository']);
  write(repoDir, 'src/workflow-router.ts', 'export const workflowRouter = true;\nexport const revision = 2;\n');
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-m', 'update workflow router']);

  await generateProjectContext({ repoDir, force: false, refresh: true });
  await generateProjectContext({ repoDir, force: false, refresh: true });

  const projectContext = readFileSync(join(repoDir, '.wavemill/project-context.md'), 'utf-8');
  const router = readFileSync(join(repoDir, '.wavemill/context/router.md'), 'utf-8');

  assert.equal(projectContext.slice(projectContext.indexOf('## Recent Work')), recentWork);
  assert.match(projectContext, /The controller coordinates planning, coding, review, and evaluation\./);
  assert.match(projectContext, /\[Evaluation System\]\(context\/eval-system\.md\)/);
  assert.match(projectContext, /\[Router\]\(context\/router\.md\)/);
  assert.match(router, /Trigger constrained mode while any frontier sibling is healthy\./);
  assert.match(router, /Use routeExpandedPackets for approved task packets\./);
  assert.equal(router.match(/wavemill:generated-navigation:start/g)?.length, 1);
  assert.doesNotMatch(router, /TODO:/);
  assert.equal(
    searchSubsystemSpecs('frontier sibling', repoDir)[0]?.subsystemId,
    'router',
  );
  assert.equal(
    searchSubsystemSpecs('routeExpandedPackets', repoDir)[0]?.subsystemName,
    'Router',
  );
  assert.equal(
    readFileSync(join(repoDir, '.wavemill/context/eval-system.md'), 'utf-8'),
    `# Evaluation System\n\n## Purpose\n\nPersists evaluation evidence for routing and reporting.\n`,
  );
  assert.equal(
    existsSync(join(repoDir, '.wavemill/context/git-cluster-1.md')),
    false,
  );
});

test('refresh indexes curated pages even when heuristic detection finds no subsystem', async (t) => {
  const repoDir = mkdtempSync(join(tmpdir(), 'wavemill-context-curated-only-'));
  t.after(() => rmSync(repoDir, { recursive: true, force: true }));
  t.mock.method(console, 'log', () => undefined);

  write(repoDir, '.wavemill/project-context.md', `# Project Context

## Architecture Overview

Manual architecture.

## Recent Work

Keep me.
`);
  write(repoDir, '.wavemill/context/operations.md', `# Operations

## Purpose

Operator runbooks and recovery invariants.
`);
  git(repoDir, ['init']);
  git(repoDir, ['config', 'user.email', 'test@example.com']);
  git(repoDir, ['config', 'user.name', 'Test User']);
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-m', 'add curated context']);
  write(repoDir, 'README.md', '# Fixture repository\n');
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-m', 'add readme']);

  await generateProjectContext({ repoDir, force: false, refresh: true });

  const projectContext = readFileSync(join(repoDir, '.wavemill/project-context.md'), 'utf-8');
  assert.match(projectContext, /\[Operations\]\(context\/operations\.md\)/);
  assert.equal(projectContext.slice(projectContext.indexOf('## Recent Work')), '## Recent Work\n\nKeep me.\n');
  assert.equal(
    readFileSync(join(repoDir, '.wavemill/context/operations.md'), 'utf-8'),
    `# Operations\n\n## Purpose\n\nOperator runbooks and recovery invariants.\n`,
  );
});

test('refresh refuses to publish a lint-failing context index', async (t) => {
  const repoDir = mkdtempSync(join(tmpdir(), 'wavemill-context-lint-gate-'));
  t.after(() => rmSync(repoDir, { recursive: true, force: true }));
  t.mock.method(console, 'log', () => undefined);

  const projectContext = '# Project Context\n\n## Recent Work\n\nKeep me.\n';
  write(repoDir, '.wavemill/project-context.md', projectContext);
  write(repoDir, '.wavemill/context/operations.md', `# Operations

## Purpose

Operator guidance.

## Related Subsystems

- [Missing](missing.md)
`);
  git(repoDir, ['init']);
  git(repoDir, ['config', 'user.email', 'test@example.com']);
  git(repoDir, ['config', 'user.name', 'Test User']);
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-m', 'add invalid context']);
  write(repoDir, 'README.md', '# Fixture repository\n');
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-m', 'add readme']);

  await assert.rejects(
    generateProjectContext({ repoDir, force: false, refresh: true }),
    /refusing to publish a lint-failing context refresh.*stale-crossref/,
  );
  assert.equal(readFileSync(join(repoDir, '.wavemill/project-context.md'), 'utf-8'), projectContext);
});
