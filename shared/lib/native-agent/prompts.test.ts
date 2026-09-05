import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  loadNativePhasePrompt,
  renderNativePhasePrompt,
  renderToolCatalog,
} from './prompts.ts';
import { createToolRegistry } from './tools/registry.ts';
import { createReadOnlyTools } from './tools/read-only.ts';
import { createGitTools } from './tools/git.ts';
import { createArtifactTools } from './tools/artifacts.ts';
import type { ToolMetadata } from './tools/types.ts';

const WORKTREE = process.cwd();

function planningMetadata(): ToolMetadata[] {
  const registry = createToolRegistry([
    ...createReadOnlyTools(WORKTREE),
    ...createGitTools(WORKTREE),
    ...createArtifactTools(WORKTREE),
  ]);
  return registry.list({ phase: 'planning' });
}

function reviewMetadata(): ToolMetadata[] {
  const registry = createToolRegistry([
    ...createReadOnlyTools(WORKTREE),
    ...createGitTools(WORKTREE),
  ]);
  return registry.list({ phase: 'review' });
}

describe('prompts: renderToolCatalog', () => {
  it('renders one line per tool with name and mutation class', () => {
    const catalog = renderToolCatalog([
      {
        name: 'read_file',
        description: 'Read the contents of a file. Supports line windowing.',
        class: 'read-only',
        allowedPhases: ['planning'],
        executionMode: 'parallel',
        outputCapPolicy: { strategy: 'none' },
      },
    ]);
    assert.equal(catalog, '- `read_file` (read-only) — Read the contents of a file.');
  });

  it('trims each description to its first sentence', () => {
    const catalog = renderToolCatalog([
      {
        name: 'search_text',
        description: 'First sentence. Second sentence that should be dropped.',
        class: 'read-only',
        allowedPhases: ['review'],
        executionMode: 'parallel',
        outputCapPolicy: { strategy: 'none' },
      },
    ]);
    assert.ok(catalog.includes('First sentence.'));
    assert.ok(!catalog.includes('Second sentence'));
  });

  it('reports an empty phase rather than rendering nothing', () => {
    assert.equal(renderToolCatalog([]), '- (no tools are registered for this phase)');
  });
});

describe('prompts: renderNativePhasePrompt', () => {
  it('substitutes every placeholder for a known phase', () => {
    const rendered = renderNativePhasePrompt(
      'role={{PHASE_ROLE}} objective={{PHASE_OBJECTIVE}} out={{PHASE_OUTPUT}} tools={{TOOL_CATALOG}}',
      { tools: reviewMetadata(), phase: 'review' },
    );
    assert.ok(!rendered.includes('{{'), 'no placeholder may survive rendering');
    assert.ok(rendered.includes('read-only native review agent'));
  });

  it('falls back to phase-neutral text when no phase is given', () => {
    const rendered = renderNativePhasePrompt('{{PHASE_ROLE}}|{{TOOL_CATALOG}}');
    assert.ok(rendered.startsWith('read-only native agent|'));
    assert.ok(
      rendered.includes("supplied in this session's tool schemas"),
      'unknown tool sets must degrade to an accurate statement, not a stale list',
    );
  });

  it('leaves templates without placeholders unchanged', () => {
    const template = 'no placeholders here';
    assert.equal(renderNativePhasePrompt(template, { phase: 'planning' }), template);
  });
});

describe('prompts: loadNativePhasePrompt', () => {
  it('lists every planning tool the registry exposes, including artifact tools', () => {
    const metadata = planningMetadata();
    const { content } = loadNativePhasePrompt(WORKTREE, { tools: metadata, phase: 'planning' });

    assert.ok(metadata.length > 0, 'planning phase must expose tools');
    for (const tool of metadata) {
      assert.ok(
        content.includes(`\`${tool.name}\``),
        `rendered prompt must mention registry tool ${tool.name}`,
      );
    }
    // Regression: these were registered but absent from the hand-written list.
    assert.ok(content.includes('`read_task_packet`'));
    assert.ok(content.includes('`read_plan`'));
  });

  it('does not advertise tools the phase denies', () => {
    const { content } = loadNativePhasePrompt(WORKTREE, {
      tools: reviewMetadata(),
      phase: 'review',
    });
    assert.ok(!content.includes('`git_commit`'));
    assert.ok(!content.includes('`apply_patch`'));
  });

  it('gives each phase its own role and output section', () => {
    const planning = loadNativePhasePrompt(WORKTREE, {
      tools: planningMetadata(),
      phase: 'planning',
    }).content;
    const review = loadNativePhasePrompt(WORKTREE, {
      tools: reviewMetadata(),
      phase: 'review',
    }).content;

    assert.ok(planning.includes('read-only native planning agent'));
    assert.ok(planning.includes('implementation plan'));
    assert.ok(review.includes('read-only native review agent'));
    assert.ok(
      !review.includes('Produce a clear, structured implementation plan'),
      'review must not be told to produce an implementation plan',
    );
  });

  it('keeps the prompt hash stable across phases', () => {
    // The registry logs the template, not the rendered per-phase text, so
    // harnessId does not fragment by phase.
    const planning = loadNativePhasePrompt(WORKTREE, {
      tools: planningMetadata(),
      phase: 'planning',
    });
    const review = loadNativePhasePrompt(WORKTREE, {
      tools: reviewMetadata(),
      phase: 'review',
    });

    assert.notEqual(planning.content, review.content);
    assert.equal(planning.promptRef?.id, review.promptRef?.id);
  });
});
