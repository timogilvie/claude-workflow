import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  TASK_CONTRACT_SCHEMA_VERSION,
  buildTaskContract,
  serializeTaskContract,
} from './task-contract.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(
  readFileSync(join(__dirname, '../schemas/task-contract.schema.json'), 'utf-8'),
);

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validate = ajv.compile(schema);

// ── Fixture helpers ────────────────────────────────────────────────────────

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'task-contract-test-'));
}

function writeFile(dir: string, name: string, content: string): void {
  writeFileSync(join(dir, name), content, 'utf-8');
}

const FULL_PACKET_MD = `# Full Task Packet

## 1. Objective

### What
Build a deterministic contract builder that projects task artifacts into structured JSON.

### Why
Downstream consumers need stable fields without reparsing markdown.

### Scope In
- A new shared library module in shared/lib/
- A JSON Schema in shared/schemas/
- Unit tests covering all packet formats

### Scope Out
- No changes to existing packet formats
- No LLM calls or network requests

---

## 2. Technical Context

Key files: shared/lib/task-contract.ts (new), tools/build-task-contract.ts (new)

---

## 4. Success Criteria

### Functional Requirements

- [ ] **[REQ-F1]** buildTaskContract returns a TaskContract with schemaVersion and sources
- [ ] **[REQ-F2]** Progressive-disclosure packet fields extracted from details file
- [ ] **[REQ-F3]** Legacy packet returns successfully with absent fields and warnings
- [x] **[REQ-F4]** Source hashes computed from raw file bytes

---

## 6. Validation Steps

\`\`\`bash
node --test shared/lib/task-contract.test.ts
npx tsc --noEmit
npm run test:unit
\`\`\`

1. Run targeted test: verify all assertions pass
2. Run type check: no type errors expected
3. Run full unit suite: no regressions

---

## Release Readiness

- **database_change_risk**: none
- **env_changes**: none
- **config_changes**: .wavemill-config.json
- **manual_steps**: none
`;

const SELECTED_TASK_JSON = JSON.stringify({
  taskId: 'HOK-9999',
  title: 'Test task',
  workflowType: 'feature',
  featureName: 'test-feature-slug',
  labels: ['tooling', 'eval'],
  selectedAt: '2026-06-18T00:00:00Z',
});

const HEADER_MD = `# Test Feature - Quick Reference

**Issue ID**: HOK-8888

## Objective

Build a contract builder from task packet artifacts.

## Key Files

- \`shared/lib/task-contract.ts\` (new)
- \`tools/build-task-contract.ts\` (new)

## Critical Constraints

1. Must be deterministic
2. Never throw on missing packets

## Success Criteria (High-Level)

- [ ] Builder produces task-contract.json
- [ ] Tests pass
`;

const DETAILS_MD = `## 1. Objective

### What
Build a deterministic contract builder that projects task artifacts into structured JSON, specifically for eval and router consumption.

### Scope In
- A pure builder module
- A JSON Schema

### Scope Out
- No workflow changes
- No LLM calls

## 4. Success Criteria

### Functional Requirements

- [ ] **[REQ-F1]** Builder returns TaskContract with schemaVersion
- [ ] **[REQ-F2]** Progressive-disclosure packet extraction works correctly

## 6. Validation Steps

\`\`\`bash
node --test shared/lib/task-contract.test.ts
\`\`\`

1. Run unit tests
2. Verify schema conformance

## Release Readiness

- **database_change_risk**: none
- **env_changes**: none
- **config_changes**: none
- **manual_steps**: none
`;

const LEGACY_PACKET_MD = `# My Feature

This is a minimal task description with no structured sections.
It just has a title and some prose, nothing else.
`;

// ── Schema validation helper ───────────────────────────────────────────────

function assertValidSchema(contract: unknown, label: string): void {
  const valid = validate(contract);
  assert.equal(valid, true, `${label} schema validation failed: ${JSON.stringify(validate.errors, null, 2)}`);
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('task-contract — schema version', () => {
  it('exports the expected schema version', () => {
    assert.equal(TASK_CONTRACT_SCHEMA_VERSION, '1.0.0');
  });
});

describe('task-contract — full packet [REQ-F1]', () => {
  let dir: string;

  it('setup', () => {
    dir = makeTempDir();
    writeFile(dir, 'task-packet.md', FULL_PACKET_MD);
    writeFile(dir, 'selected-task.json', SELECTED_TASK_JSON);
  });

  it('returns a contract with required top-level fields', () => {
    const { contract } = buildTaskContract({ featureDir: dir });
    assert.equal(contract.schemaVersion, '1.0.0');
    assert.equal(contract.issueId, 'HOK-9999');
    assert.equal(contract.slug, 'test-feature-slug');
    assert.ok(Array.isArray(contract.sources));
    assert.ok(Array.isArray(contract.warnings));
  });

  it('sources contains all candidate paths', () => {
    const { contract } = buildTaskContract({ featureDir: dir });
    const paths = contract.sources.map(s => s.path);
    assert.ok(paths.includes('selected-task.json'));
    assert.ok(paths.includes('task-packet.md'));
    assert.ok(paths.includes('task-packet-header.md'));
    assert.ok(paths.includes('task-packet-details.md'));
    assert.ok(paths.includes('plan.md'));
    assert.ok(paths.includes('.initial-route.json'));
    assert.ok(paths.includes('.post-expansion-route.json'));
  });

  it('extracts objective summary from task-packet.md', () => {
    const { contract } = buildTaskContract({ featureDir: dir });
    const obj = contract.fields.objectiveSummary;
    assert.equal(obj.present, true);
    assert.ok(typeof obj.value === 'string' && obj.value.length > 10);
    assert.ok(obj.value!.includes('deterministic contract builder'));
    assert.equal(obj.source, 'task-packet.md');
  });

  it('extracts task type from selected-task.json workflowType', () => {
    const { contract } = buildTaskContract({ featureDir: dir });
    const tt = contract.fields.taskType;
    assert.equal(tt.present, true);
    assert.equal(tt.value, 'feature');
    assert.equal(tt.source, 'selected-task.json');
  });

  it('extracts component labels from selected-task.json', () => {
    const { contract } = buildTaskContract({ featureDir: dir });
    const labels = contract.fields.componentLabels;
    assert.equal(labels.present, true);
    assert.deepEqual(labels.value, ['tooling', 'eval']);
    assert.equal(labels.source, 'selected-task.json');
  });

  it('extracts allowed paths from Scope In section', () => {
    const { contract } = buildTaskContract({ featureDir: dir });
    const allowed = contract.fields.allowedPaths;
    assert.equal(allowed.present, true);
    assert.ok(Array.isArray(allowed.value) && allowed.value.length > 0);
    assert.ok(allowed.value!.some(p => p.includes('shared/lib/')));
  });

  it('extracts out-of-scope notes', () => {
    const { contract } = buildTaskContract({ featureDir: dir });
    const oos = contract.fields.outOfScope;
    assert.equal(oos.present, true);
    assert.ok(Array.isArray(oos.value) && oos.value.length > 0);
    assert.ok(oos.value!.some(s => s.includes('packet format')));
  });

  it('extracts success criteria with stable IDs', () => {
    const { contract } = buildTaskContract({ featureDir: dir });
    const sc = contract.fields.successCriteria;
    assert.equal(sc.present, true);
    assert.ok(Array.isArray(sc.value) && sc.value!.length >= 3);
    const ids = sc.value!.map(c => c.id);
    assert.ok(ids.includes('REQ-F1'));
    assert.ok(ids.includes('REQ-F2'));
    assert.ok(ids.includes('REQ-F3'));
    // REQ-F4 was checked [x]
    const f4 = sc.value!.find(c => c.id === 'REQ-F4');
    assert.ok(f4 !== undefined);
    assert.equal(f4!.checked, true);
  });

  it('extracts verification commands from code blocks', () => {
    const { contract } = buildTaskContract({ featureDir: dir });
    const vc = contract.fields.verificationCommands;
    assert.equal(vc.present, true);
    assert.ok(Array.isArray(vc.value) && vc.value!.length >= 2);
    assert.ok(vc.value!.some(c => c.includes('node --test')));
    assert.ok(vc.value!.some(c => c.includes('npx tsc')));
  });

  it('extracts release readiness fields [REQ-F6]', () => {
    const { contract } = buildTaskContract({ featureDir: dir });
    const rr = contract.fields.releaseReadiness;
    assert.equal(rr.databaseChangeRisk.present, true);
    assert.equal(rr.databaseChangeRisk.value, 'none');
    assert.equal(rr.envChanges.present, true);
    assert.deepEqual(rr.envChanges.value, []);
    assert.equal(rr.configChanges.present, true);
    assert.deepEqual(rr.configChanges.value, ['.wavemill-config.json']);
    assert.equal(rr.manualSteps.present, true);
    assert.deepEqual(rr.manualSteps.value, []);
  });

  it('routing hints derive from extracted fields', () => {
    const { contract } = buildTaskContract({ featureDir: dir });
    const rh = contract.routingHints;
    assert.equal(rh.taskType, 'feature');
    assert.equal(rh.requiresTests, true);
    assert.ok(Array.isArray(rh.riskFlags));
    assert.ok(Array.isArray(rh.subsystems));
    assert.ok(Array.isArray(rh.expectedFileTypes));
  });

  it('validates against JSON Schema [REQ-F7]', () => {
    const { contract } = buildTaskContract({ featureDir: dir });
    assertValidSchema(contract, 'full packet');
  });

  it('cleanup', () => {
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('task-contract — progressive-disclosure packet [REQ-F2]', () => {
  let dir: string;

  it('setup', () => {
    dir = makeTempDir();
    writeFile(dir, 'task-packet-header.md', HEADER_MD);
    writeFile(dir, 'task-packet-details.md', DETAILS_MD);
    // No task-packet.md, no selected-task.json
  });

  it('builds successfully without full packet', () => {
    const { contract } = buildTaskContract({ featureDir: dir });
    assert.equal(contract.schemaVersion, '1.0.0');
    assert.ok(Array.isArray(contract.sources));
  });

  it('slug falls back to directory basename', () => {
    const { contract } = buildTaskContract({ featureDir: dir });
    // No selected-task.json so slug = basename of temp dir
    assert.ok(typeof contract.slug === 'string' && contract.slug.length > 0);
  });

  it('extracts objective from details file preferentially', () => {
    const { contract } = buildTaskContract({ featureDir: dir });
    const obj = contract.fields.objectiveSummary;
    assert.equal(obj.present, true);
    // Details has more specific objective text
    assert.ok(obj.value!.includes('deterministic contract builder'));
    assert.equal(obj.source, 'task-packet-details.md');
  });

  it('extracts success criteria from details with REQ-FX IDs', () => {
    const { contract } = buildTaskContract({ featureDir: dir });
    const sc = contract.fields.successCriteria;
    assert.equal(sc.present, true);
    const ids = sc.value!.map(c => c.id);
    assert.ok(ids.includes('REQ-F1'));
    assert.ok(ids.includes('REQ-F2'));
    assert.equal(sc.source, 'task-packet-details.md');
  });

  it('extracts verification commands from details', () => {
    const { contract } = buildTaskContract({ featureDir: dir });
    const vc = contract.fields.verificationCommands;
    assert.equal(vc.present, true);
    assert.equal(vc.source, 'task-packet-details.md');
  });

  it('source hash for task-packet-details.md is present and correct format', () => {
    const { contract } = buildTaskContract({ featureDir: dir });
    const detailsSrc = contract.sources.find(s => s.path === 'task-packet-details.md');
    assert.ok(detailsSrc !== undefined);
    assert.equal(detailsSrc!.exists, true);
    assert.ok(typeof detailsSrc!.sha256 === 'string');
    assert.match(detailsSrc!.sha256!, /^[a-f0-9]{64}$/);
  });

  it('validates against JSON Schema', () => {
    const { contract } = buildTaskContract({ featureDir: dir });
    assertValidSchema(contract, 'progressive-disclosure packet');
  });

  it('header-only: missing details yields absent details-only fields', () => {
    const headerOnlyDir = makeTempDir();
    writeFile(headerOnlyDir, 'task-packet-header.md', HEADER_MD);
    // No details file
    const { contract } = buildTaskContract({ featureDir: headerOnlyDir });
    const detailsSrc = contract.sources.find(s => s.path === 'task-packet-details.md');
    assert.equal(detailsSrc!.exists, false);
    assert.equal(detailsSrc!.sha256, null);
    // Schema still valid
    assertValidSchema(contract, 'header-only');
    rmSync(headerOnlyDir, { recursive: true, force: true });
  });

  it('cleanup', () => {
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('task-contract — legacy/minimal packet tolerance [REQ-F3]', () => {
  let dir: string;

  it('setup', () => {
    dir = makeTempDir();
    writeFile(dir, 'task-packet.md', LEGACY_PACKET_MD);
  });

  it('does not throw', () => {
    assert.doesNotThrow(() => buildTaskContract({ featureDir: dir }));
  });

  it('returns valid contract object', () => {
    const { contract } = buildTaskContract({ featureDir: dir });
    assert.equal(contract.schemaVersion, '1.0.0');
    assert.ok(Array.isArray(contract.sources));
    assert.ok(Array.isArray(contract.warnings));
  });

  it('most fields are absent with present:false', () => {
    const { contract } = buildTaskContract({ featureDir: dir });
    const f = contract.fields;
    assert.equal(f.successCriteria.present, false);
    assert.equal(f.successCriteria.value, null);
    assert.equal(f.verificationCommands.present, false);
    assert.equal(f.releaseReadiness.databaseChangeRisk.present, false);
    assert.equal(f.allowedPaths.present, false);
    assert.equal(f.outOfScope.present, false);
  });

  it('warnings list contains missing field entries', () => {
    const { warnings } = buildTaskContract({ featureDir: dir });
    assert.ok(warnings.length > 0, 'should produce warnings for minimal packet');
    assert.ok(warnings.some(w => w.includes('successCriteria')));
    assert.ok(warnings.some(w => w.includes('verificationCommands')));
    assert.ok(warnings.some(w => w.includes('releaseReadiness.databaseChangeRisk')));
  });

  it('empty feature directory: no files exist', () => {
    const emptyDir = makeTempDir();
    const { contract } = buildTaskContract({ featureDir: emptyDir });
    // All sources absent
    for (const src of contract.sources) {
      assert.equal(src.exists, false);
      assert.equal(src.sha256, null);
    }
    // All fields absent
    assert.equal(contract.fields.objectiveSummary.present, false);
    assert.equal(contract.fields.successCriteria.present, false);
    assertValidSchema(contract, 'empty directory');
    rmSync(emptyDir, { recursive: true, force: true });
  });

  it('validates against JSON Schema', () => {
    const { contract } = buildTaskContract({ featureDir: dir });
    assertValidSchema(contract, 'legacy packet');
  });

  it('cleanup', () => {
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('task-contract — source hashing [REQ-F4]', () => {
  let dir: string;
  const packetContent = 'Content for hashing test\n';

  it('setup', () => {
    dir = makeTempDir();
    writeFile(dir, 'task-packet.md', packetContent);
  });

  it('sha256 is lowercase hex 64 chars for existing file', () => {
    const { contract } = buildTaskContract({ featureDir: dir });
    const src = contract.sources.find(s => s.path === 'task-packet.md');
    assert.ok(src !== undefined);
    assert.equal(src!.exists, true);
    assert.ok(typeof src!.sha256 === 'string');
    assert.match(src!.sha256!, /^[a-f0-9]{64}$/);
  });

  it('sha256 is null and exists:false for missing file', () => {
    const { contract } = buildTaskContract({ featureDir: dir });
    const src = contract.sources.find(s => s.path === 'plan.md');
    assert.ok(src !== undefined);
    assert.equal(src!.exists, false);
    assert.equal(src!.sha256, null);
  });

  it('same content yields same hash (deterministic)', () => {
    const dir2 = makeTempDir();
    writeFile(dir2, 'task-packet.md', packetContent);
    const { contract: c1 } = buildTaskContract({ featureDir: dir });
    const { contract: c2 } = buildTaskContract({ featureDir: dir2 });
    const hash1 = c1.sources.find(s => s.path === 'task-packet.md')!.sha256;
    const hash2 = c2.sources.find(s => s.path === 'task-packet.md')!.sha256;
    assert.equal(hash1, hash2);
    rmSync(dir2, { recursive: true, force: true });
  });

  it('different content yields different hash', () => {
    const dir3 = makeTempDir();
    writeFile(dir3, 'task-packet.md', 'Different content\n');
    const { contract: c1 } = buildTaskContract({ featureDir: dir });
    const { contract: c3 } = buildTaskContract({ featureDir: dir3 });
    const hash1 = c1.sources.find(s => s.path === 'task-packet.md')!.sha256;
    const hash3 = c3.sources.find(s => s.path === 'task-packet.md')!.sha256;
    assert.notEqual(hash1, hash3);
    rmSync(dir3, { recursive: true, force: true });
  });

  it('cleanup', () => {
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('task-contract — deterministic serialization [REQ-F5]', () => {
  let dir: string;

  it('setup', () => {
    dir = makeTempDir();
    writeFile(dir, 'task-packet.md', FULL_PACKET_MD);
    writeFile(dir, 'selected-task.json', SELECTED_TASK_JSON);
  });

  it('two builds of the same inputs produce byte-identical output', () => {
    const r1 = buildTaskContract({ featureDir: dir });
    const r2 = buildTaskContract({ featureDir: dir });
    const s1 = serializeTaskContract(r1.contract);
    const s2 = serializeTaskContract(r2.contract);
    assert.equal(s1, s2);
  });

  it('serialized output ends with a newline', () => {
    const { contract } = buildTaskContract({ featureDir: dir });
    const serialized = serializeTaskContract(contract);
    assert.ok(serialized.endsWith('\n'));
  });

  it('serialized output contains no absolute paths', () => {
    const { contract } = buildTaskContract({ featureDir: dir });
    const serialized = serializeTaskContract(contract);
    // Should not contain the actual absolute path of the temp dir
    assert.ok(!serialized.includes(dir));
  });

  it('object keys are sorted alphabetically', () => {
    const { contract } = buildTaskContract({ featureDir: dir });
    const serialized = serializeTaskContract(contract);
    const parsed = JSON.parse(serialized) as Record<string, unknown>;
    const topKeys = Object.keys(parsed);
    const sortedKeys = [...topKeys].sort();
    assert.deepEqual(topKeys, sortedKeys);
  });

  it('same content at different absolute paths produces identical output', () => {
    const dir2 = makeTempDir();
    writeFile(dir2, 'task-packet.md', FULL_PACKET_MD);
    writeFile(dir2, 'selected-task.json', SELECTED_TASK_JSON);
    const r1 = buildTaskContract({ featureDir: dir });
    const r2 = buildTaskContract({ featureDir: dir2 });
    // Source hashes are computed from file bytes, so identical content at
    // different absolute paths must produce identical hashes.
    const hash1 = r1.contract.sources.find(s => s.path === 'task-packet.md')!.sha256;
    const hash2 = r2.contract.sources.find(s => s.path === 'task-packet.md')!.sha256;
    assert.equal(hash1, hash2, 'same content should produce same hash regardless of dir');
    // Non-hash fields should also be identical (issueId, slug, fields)
    assert.equal(r1.contract.issueId, r2.contract.issueId);
    assert.equal(r1.contract.slug, r2.contract.slug);
    rmSync(dir2, { recursive: true, force: true });
  });

  it('cleanup', () => {
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('task-contract — release-readiness extraction [REQ-F6]', () => {
  it('extracts all four fields when Release Readiness section present', () => {
    const dir = makeTempDir();
    writeFile(dir, 'task-packet.md', `# Task

## Objective

Do the thing.

## Release Readiness

- **database_change_risk**: possible
- **env_changes**: API_KEY, FEATURE_FLAG
- **config_changes**: .wavemill-config.json
- **manual_steps**: none
`);
    const { contract } = buildTaskContract({ featureDir: dir });
    const rr = contract.fields.releaseReadiness;
    assert.equal(rr.databaseChangeRisk.value, 'possible');
    assert.deepEqual(rr.envChanges.value, ['API_KEY', 'FEATURE_FLAG']);
    assert.deepEqual(rr.configChanges.value, ['.wavemill-config.json']);
    assert.deepEqual(rr.manualSteps.value, []);
    rmSync(dir, { recursive: true, force: true });
  });

  it('env_changes: none normalizes to empty array', () => {
    const dir = makeTempDir();
    writeFile(dir, 'task-packet.md', `## Release Readiness

- **database_change_risk**: none
- **env_changes**: none
- **config_changes**: none
- **manual_steps**: none
`);
    const { contract } = buildTaskContract({ featureDir: dir });
    const rr = contract.fields.releaseReadiness;
    assert.deepEqual(rr.envChanges.value, []);
    assert.deepEqual(rr.configChanges.value, []);
    assert.deepEqual(rr.manualSteps.value, []);
    rmSync(dir, { recursive: true, force: true });
  });

  it('missing Release Readiness section yields present:false on all sub-fields', () => {
    const dir = makeTempDir();
    writeFile(dir, 'task-packet.md', '# Minimal\n\nJust a title.\n');
    const { contract } = buildTaskContract({ featureDir: dir });
    const rr = contract.fields.releaseReadiness;
    assert.equal(rr.databaseChangeRisk.present, false);
    assert.equal(rr.envChanges.present, false);
    assert.equal(rr.configChanges.present, false);
    assert.equal(rr.manualSteps.present, false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('task-contract — route artifact routing hints', () => {
  it('includes route artifact summary when route files are present', () => {
    const dir = makeTempDir();
    writeFile(dir, 'task-packet.md', '# Task\n## Objective\n\nDo something.\n');
    writeFile(dir, '.post-expansion-route.json', JSON.stringify({
      coder: 'claude-sonnet-4-6',
      codeDepth: 'medium',
      reviewer: 'claude-sonnet-4-6',
      reviewMode: 'static',
      harnessId: 'a'.repeat(64),
      signals: { taskType: 'feature', riskScore: 0.2 },
    }));
    const { contract } = buildTaskContract({ featureDir: dir });
    assert.ok(contract.routingHints.routeArtifacts !== null);
    assert.ok(contract.routingHints.routeArtifacts!.postExpansion !== null);
    const pe = contract.routingHints.routeArtifacts!.postExpansion!;
    assert.equal((pe as { coder?: string }).coder, 'claude-sonnet-4-6');
    assert.equal((pe as { harnessId?: string }).harnessId, 'a'.repeat(64));
    // Route artifacts should not contain absolute paths
    const serialized = serializeTaskContract(contract);
    assert.ok(!serialized.includes(dir));
    rmSync(dir, { recursive: true, force: true });
  });

  it('task type from route signals when not in selected-task.json', () => {
    const dir = makeTempDir();
    writeFile(dir, 'task-packet.md', '# Task\n## Objective\n\nDo something.\n');
    writeFile(dir, '.post-expansion-route.json', JSON.stringify({
      coder: 'claude-sonnet-4-6',
      codeDepth: 'medium',
      reviewer: 'claude-sonnet-4-6',
      reviewMode: 'static',
      signals: { taskType: 'bugfix' },
    }));
    const { contract } = buildTaskContract({ featureDir: dir });
    assert.equal(contract.fields.taskType.present, true);
    assert.equal(contract.fields.taskType.value, 'bugfix');
    assert.equal(contract.fields.taskType.source, '.post-expansion-route.json');
    rmSync(dir, { recursive: true, force: true });
  });

  it('routeArtifacts null when no route files present', () => {
    const dir = makeTempDir();
    writeFile(dir, 'task-packet.md', '# Task\n');
    const { contract } = buildTaskContract({ featureDir: dir });
    assert.equal(contract.routingHints.routeArtifacts, null);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('task-contract — success criteria ID stability', () => {
  it('synthesizes SC-001 IDs for items without explicit IDs', () => {
    const dir = makeTempDir();
    writeFile(dir, 'task-packet.md', `# Task

## Success Criteria

- [ ] First criterion no explicit ID
- [ ] Second criterion also no ID
- [ ] **[REQ-F3]** Third with explicit ID
`);
    const { contract } = buildTaskContract({ featureDir: dir });
    const sc = contract.fields.successCriteria;
    assert.equal(sc.present, true);
    assert.equal(sc.value![0].id, 'SC-001');
    assert.equal(sc.value![1].id, 'SC-002');
    assert.equal(sc.value![2].id, 'REQ-F3');
    rmSync(dir, { recursive: true, force: true });
  });

  it('marks checked items correctly', () => {
    const dir = makeTempDir();
    writeFile(dir, 'task-packet.md', `# Task

## Success Criteria

- [x] Done item
- [ ] Not done item
`);
    const { contract } = buildTaskContract({ featureDir: dir });
    const sc = contract.fields.successCriteria;
    assert.equal(sc.value![0].checked, true);
    assert.equal(sc.value![1].checked, false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('numbers SC-XXX only among unnamed items, regardless of position', () => {
    const dir = makeTempDir();
    writeFile(dir, 'task-packet.md', `# Task

## Success Criteria

- [ ] **[REQ-F1]** Tagged item first
- [ ] First unnamed item
- [ ] **[REQ-F2]** Another tagged item
- [ ] Second unnamed item
`);
    const { contract } = buildTaskContract({ featureDir: dir });
    const sc = contract.fields.successCriteria;
    assert.equal(sc.present, true);
    assert.equal(sc.value![0].id, 'REQ-F1');
    assert.equal(sc.value![1].id, 'SC-001');
    assert.equal(sc.value![2].id, 'REQ-F2');
    assert.equal(sc.value![3].id, 'SC-002');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('task-contract — slug resolution', () => {
  it('uses slug override when provided', () => {
    const dir = makeTempDir();
    writeFile(dir, 'selected-task.json', JSON.stringify({ taskId: 'HOK-1', featureName: 'from-json' }));
    const { contract } = buildTaskContract({ featureDir: dir, slug: 'my-override-slug' });
    assert.equal(contract.slug, 'my-override-slug');
    rmSync(dir, { recursive: true, force: true });
  });

  it('falls back to directory basename when no selected-task.json', () => {
    const dir = makeTempDir();
    writeFile(dir, 'task-packet.md', '# Task\n');
    const { contract } = buildTaskContract({ featureDir: dir });
    assert.ok(typeof contract.slug === 'string');
    assert.ok(contract.slug!.startsWith('task-contract-test-'));
    rmSync(dir, { recursive: true, force: true });
  });
});
