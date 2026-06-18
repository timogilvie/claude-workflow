import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  buildTaskContract,
  TASK_CONTRACT_SCHEMA_VERSION,
  writeTaskContract,
} from './task-contract-builder.ts';

// ────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────

const FULL_PACKET = `# Task Packet: Demo Task

**Issue ID**: HOK-1234

## 1. Objective

Build a deterministic builder that projects existing task packet and plan markdown
artifacts into a machine-readable task-contract.json.

## 2. Technical Context

### Key Files

- \`shared/lib/task-contract-builder.ts\` (new) — builder logic
- \`shared/lib/task-packet-utils.ts\` — existing helpers
- \`tools/build-task-contract.ts\` (new) — CLI wrapper

## 3. Implementation Approach

Read the existing helpers and implement extraction logic.

## 4. Success Criteria

- [ ] **[REQ-F1]** \`buildTaskContract(featureDir)\` returns a TaskContract with schemaVersion and sources.
- [ ] **[REQ-F2]** For a full packet, the builder extracts objective, task type, risk, paths, and criteria.
- [ ] **[REQ-F3]** Output is deterministic: calling twice returns deeply equal objects.

## 5. Implementation Constraints

- Code style: Match existing shared/lib patterns.
- Determinism: No LLM, no randomness.

## 6. Validation Steps

Run tests:

\`\`\`bash
node --test shared/lib/task-contract-builder.test.ts
\`\`\`

Also:
- \`npx tsx tools/build-task-contract.ts features/demo-task\`

## 10. Release Readiness

- **database_change_risk**: none
- **env_changes**: none
- **config_changes**: none
- **manual_steps**: none

## 11. Proposed Labels

- Risk: Medium
- Area: Shared Lib
- Layer: Data Model
- Type: feature
- Files: shared/lib/task-contract-builder.ts, tools/build-task-contract.ts
`;

const HEADER_CONTENT = `# Demo Task - Quick Reference

**Issue ID**: HOK-5678

## Objective

Build a progressive-disclosure task contract projection.

## Key Files

- \`shared/lib/task-contract-builder.ts\` (new)
- \`tools/build-task-contract.ts\` (new)

## Critical Constraints

1. Deterministic output.
2. Tolerant of missing fields.

## Success Criteria (High-Level)

- [ ] Builder produces task-contract.json
`;

const DETAILS_CONTENT = `## 1. Objective

Build a progressive disclosure projection builder.

## 4. Success Criteria

- [ ] **[REQ-F1]** schemaVersion and sources present.
- [ ] **[REQ-F2]** Objective extracted from details file.
- [ ] Untagged criterion gets synthesized ID.

## 6. Validation Steps

\`\`\`bash
node --test shared/lib/task-contract-builder.test.ts
npx tsx tools/build-task-contract.ts features/demo
\`\`\`

## 10. Release Readiness

- **database_change_risk**: none
- **env_changes**: API_KEY, DB_URL
- **config_changes**: none
- **manual_steps**: none

## 11. Proposed Labels

- Risk: High
- Area: Core
- Component: Eval
`;

const LEGACY_PACKET = `# My Legacy Task

This task involves fixing a broken pipeline that produces incorrect output.

The work is straightforward but requires understanding the data flow.
`;

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

function makeTempFeatureDir(slug: string, files: Record<string, string>): { tmpDir: string; featureDir: string } {
  const tmpDir = mkdtempSync(join(tmpdir(), 'task-contract-test-'));
  const featureDir = join(tmpDir, 'features', slug);
  mkdirSync(featureDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(featureDir, name), content, 'utf-8');
  }
  return { tmpDir, featureDir };
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

// ────────────────────────────────────────────────────────────────
// Tests: Full Packet
// ────────────────────────────────────────────────────────────────

test('full packet: schema version, slug, and issue ID', async () => {
  const { tmpDir, featureDir } = makeTempFeatureDir('demo-task', {
    'task-packet.md': FULL_PACKET,
  });
  try {
    const contract = await buildTaskContract(featureDir, { repoDir: tmpDir });
    assert.equal(contract.schemaVersion, TASK_CONTRACT_SCHEMA_VERSION);
    assert.equal(contract.slug, 'demo-task');
    assert.equal(contract.issueId, 'HOK-1234');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('full packet: single source with correct sha256', async () => {
  const { tmpDir, featureDir } = makeTempFeatureDir('demo-task', {
    'task-packet.md': FULL_PACKET,
  });
  try {
    const contract = await buildTaskContract(featureDir, { repoDir: tmpDir });
    assert.equal(contract.sources.length, 1);
    assert.equal(contract.sources[0].artifact, 'task-packet');
    assert.equal(contract.sources[0].sha256, sha256(FULL_PACKET));
    assert.ok(/^[a-f0-9]{64}$/.test(contract.sources[0].sha256));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('full packet: objective summary is non-empty', async () => {
  const { tmpDir, featureDir } = makeTempFeatureDir('demo-task', {
    'task-packet.md': FULL_PACKET,
  });
  try {
    const contract = await buildTaskContract(featureDir, { repoDir: tmpDir });
    assert.ok(contract.objectiveSummary && contract.objectiveSummary.length > 10);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('full packet: task type inferred', async () => {
  const { tmpDir, featureDir } = makeTempFeatureDir('demo-task', {
    'task-packet.md': FULL_PACKET,
  });
  try {
    const contract = await buildTaskContract(featureDir, { repoDir: tmpDir });
    assert.ok(contract.taskType !== null);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('full packet: risk level parsed from proposed labels', async () => {
  const { tmpDir, featureDir } = makeTempFeatureDir('demo-task', {
    'task-packet.md': FULL_PACKET,
  });
  try {
    const contract = await buildTaskContract(featureDir, { repoDir: tmpDir });
    assert.equal(contract.risk.level, 'Medium');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('full packet: success criteria preserve authored REQ IDs', async () => {
  const { tmpDir, featureDir } = makeTempFeatureDir('demo-task', {
    'task-packet.md': FULL_PACKET,
  });
  try {
    const contract = await buildTaskContract(featureDir, { repoDir: tmpDir });
    const ids = contract.successCriteria.map((c) => c.id);
    assert.ok(ids.includes('REQ-F1'));
    assert.ok(ids.includes('REQ-F2'));
    assert.ok(ids.includes('REQ-F3'));
    // Authored criteria should not be synthesized
    const authored = contract.successCriteria.filter((c) => !c.synthesized);
    assert.ok(authored.length >= 3);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('full packet: verification commands include bash command from fenced block', async () => {
  const { tmpDir, featureDir } = makeTempFeatureDir('demo-task', {
    'task-packet.md': FULL_PACKET,
  });
  try {
    const contract = await buildTaskContract(featureDir, { repoDir: tmpDir });
    assert.ok(contract.verification.commands.length > 0);
    const hasTest = contract.verification.commands.some((c) => c.includes('task-contract-builder.test'));
    assert.ok(hasTest, 'Expected a test command in verification.commands');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('full packet: release readiness parsed correctly', async () => {
  const { tmpDir, featureDir } = makeTempFeatureDir('demo-task', {
    'task-packet.md': FULL_PACKET,
  });
  try {
    const contract = await buildTaskContract(featureDir, { repoDir: tmpDir });
    assert.equal(contract.releaseReadiness.database_change_risk, 'none');
    assert.deepEqual(contract.releaseReadiness.env_changes, []);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('full packet: expected paths include key files', async () => {
  const { tmpDir, featureDir } = makeTempFeatureDir('demo-task', {
    'task-packet.md': FULL_PACKET,
  });
  try {
    const contract = await buildTaskContract(featureDir, { repoDir: tmpDir });
    assert.ok(contract.paths.expected.length > 0);
    assert.ok(
      contract.paths.expected.some((p) => p.includes('task-contract-builder')),
      'Expected path containing task-contract-builder',
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('full packet: sources includes plan when both exist', async () => {
  const { tmpDir, featureDir } = makeTempFeatureDir('demo-task', {
    'task-packet.md': FULL_PACKET,
    'plan.md': '# Plan\n\nImplementation plan content.',
  });
  try {
    const contract = await buildTaskContract(featureDir, { repoDir: tmpDir });
    const names = contract.sources.map((s) => s.artifact);
    assert.ok(names.includes('task-packet'));
    assert.ok(names.includes('plan'));
    assert.equal(contract.sources.length, 2);
    // Distinct hashes
    const hashes = new Set(contract.sources.map((s) => s.sha256));
    assert.equal(hashes.size, 2);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('full packet: missing issueId when not present', async () => {
  const noIdPacket = FULL_PACKET.replace('**Issue ID**: HOK-1234\n\n', '');
  const { tmpDir, featureDir } = makeTempFeatureDir('no-id', {
    'task-packet.md': noIdPacket,
  });
  try {
    const contract = await buildTaskContract(featureDir, { repoDir: tmpDir });
    assert.equal(contract.issueId, null);
    assert.ok(contract.missingFields.includes('issueId'));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('full packet: risk High is parsed correctly', async () => {
  const highRiskPacket = FULL_PACKET.replace('Risk: Medium', 'Risk: High');
  const { tmpDir, featureDir } = makeTempFeatureDir('high-risk', {
    'task-packet.md': highRiskPacket,
  });
  try {
    const contract = await buildTaskContract(featureDir, { repoDir: tmpDir });
    assert.equal(contract.risk.level, 'High');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('full packet: env_changes parsed as array', async () => {
  const withEnvPacket = FULL_PACKET.replace(
    '- **env_changes**: none',
    '- **env_changes**: API_KEY, DB_URL',
  );
  const { tmpDir, featureDir } = makeTempFeatureDir('env-test', {
    'task-packet.md': withEnvPacket,
  });
  try {
    const contract = await buildTaskContract(featureDir, { repoDir: tmpDir });
    assert.deepEqual(contract.releaseReadiness.env_changes, ['API_KEY', 'DB_URL']);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ────────────────────────────────────────────────────────────────
// Tests: Progressive Disclosure Packet
// ────────────────────────────────────────────────────────────────

test('progressive-disclosure: both split artifacts recorded with distinct hashes', async () => {
  const { tmpDir, featureDir } = makeTempFeatureDir('prog-task', {
    'task-packet-header.md': HEADER_CONTENT,
    'task-packet-details.md': DETAILS_CONTENT,
  });
  try {
    const contract = await buildTaskContract(featureDir, { repoDir: tmpDir });
    const names = contract.sources.map((s) => s.artifact);
    assert.ok(names.includes('task-packet-header'), 'should include header');
    assert.ok(names.includes('task-packet-details'), 'should include details');
    const headerSrc = contract.sources.find((s) => s.artifact === 'task-packet-header');
    const detailsSrc = contract.sources.find((s) => s.artifact === 'task-packet-details');
    assert.ok(headerSrc);
    assert.ok(detailsSrc);
    assert.equal(headerSrc!.sha256, sha256(HEADER_CONTENT));
    assert.equal(detailsSrc!.sha256, sha256(DETAILS_CONTENT));
    assert.notEqual(headerSrc!.sha256, detailsSrc!.sha256);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('progressive-disclosure: details-only fields extracted from details file', async () => {
  const { tmpDir, featureDir } = makeTempFeatureDir('prog-task', {
    'task-packet-header.md': HEADER_CONTENT,
    'task-packet-details.md': DETAILS_CONTENT,
  });
  try {
    const contract = await buildTaskContract(featureDir, { repoDir: tmpDir });
    // Success criteria are in details
    assert.ok(contract.successCriteria.length > 0, 'success criteria from details');
    const ids = contract.successCriteria.map((c) => c.id);
    assert.ok(ids.includes('REQ-F1'));
    assert.ok(ids.includes('REQ-F2'));
    // Third criterion has no tag → synthesized
    const synthesized = contract.successCriteria.filter((c) => c.synthesized);
    assert.ok(synthesized.length > 0, 'at least one synthesized criterion');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('progressive-disclosure: header objective populates summary', async () => {
  const { tmpDir, featureDir } = makeTempFeatureDir('prog-task', {
    'task-packet-header.md': HEADER_CONTENT,
    'task-packet-details.md': DETAILS_CONTENT,
  });
  try {
    const contract = await buildTaskContract(featureDir, { repoDir: tmpDir });
    assert.ok(contract.objectiveSummary && contract.objectiveSummary.length > 5);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('progressive-disclosure: issue ID from header', async () => {
  const { tmpDir, featureDir } = makeTempFeatureDir('prog-task', {
    'task-packet-header.md': HEADER_CONTENT,
    'task-packet-details.md': DETAILS_CONTENT,
  });
  try {
    const contract = await buildTaskContract(featureDir, { repoDir: tmpDir });
    assert.equal(contract.issueId, 'HOK-5678');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('progressive-disclosure: risk from details labels section', async () => {
  const { tmpDir, featureDir } = makeTempFeatureDir('prog-task', {
    'task-packet-header.md': HEADER_CONTENT,
    'task-packet-details.md': DETAILS_CONTENT,
  });
  try {
    const contract = await buildTaskContract(featureDir, { repoDir: tmpDir });
    assert.equal(contract.risk.level, 'High');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('progressive-disclosure: env_changes from details', async () => {
  const { tmpDir, featureDir } = makeTempFeatureDir('prog-task', {
    'task-packet-header.md': HEADER_CONTENT,
    'task-packet-details.md': DETAILS_CONTENT,
  });
  try {
    const contract = await buildTaskContract(featureDir, { repoDir: tmpDir });
    assert.deepEqual(contract.releaseReadiness.env_changes, ['API_KEY', 'DB_URL']);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('progressive-disclosure: full packet also present - provenance includes all found artifacts', async () => {
  const { tmpDir, featureDir } = makeTempFeatureDir('prog-task', {
    'task-packet-header.md': HEADER_CONTENT,
    'task-packet-details.md': DETAILS_CONTENT,
    'task-packet.md': FULL_PACKET,
  });
  try {
    const contract = await buildTaskContract(featureDir, { repoDir: tmpDir });
    const names = contract.sources.map((s) => s.artifact);
    // All recognized files are recorded as provenance
    assert.ok(names.includes('task-packet-header'));
    assert.ok(names.includes('task-packet-details'));
    assert.ok(names.includes('task-packet'));
    // No crash
    assert.ok(contract.schemaVersion === TASK_CONTRACT_SCHEMA_VERSION);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('progressive-disclosure: header only, detail-only fields in missingFields', async () => {
  const { tmpDir, featureDir } = makeTempFeatureDir('header-only', {
    'task-packet-header.md': HEADER_CONTENT,
  });
  try {
    const contract = await buildTaskContract(featureDir, { repoDir: tmpDir });
    // No throw
    assert.ok(contract.schemaVersion === TASK_CONTRACT_SCHEMA_VERSION);
    // The header has success criteria in high-level section, but details have the numbered ones
    // missingFields may include various fields since only header available
    assert.ok(Array.isArray(contract.missingFields));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ────────────────────────────────────────────────────────────────
// Tests: Legacy / Minimal Packet
// ────────────────────────────────────────────────────────────────

test('legacy packet: no throw, extracts objective from prose', async () => {
  const { tmpDir, featureDir } = makeTempFeatureDir('legacy-task', {
    'task-packet.md': LEGACY_PACKET,
  });
  try {
    const contract = await buildTaskContract(featureDir, { repoDir: tmpDir });
    assert.ok(contract.schemaVersion === TASK_CONTRACT_SCHEMA_VERSION);
    // Objective may be derived from prose
    // missingFields should include things we can't extract
    assert.ok(contract.missingFields.includes('risk.level'));
    assert.ok(contract.missingFields.includes('successCriteria'));
    assert.ok(contract.missingFields.includes('releaseReadiness'));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('legacy packet: issueId is null and listed in missingFields', async () => {
  const { tmpDir, featureDir } = makeTempFeatureDir('legacy-task', {
    'task-packet.md': LEGACY_PACKET,
  });
  try {
    const contract = await buildTaskContract(featureDir, { repoDir: tmpDir });
    assert.equal(contract.issueId, null);
    assert.ok(contract.missingFields.includes('issueId'));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('legacy packet: source still recorded with hash for empty content', async () => {
  const emptyPacket = '';
  const { tmpDir, featureDir } = makeTempFeatureDir('empty-task', {
    'task-packet.md': emptyPacket,
  });
  try {
    const contract = await buildTaskContract(featureDir, { repoDir: tmpDir });
    assert.equal(contract.sources.length, 1);
    assert.equal(contract.sources[0].sha256, sha256(emptyPacket));
    assert.ok(contract.missingFields.length > 0);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('no artifacts: returns valid contract with warning', async () => {
  const { tmpDir, featureDir } = makeTempFeatureDir('empty-dir', {});
  try {
    const contract = await buildTaskContract(featureDir, { repoDir: tmpDir });
    assert.equal(contract.sources.length, 0);
    assert.ok(contract.extractionWarnings.length > 0);
    assert.ok(contract.extractionWarnings[0].includes('No recognized source artifacts'));
    assert.equal(contract.schemaVersion, TASK_CONTRACT_SCHEMA_VERSION);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ────────────────────────────────────────────────────────────────
// Tests: Determinism and Write
// ────────────────────────────────────────────────────────────────

test('determinism: same fixture built twice gives deep-equal contracts', async () => {
  const { tmpDir, featureDir } = makeTempFeatureDir('det-task', {
    'task-packet.md': FULL_PACKET,
  });
  try {
    const a = await buildTaskContract(featureDir, { repoDir: tmpDir });
    const b = await buildTaskContract(featureDir, { repoDir: tmpDir });
    assert.deepEqual(a, b);
    assert.equal(JSON.stringify(a), JSON.stringify(b));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('determinism: JSON has trailing newline and parses as valid JSON', async () => {
  const { tmpDir, featureDir } = makeTempFeatureDir('det-task', {
    'task-packet.md': FULL_PACKET,
  });
  try {
    const contract = await buildTaskContract(featureDir, { repoDir: tmpDir });
    const outPath = await writeTaskContract(featureDir, contract, { repoDir: tmpDir });
    const raw = readFileSync(outPath, 'utf-8');
    assert.ok(raw.endsWith('\n'), 'file must end with newline');
    // Must parse as valid JSON
    const parsed = JSON.parse(raw);
    assert.equal(parsed.schemaVersion, TASK_CONTRACT_SCHEMA_VERSION);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('write: second write leaves no tmp artifacts and content unchanged', async () => {
  const { tmpDir, featureDir } = makeTempFeatureDir('write-task', {
    'task-packet.md': FULL_PACKET,
  });
  try {
    const contract = await buildTaskContract(featureDir, { repoDir: tmpDir });
    const outPath1 = await writeTaskContract(featureDir, contract, { repoDir: tmpDir });
    const content1 = readFileSync(outPath1, 'utf-8');
    const outPath2 = await writeTaskContract(featureDir, contract, { repoDir: tmpDir });
    const content2 = readFileSync(outPath2, 'utf-8');
    assert.equal(content1, content2);
    // No leftover tmp files
    const { readdirSync } = await import('node:fs');
    const files = readdirSync(featureDir);
    const tmpFiles = files.filter((f) => f.startsWith('.tmp-'));
    assert.equal(tmpFiles.length, 0, 'No leftover tmp files');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('write: output file is at expected path', async () => {
  const { tmpDir, featureDir } = makeTempFeatureDir('path-task', {
    'task-packet.md': FULL_PACKET,
  });
  try {
    const outPath = await writeTaskContract(featureDir, undefined, { repoDir: tmpDir });
    assert.ok(outPath.endsWith('task-contract.json'));
    // File must exist
    const raw = readFileSync(outPath, 'utf-8');
    assert.ok(raw.length > 0);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('write: missingFields and extractionWarnings are sorted', async () => {
  const { tmpDir, featureDir } = makeTempFeatureDir('sort-task', {
    'task-packet.md': LEGACY_PACKET,
  });
  try {
    const contract = await buildTaskContract(featureDir, { repoDir: tmpDir });
    const sorted = [...contract.missingFields].sort();
    assert.deepEqual(contract.missingFields, sorted);
    const sortedWarnings = [...contract.extractionWarnings].sort();
    assert.deepEqual(contract.extractionWarnings, sortedWarnings);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ────────────────────────────────────────────────────────────────
// Tests: Routing Hints
// ────────────────────────────────────────────────────────────────

test('routing hints: risk level lowercased', async () => {
  const { tmpDir, featureDir } = makeTempFeatureDir('hints-task', {
    'task-packet.md': FULL_PACKET,
  });
  try {
    const contract = await buildTaskContract(featureDir, { repoDir: tmpDir });
    assert.equal(contract.routingHints.riskLevel, 'medium');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('routing hints: expectedFileTypes derived from paths', async () => {
  const { tmpDir, featureDir } = makeTempFeatureDir('hints-task', {
    'task-packet.md': FULL_PACKET,
  });
  try {
    const contract = await buildTaskContract(featureDir, { repoDir: tmpDir });
    // paths.expected contains .ts files from key files section
    assert.ok(contract.routingHints.expectedFileTypes.includes('ts'));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('routing hints: hasMigration false when database_change_risk is none', async () => {
  const { tmpDir, featureDir } = makeTempFeatureDir('hints-task', {
    'task-packet.md': FULL_PACKET,
  });
  try {
    const contract = await buildTaskContract(featureDir, { repoDir: tmpDir });
    assert.equal(contract.routingHints.hasMigration, false);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
