import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import {
  buildScopeConstraintContext,
  scopeShrinkerDeps,
  shouldSplitPacket,
  splitPacketIntoSubPackets,
} from './scope-shrinker.ts';

function buildPacket(fileCount: number, extraLines = 0): string {
  const keyFiles = Array.from({ length: fileCount }, (_, index) => `- \`src/file-${index + 1}.ts\``).join('\n');
  const padding = Array.from({ length: extraLines }, (_, index) => `line ${index + 1}`).join('\n');

  return [
    '## 1. Objective',
    '',
    'Implement scoped work',
    '',
    '## 2. Technical Context',
    '',
    '### Key Files',
    keyFiles,
    '',
    '## 3. Implementation Approach',
    '',
    '1. Make the change',
    '',
    '## 4. Success Criteria',
    '',
    '- [ ] Requirement holds',
    '',
    padding,
  ].join('\n');
}

describe('buildScopeConstraintContext', () => {
  it('returns empty string in normal mode', () => {
    assert.equal(buildScopeConstraintContext('normal'), '');
  });

  it('includes constrained guidance', () => {
    const text = buildScopeConstraintContext('constrained');
    assert.match(text, /10 files/i);
    assert.match(text, /speculative refactors?/i);
  });

  it('includes survival guidance', () => {
    const text = buildScopeConstraintContext('survival');
    assert.match(text, /5 files/i);
    assert.match(text, /one-file patches?/i);
  });
});

describe('shouldSplitPacket', () => {
  it('does not split a small packet in survival mode', () => {
    assert.equal(shouldSplitPacket(buildPacket(3), 'survival'), false);
  });

  it('splits a large packet in survival mode', () => {
    assert.equal(shouldSplitPacket(buildPacket(6), 'survival'), true);
  });

  it('splits a large packet in constrained mode only above 10 files', () => {
    assert.equal(shouldSplitPacket(buildPacket(10), 'constrained'), false);
    assert.equal(shouldSplitPacket(buildPacket(11), 'constrained'), true);
  });

  it('never splits in normal mode', () => {
    assert.equal(shouldSplitPacket(buildPacket(20, 500), 'normal'), false);
  });
});

describe('splitPacketIntoSubPackets', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('returns parsed packet content from a valid JSON response', async () => {
    mock.method(scopeShrinkerDeps, 'callClaude', async () => ({
      text: JSON.stringify([
        { title: 'Packet 1', content: '## 1. Objective\n\nPacket one' },
        { title: 'Packet 2', content: '## 1. Objective\n\nPacket two' },
      ]),
      rawOutput: '',
      provider: 'claude',
      model: '(default)',
    }));

    const result = await splitPacketIntoSubPackets(buildPacket(8), 'survival');
    assert.deepEqual(result, ['## 1. Objective\n\nPacket one', '## 1. Objective\n\nPacket two']);
  });

  it('falls back to the original packet when splitting throws', async () => {
    const fullContent = buildPacket(8);

    mock.method(scopeShrinkerDeps, 'callClaude', async () => {
      throw new Error('boom');
    });

    const result = await splitPacketIntoSubPackets(fullContent, 'survival');
    assert.deepEqual(result, [fullContent]);
  });
});
