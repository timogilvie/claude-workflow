import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyTaskPacket, isSuspiciousZeroClassification } from './task-packet-classifier.ts';
import { buildTaskDescriptor } from './task-descriptor-builder.ts';

const fixtureDir = join(process.cwd(), 'tests', 'fixtures', 'router-signal-corpus');

function fixture(name: string): string {
  return readFileSync(join(fixtureDir, name), 'utf-8');
}

describe('task-packet-classifier', () => {
  it('classifies the HOK-2845 greenfield packet as high-complexity feature work', () => {
    const packet = fixture('hok-2845-greenfield.md');
    const classification = classifyTaskPacket(packet);

    assert.equal(classification.taskType, 'feature');
    assert.equal(classification.complexity, 5);
    assert.equal(classification.complexityBand, 'xl');
    assert.ok(classification.riskFlags.includes('greenfield'));
    assert.ok(classification.riskFlags.includes('large-scope-refactor'));
  });

  it('distinguishes focused bugfix packets from feature builds', () => {
    const watchdog = classifyTaskPacket(fixture('hok-2869-watchdog-fix.md'));
    const persistence = classifyTaskPacket(fixture('hok-2852-eval-persistence-fix.md'));

    assert.equal(watchdog.taskType, 'bugfix');
    assert.equal(persistence.taskType, 'bugfix');
    assert.ok(watchdog.complexity <= 3);
    assert.ok(persistence.complexity <= 3);
  });

  it('keeps router and descriptor/eval signals aligned on the corpus', () => {
    for (const file of [
      'hok-2845-greenfield.md',
      'hok-2869-watchdog-fix.md',
      'hok-2852-eval-persistence-fix.md',
    ]) {
      const packet = fixture(file);
      const classification = classifyTaskPacket(packet);
      const descriptor = buildTaskDescriptor({ originalPrompt: packet });

      assert.equal(descriptor.signals.heuristic.task_type, classification.taskType, file);
      assert.equal(descriptor.signals.learned.complexity, classification.complexity, file);
      assert.deepEqual(descriptor.signals.learned.risk_flags, classification.riskFlags, file);
    }
  });

  it('treats zero complexity with structural evidence as suspicious', () => {
    const classification = classifyTaskPacket(fixture('hok-2845-greenfield.md'));
    const suspicious = isSuspiciousZeroClassification({
      ...classification,
      complexityScore: 0,
    });

    assert.equal(suspicious.suspicious, true);
    assert.match(suspicious.reason || '', /^zero_complexity_/);
  });
});

