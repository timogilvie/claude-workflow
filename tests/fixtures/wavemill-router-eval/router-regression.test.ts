import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { analyzePrompt } from '../../../shared/lib/model-router.ts';
import { analyzeTaskContext, type IssueData } from '../../../shared/lib/task-context-analyzer.ts';

type LabeledPacket = {
  issueId: string;
  issue: IssueData;
  prompt: string;
  filesTouched: number;
  locTouched: number;
  expectedTaskType: 'feature' | 'bugfix';
  expectedComplexityBand: 'xs' | 's' | 'm' | 'l' | 'xl';
};

const labeledPackets: LabeledPacket[] = [
  {
    issueId: 'HOK-2845',
    issue: {
      title: 'Task scorer: predict whether a task packet is ready to run before spending an arm',
      description:
        'Build a new scorer under src/evaluation/scorers/wavemill with statistical analysis, a v1 model, two CLIs, an eval schema minor bump, and shadow-mode dispatch integration.',
    },
    prompt: `# Task scorer: predict whether a task packet is ready to run before spending an arm

## Objective

Build a new scorer under src/evaluation/scorers/wavemill with statistical analysis, a v1 model, two CLIs, an eval schema minor bump, and shadow-mode dispatch integration.

## Implementation plan

1. Add new modules.
2. Add model training and analysis.
3. Wire shadow-mode dispatch.`,
    filesTouched: 14,
    locTouched: 2131,
    expectedTaskType: 'feature',
    expectedComplexityBand: 'xl',
  },
  {
    issueId: 'HOK-2869',
    issue: {
      title: 'Ready watchdog never clears a resolved classification',
      description: 'Fix the one-file watchdog bug so resolved classifications are cleared.',
    },
    prompt: `Title: Ready watchdog never clears a resolved classification

Fix the one-file watchdog bug so resolved classifications are cleared.`,
    filesTouched: 1,
    locTouched: 24,
    expectedTaskType: 'bugfix',
    expectedComplexityBand: 'xs',
  },
  {
    issueId: 'HOK-2848',
    issue: {
      title: 'Observer coding marker ignored check has no grace period',
      description: 'Fix the observer marker regression in a single shell test path.',
    },
    prompt: `Observer coding marker ignored check has no grace period

Fix the observer marker regression in a single shell test path.`,
    filesTouched: 1,
    locTouched: 41,
    expectedTaskType: 'bugfix',
    expectedComplexityBand: 'xs',
  },
  {
    issueId: 'HOK-2852',
    issue: {
      title: 'Persist rejected eval records instead of discarding them',
      description: 'Fix eval persistence so rejected records are stored for validation diagnostics.',
    },
    prompt: `# Persist rejected eval records instead of discarding them

## Objective

Fix eval persistence so rejected records are stored for validation diagnostics.`,
    filesTouched: 3,
    locTouched: 90,
    expectedTaskType: 'bugfix',
    expectedComplexityBand: 's',
  },
];

describe('wavemill router classifier regression corpus', () => {
  for (const packet of labeledPackets) {
    it(`${packet.issueId} agrees with eval task type and complexity band`, () => {
      const routerSignals = analyzePrompt(packet.prompt, {
        filesTouched: packet.filesTouched,
        locTouched: packet.locTouched,
      });
      const evalSignals = analyzeTaskContext({
        issue: packet.issue,
        filesTouched: packet.filesTouched,
        locTouched: packet.locTouched,
      });

      assert.equal(routerSignals.taskType, packet.expectedTaskType);
      assert.equal(evalSignals.taskType, packet.expectedTaskType);
      assert.equal(routerSignals.complexityBand, packet.expectedComplexityBand);
      assert.equal(evalSignals.complexity, packet.expectedComplexityBand);
    });
  }

  it('separates greenfield feature work from single-file fixes', () => {
    const [greenfield, ...fixes] = labeledPackets;
    const greenfieldSignals = analyzePrompt(greenfield.prompt, {
      filesTouched: greenfield.filesTouched,
      locTouched: greenfield.locTouched,
    });

    assert.equal(greenfieldSignals.taskType, 'feature');
    assert.equal(greenfieldSignals.complexityScore, 5);

    for (const fix of fixes) {
      const fixSignals = analyzePrompt(fix.prompt, {
        filesTouched: fix.filesTouched,
        locTouched: fix.locTouched,
      });

      assert.equal(fixSignals.taskType, 'bugfix', fix.issueId);
      assert.ok(fixSignals.complexityScore < greenfieldSignals.complexityScore, fix.issueId);
    }
  });
});
