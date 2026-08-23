/**
 * Tests for task-packet-utils.ts
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getTaskPacketArtifactPaths,
  splitTaskPacket,
  isValidTaskPacket,
  isTaskPacketContent,
  isTaskPacketFile,
  writeTaskPacketArtifacts,
  extractReleaseReadiness,
} from './task-packet-utils.ts';

describe('splitTaskPacket', () => {
  test('splits task packet with marker', () => {
    const taskPacket = `# Task Packet Header

## Objective
Implement feature X

<!-- SPLIT: HEADER ABOVE, DETAILS BELOW -->

## 1. Complete Objective
Full objective details here

## 2. Technical Context
Context details here`;

    const result = splitTaskPacket(taskPacket);

    assert.ok(result.header.includes('# Task Packet Header'));
    assert.ok(result.header.includes('## Objective'));
    assert.equal(result.header.includes('SPLIT:'), false);
    assert.ok(result.details.includes('## 1. Complete Objective'));
    assert.ok(result.details.includes('## 2. Technical Context'));
    assert.ok(result.fullContent.includes('---'));
  });

  test('handles legacy format without marker', () => {
    const taskPacket = `## 1. Objective

Implement feature X

### Key Files
- file1.ts
- file2.ts

## 2. Technical Context
Details here`;

    const result = splitTaskPacket(taskPacket);

    assert.ok(result.header.includes('# Task Packet'));
    assert.ok(result.header.includes('## 1. Objective'));
    assert.ok(result.header.includes('### Key Files'));
    assert.equal(result.details, taskPacket);
    assert.equal(result.fullContent, taskPacket);
  });

  test('generates header when objective section exists', () => {
    const taskPacket = `## 1. Objective

Build authentication

## 2. Technical Context
Details`;

    const result = splitTaskPacket(taskPacket);

    assert.ok(result.header.includes('## 1. Objective'));
    assert.ok(result.header.includes('Build authentication'));
  });

  test('handles missing objective section gracefully', () => {
    const taskPacket = `## Some Other Section

Content here`;

    const result = splitTaskPacket(taskPacket);

    assert.ok(result.header.includes('See details below'));
  });

  test('preserves whitespace in header/details', () => {
    const taskPacket = `Header with spaces

<!-- SPLIT: HEADER ABOVE, DETAILS BELOW -->

Details with spaces`;

    const result = splitTaskPacket(taskPacket);

    assert.equal(result.header, 'Header with spaces');
    assert.equal(result.details, 'Details with spaces');
  });
});

describe('isValidTaskPacket', () => {
  test('validates task packet with numbered section', () => {
    const text = '## 1. Objective\n\nImplement feature';
    assert.equal(isValidTaskPacket(text), true);
  });

  test('validates task packet with Objective header', () => {
    const text = '## Objective\n\nImplement feature';
    assert.equal(isValidTaskPacket(text), true);
  });

  test('validates task packet with Technical Context', () => {
    const text = '## Technical Context\n\nDetails';
    assert.equal(isValidTaskPacket(text), true);
  });

  test('validates task packet with Success Criteria', () => {
    const text = '## Success Criteria\n\n- Criterion 1';
    assert.equal(isValidTaskPacket(text), true);
  });

  test('validates task packet with Implementation', () => {
    const text = '## Implementation\n\nSteps';
    assert.equal(isValidTaskPacket(text), true);
  });

  test('rejects conversational text', () => {
    const text = 'Sure, I can help you with that. Let me explain...';
    assert.equal(isValidTaskPacket(text), false);
  });

  test('rejects empty string', () => {
    assert.equal(isValidTaskPacket(''), false);
  });

  test('is case-insensitive', () => {
    const text = '## objective\n\nImplement feature';
    assert.equal(isValidTaskPacket(text), true);
  });

  test('accepts "What" as valid section (alternative phrasing)', () => {
    const text = '## What\n\nBuild feature X';
    assert.equal(isValidTaskPacket(text), true);
  });
});

describe('isTaskPacketFile', () => {
  test('recognizes task-packet.md', () => {
    assert.equal(isTaskPacketFile('features/foo/task-packet.md'), true);
  });

  test('recognizes task-packet-header.md', () => {
    assert.equal(isTaskPacketFile('features/foo/task-packet-header.md'), true);
  });

  test('recognizes task-packet-details.md', () => {
    assert.equal(isTaskPacketFile('features/foo/task-packet-details.md'), true);
  });

  test('rejects README.md', () => {
    assert.equal(isTaskPacketFile('features/foo/README.md'), false);
  });

  test('rejects plan.md', () => {
    assert.equal(isTaskPacketFile('features/foo/plan.md'), false);
  });

  test('rejects non-markdown files', () => {
    assert.equal(isTaskPacketFile('task-packet.txt'), false);
  });

  test('handles paths without directory', () => {
    assert.equal(isTaskPacketFile('task-packet.md'), true);
  });
});

describe('isTaskPacketContent', () => {
  test('recognizes legacy section formats', () => {
    assert.equal(isTaskPacketContent('## 1. Objective\n\nBuild feature'), true);
    assert.equal(isTaskPacketContent('## Technical Context\n\nNotes'), true);
  });

  test('recognizes progressive-disclosure markers', () => {
    assert.equal(isTaskPacketContent('Quick Reference\n\n- Item'), true);
    assert.equal(isTaskPacketContent('## Detailed Sections\n\n## 1. Objective'), true);
  });

  test('returns false for raw issue text', () => {
    assert.equal(isTaskPacketContent('Fix failing webhook retries in staging'), false);
  });
});

describe('task packet artifact persistence', () => {
  test('derives conventional artifact paths from the full packet path', () => {
    const paths = getTaskPacketArtifactPaths('features/foo/task-packet.md');
    assert.deepEqual(paths, {
      full: 'features/foo/task-packet.md',
      header: 'features/foo/task-packet-header.md',
      details: 'features/foo/task-packet-details.md',
    });
  });

  test('writes full, header, and details files and creates parent directories', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-packet-utils-'));
    const outputFile = path.join(root, 'features', 'foo', 'task-packet.md');

    const artifactPaths = await writeTaskPacketArtifacts(outputFile, {
      header: '# Header',
      details: '## 1. Objective\n\nDetails',
      fullContent: '# Header\n\n---\n\n## 1. Objective\n\nDetails',
    });

    assert.equal(await fs.readFile(artifactPaths.header, 'utf-8'), '# Header');
    assert.equal(await fs.readFile(artifactPaths.details, 'utf-8'), '## 1. Objective\n\nDetails');
    assert.equal(await fs.readFile(artifactPaths.full, 'utf-8'), '# Header\n\n---\n\n## 1. Objective\n\nDetails');
    await fs.rm(root, { recursive: true, force: true });
  });
});

describe('extractReleaseReadiness', () => {
  test('extracts valid metadata with all fields populated', () => {
    const markdown = `## Some Section

Content here

## Release Readiness
- **database_change_risk**: required
- **env_changes**: NEW_API_KEY, FEATURE_FLAG_X
- **config_changes**: config/production.json
- **manual_steps**: Run migration script, Update CDN cache rules

## Next Section

More content`;

    const result = extractReleaseReadiness(markdown);

    assert.deepEqual(result, {
      databaseChangeRisk: 'required',
      envChanges: ['NEW_API_KEY', 'FEATURE_FLAG_X'],
      configChanges: ['config/production.json'],
      manualSteps: ['Run migration script', 'Update CDN cache rules'],
    });
  });

  test('returns null when section is absent', () => {
    const markdown = `## Objective

Build something

## Technical Context

Details`;

    assert.equal(extractReleaseReadiness(markdown), null);
  });

  test('returns null for partial heading match', () => {
    const markdown = `## Release

Some content`;

    assert.equal(extractReleaseReadiness(markdown), null);
  });

  test('returns null for empty string', () => {
    assert.equal(extractReleaseReadiness(''), null);
  });

  test('maps "none" list values to empty arrays', () => {
    const markdown = `## Release Readiness
- **database_change_risk**: none
- **env_changes**: none
- **config_changes**: none
- **manual_steps**: none`;

    const result = extractReleaseReadiness(markdown);

    assert.deepEqual(result, {
      databaseChangeRisk: 'none',
      envChanges: [],
      configChanges: [],
      manualSteps: [],
    });
  });

  test('handles single-item lists', () => {
    const markdown = `## Release Readiness
- **database_change_risk**: possible
- **env_changes**: API_KEY
- **config_changes**: none
- **manual_steps**: none`;

    const result = extractReleaseReadiness(markdown);

    assert.deepEqual(result, {
      databaseChangeRisk: 'possible',
      envChanges: ['API_KEY'],
      configChanges: [],
      manualSteps: [],
    });
  });

  test('defaults database_change_risk to none for invalid value', () => {
    const markdown = `## Release Readiness
- **database_change_risk**: maybe
- **env_changes**: none
- **config_changes**: none
- **manual_steps**: none`;

    const result = extractReleaseReadiness(markdown);

    assert.notEqual(result, null);
    assert.equal(result!.databaseChangeRisk, 'none');
  });

  test('trims whitespace from list items', () => {
    const markdown = `## Release Readiness
- **database_change_risk**: none
- **env_changes**:  FOO ,  BAR ,  BAZ
- **config_changes**: none
- **manual_steps**: none`;

    const result = extractReleaseReadiness(markdown);

    assert.deepEqual(result!.envChanges, ['FOO', 'BAR', 'BAZ']);
  });

  test('handles section at end of document', () => {
    const markdown = `## Objective

Build something

## Release Readiness
- **database_change_risk**: required
- **env_changes**: none
- **config_changes**: none
- **manual_steps**: none`;

    const result = extractReleaseReadiness(markdown);

    assert.notEqual(result, null);
    assert.equal(result!.databaseChangeRisk, 'required');
  });
});
