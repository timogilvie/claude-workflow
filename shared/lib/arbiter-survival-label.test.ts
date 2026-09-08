/**
 * Contract test for the Arbiter S2 survival label (HOK-2803).
 *
 * Pattern follows HOK-2499 and task-contract.test.ts: the producer's output
 * and the consumer's expectations both validate against the single JSON Schema
 * at shared/schemas/arbiter-survival-label.schema.json, so drift on either
 * side fails here rather than silently corrupting training data.
 *
 * The checked-in fixture pair in arbiter-survival-label.fixtures.json is the
 * lingua franca the Hokusai/hokusai-data-pipeline repo copies into its own
 * consumer tests.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  ARBITER_SURVIVAL_LABEL_SCHEMA_VERSION,
  HORIZONS,
  MISSING_REASON_CODES,
  REASON_CODES,
  SUBSTANTIAL_REWRITE_THRESHOLD,
  buildArbiterSurvivalLabel,
  canonicalHash,
  canonicalSerialize,
  deriveReportOutcome,
  type ArbiterSurvivalLabelV1,
  type LineRange,
  type ReproducibilityEnvelope,
  type SurvivalOutcome,
} from './arbiter-survival-label.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, '../schemas/arbiter-survival-label.schema.json');
const FIXTURES_PATH = join(__dirname, 'arbiter-survival-label.fixtures.json');

const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf-8')) as Record<string, unknown>;

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validate = ajv.compile(schema);

// ── Fixture builders ───────────────────────────────────────────────────────

const SHA_PR_HEAD = 'a'.repeat(40);
const SHA_BASE = 'b'.repeat(40);
const SHA_MERGE = 'c'.repeat(40);
const SHA_TERMINAL = 'd'.repeat(40);

function makeEnvelope(overrides: Partial<ReproducibilityEnvelope> = {}): ReproducibilityEnvelope {
  return {
    schema_version: ARBITER_SURVIVAL_LABEL_SCHEMA_VERSION,
    labeller_version: '0.1.0',
    normalization_version: '1.0.0',
    pr_head_sha: SHA_PR_HEAD,
    merge_sha: SHA_MERGE,
    horizon_terminal_sha: SHA_TERMINAL,
    integration_branch: 'auto/integration',
    computed_at: '2026-09-08T00:00:00Z',
    ...overrides,
  };
}

function makeLineRanges(): LineRange[] {
  return [
    {
      path: 'src/module.ts',
      old: { start: 10, end: 24, sha: SHA_BASE },
      new: { start: 10, end: 30, sha: SHA_PR_HEAD },
    },
    {
      // pure addition: no pre-change coordinates
      path: 'src/new-file.ts',
      old: null,
      new: { start: 1, end: 42, sha: SHA_PR_HEAD },
    },
  ];
}

function makeLabel(
  outcome: SurvivalOutcome,
  overrides: Partial<ArbiterSurvivalLabelV1> = {},
): ArbiterSurvivalLabelV1 {
  return {
    schema_version: '1.0.0',
    prUrl: 'https://github.com/example-org/example-repo/pull/123',
    horizon_days: 30,
    label_provenance: 'harvested',
    line_ranges: makeLineRanges(),
    outcome,
    envelope: makeEnvelope(),
    ...overrides,
  };
}

const survivedLabel = makeLabel({
  survived: true,
  survival_ratio: 1.0,
  reverted: false,
  undone_by: null,
  followup: false,
  report_outcome: 'survived',
  reason_codes: ['no_evidence'],
});

const revertedLabel = makeLabel({
  survived: false,
  survival_ratio: 0.0,
  reverted: true,
  undone_by: 'human',
  followup: false,
  report_outcome: 'reverted',
  reason_codes: ['exact_revert'],
});

const lineRangeFollowupLabel = makeLabel({
  survived: false,
  survival_ratio: 0.8,
  reverted: false,
  undone_by: 'agent',
  followup: true,
  report_outcome: 'followup',
  reason_codes: ['line_range_followup', 'linked_issue_or_pr'],
});

const preMergeHumanEditLabel = makeLabel({
  survived: false,
  survival_ratio: 0.9,
  reverted: false,
  undone_by: 'human',
  followup: true,
  report_outcome: 'followup',
  reason_codes: ['pre_merge_human_edit'],
});

const substantiallyRewrittenLabel = makeLabel({
  survived: false,
  survival_ratio: 0.3,
  reverted: false,
  undone_by: 'agent',
  followup: true,
  report_outcome: 'substantially_rewritten',
  reason_codes: ['substantial_rewrite', 'line_range_followup'],
});

const missingLabel = makeLabel(
  {
    survived: null,
    survival_ratio: null,
    reverted: null,
    undone_by: null,
    followup: null,
    report_outcome: null,
    reason_codes: ['unmerged_pr'],
  },
  { line_ranges: [] },
);

const ownerCorrectedLabel = makeLabel(
  {
    survived: false,
    survival_ratio: 0.6,
    reverted: false,
    undone_by: 'human',
    followup: true,
    report_outcome: 'followup',
    reason_codes: ['line_range_followup'],
  },
  {
    label_provenance: 'owner_corrected',
    envelope: makeEnvelope({ computed_at: '2026-09-09T12:00:00Z' }),
    owner_correction: {
      supersedes: {
        schema_version: survivedLabel.schema_version,
        computed_at: survivedLabel.envelope.computed_at,
        label_hash: canonicalHash(survivedLabel),
      },
      correction: {
        reason_code: 'owner_dispute',
        corrected_by: 'owner:example',
        corrected_at: '2026-09-09T12:00:00Z',
        previous_report_outcome: 'survived',
        note: 'Follow-up PR #130 rewrote the labelled ranges; harvested label missed it.',
      },
    },
  },
);

function assertValid(label: unknown, name: string): void {
  const ok = validate(label);
  assert.equal(ok, true, `${name} should validate: ${JSON.stringify(validate.errors, null, 2)}`);
}

function assertInvalid(label: unknown, name: string): void {
  const ok = validate(label);
  assert.equal(ok, false, `${name} should FAIL validation but passed`);
}

// clone + apply a mutation; keeps negative fixtures independent
function mutate(
  base: ArbiterSurvivalLabelV1,
  fn: (draft: ArbiterSurvivalLabelV1) => void,
): unknown {
  const draft = structuredClone(base);
  fn(draft);
  return draft;
}

// ── 1. Schema self-validity ────────────────────────────────────────────────

describe('survival-label — schema', () => {
  it('compiles under Ajv 2020-12', () => {
    assert.equal(typeof validate, 'function');
  });

  it('schema const version matches the exported constant', () => {
    const props = (schema as { properties: Record<string, { const?: string }> }).properties;
    assert.equal(props.schema_version.const, ARBITER_SURVIVAL_LABEL_SCHEMA_VERSION);
  });

  it('schema reason-code enum matches REASON_CODES exactly', () => {
    const defs = (schema as { $defs: Record<string, { enum?: string[] }> }).$defs;
    assert.deepEqual(defs.reasonCode.enum, [...REASON_CODES]);
    assert.deepEqual(defs.missingReasonCode.enum, [...MISSING_REASON_CODES]);
  });
});

// ── 2. Positive producer fixtures ──────────────────────────────────────────

describe('survival-label — positive producer fixtures', () => {
  const positives: Array<[string, ArbiterSurvivalLabelV1]> = [
    ['survived', survivedLabel],
    ['reverted', revertedLabel],
    ['line-range followup', lineRangeFollowupLabel],
    ['pre-merge human edit followup', preMergeHumanEditLabel],
    ['substantially rewritten', substantiallyRewrittenLabel],
    ['missing (unmerged_pr)', missingLabel],
    ['owner corrected', ownerCorrectedLabel],
  ];

  for (const [name, label] of positives) {
    it(`${name} label validates`, () => {
      assertValid(label, name);
    });

    it(`${name} label keeps envelope.schema_version equal to top-level schema_version`, () => {
      assert.equal(label.envelope.schema_version, label.schema_version);
    });
  }

  it('every horizon in HORIZONS validates', () => {
    for (const horizon of HORIZONS) {
      assertValid(
        mutate(survivedLabel, d => {
          d.horizon_days = horizon;
        }),
        `horizon ${horizon}`,
      );
    }
  });

  it('each missing reason code validates as the sole code of a missing label', () => {
    for (const code of MISSING_REASON_CODES) {
      assertValid(
        mutate(missingLabel, d => {
          d.outcome.reason_codes = [code];
        }),
        `missing label with ${code}`,
      );
    }
  });
});

// ── 3. Negative producer fixtures ──────────────────────────────────────────

describe('survival-label — negative producer fixtures', () => {
  it('rejects missing schema_version', () => {
    assertInvalid(
      mutate(survivedLabel, d => {
        delete (d as Partial<ArbiterSurvivalLabelV1>).schema_version;
      }),
      'missing schema_version',
    );
  });

  it('rejects horizon_days outside the 14/30/60 enum', () => {
    assertInvalid(
      mutate(survivedLabel, d => {
        (d as { horizon_days: number }).horizon_days = 21;
      }),
      'horizon_days=21',
    );
  });

  it("rejects report_outcome='reverted' with outcome.reverted=false", () => {
    assertInvalid(
      mutate(revertedLabel, d => {
        d.outcome.reverted = false;
      }),
      'reverted outcome inconsistency',
    );
  });

  it("rejects label_provenance='owner_corrected' without owner_correction", () => {
    assertInvalid(
      mutate(ownerCorrectedLabel, d => {
        delete d.owner_correction;
      }),
      'owner_corrected without owner_correction',
    );
  });

  it("rejects label_provenance='harvested' with owner_correction present", () => {
    assertInvalid(
      mutate(ownerCorrectedLabel, d => {
        d.label_provenance = 'harvested';
      }),
      'harvested with owner_correction',
    );
  });

  it('rejects a line range with both old and new null', () => {
    assertInvalid(
      mutate(survivedLabel, d => {
        d.line_ranges[0] = { path: 'src/module.ts', old: null, new: null };
      }),
      'empty line range',
    );
  });

  it('rejects survival_ratio above 1', () => {
    assertInvalid(
      mutate(survivedLabel, d => {
        d.outcome.survival_ratio = 1.2;
      }),
      'survival_ratio=1.2',
    );
  });

  it('rejects survival_ratio below 0', () => {
    assertInvalid(
      mutate(survivedLabel, d => {
        d.outcome.survival_ratio = -0.1;
      }),
      'survival_ratio=-0.1',
    );
  });

  it('rejects empty reason_codes', () => {
    assertInvalid(
      mutate(survivedLabel, d => {
        d.outcome.reason_codes = [];
      }),
      'empty reason_codes',
    );
  });

  it("rejects envelope.integration_branch='main' (squash-promotion guard)", () => {
    assertInvalid(
      mutate(survivedLabel, d => {
        d.envelope.integration_branch = 'main';
      }),
      'integration_branch=main',
    );
  });

  it('rejects a free-form reason code (typed codes only)', () => {
    assertInvalid(
      mutate(survivedLabel, d => {
        (d.outcome.reason_codes as unknown as string[]) = ['looked fine to me'];
      }),
      'free-form reason',
    );
  });

  it('rejects a missing label whose components are not all null', () => {
    assertInvalid(
      mutate(missingLabel, d => {
        d.outcome.reverted = false;
      }),
      'partial missing label',
    );
  });

  it('rejects a missing label with more than one reason code', () => {
    assertInvalid(
      mutate(missingLabel, d => {
        d.outcome.reason_codes = ['unmerged_pr', 'missing_horizon'];
      }),
      'missing label with two codes',
    );
  });

  it('rejects a missing label with a non-missing reason code', () => {
    assertInvalid(
      mutate(missingLabel, d => {
        d.outcome.reason_codes = ['no_evidence'];
      }),
      'missing label with no_evidence',
    );
  });

  it('rejects a terminal label with a null component (missing never imputed the other way)', () => {
    assertInvalid(
      mutate(survivedLabel, d => {
        d.outcome.survival_ratio = null;
      }),
      'terminal outcome with null ratio',
    );
  });

  it('rejects unknown top-level properties', () => {
    assertInvalid(
      mutate(survivedLabel, d => {
        (d as Record<string, unknown>).reason = 'free-form legacy field';
      }),
      'legacy free-form reason field',
    );
  });

  it('rejects undone_by outside human/agent/null', () => {
    assertInvalid(
      mutate(revertedLabel, d => {
        (d.outcome as { undone_by: string }).undone_by = 'unknown';
      }),
      'undone_by=unknown',
    );
  });

  it('rejects non-UTC computed_at', () => {
    assertInvalid(
      mutate(survivedLabel, d => {
        d.envelope.computed_at = '2026-09-08T00:00:00+02:00';
      }),
      'offset timestamp',
    );
  });

  it('rejects abbreviated merge_sha', () => {
    assertInvalid(
      mutate(survivedLabel, d => {
        d.envelope.merge_sha = 'c'.repeat(7);
      }),
      'short sha',
    );
  });
});

// ── 4. deriveReportOutcome precedence ──────────────────────────────────────

describe('survival-label — deriveReportOutcome precedence', () => {
  const cases: Array<{
    name: string;
    inputs: Parameters<typeof deriveReportOutcome>[0];
    expected: ReturnType<typeof deriveReportOutcome>;
  }> = [
    {
      name: 'null survived → null',
      inputs: { survived: null, survival_ratio: 1, reverted: false, followup: false },
      expected: null,
    },
    {
      name: 'null survival_ratio → null',
      inputs: { survived: true, survival_ratio: null, reverted: false, followup: false },
      expected: null,
    },
    {
      name: 'null reverted → null',
      inputs: { survived: true, survival_ratio: 1, reverted: null, followup: false },
      expected: null,
    },
    {
      name: 'null followup → null',
      inputs: { survived: true, survival_ratio: 1, reverted: false, followup: null },
      expected: null,
    },
    {
      name: 'null beats a reverted=true signal',
      inputs: { survived: null, survival_ratio: 0, reverted: true, followup: true },
      expected: null,
    },
    {
      name: 'reverted beats followup',
      inputs: { survived: false, survival_ratio: 0, reverted: true, followup: true },
      expected: 'reverted',
    },
    {
      name: 'reverted beats substantial rewrite',
      inputs: { survived: false, survival_ratio: 0.1, reverted: true, followup: false },
      expected: 'reverted',
    },
    {
      name: 'substantial rewrite beats followup',
      inputs: { survived: false, survival_ratio: 0.49, reverted: false, followup: true },
      expected: 'substantially_rewritten',
    },
    {
      name: 'ratio exactly at threshold is NOT substantial (strict <)',
      inputs: {
        survived: true,
        survival_ratio: SUBSTANTIAL_REWRITE_THRESHOLD,
        reverted: false,
        followup: false,
      },
      expected: 'survived',
    },
    {
      name: 'followup beats survived',
      inputs: { survived: false, survival_ratio: 0.9, reverted: false, followup: true },
      expected: 'followup',
    },
    {
      name: 'clean survival',
      inputs: { survived: true, survival_ratio: 1, reverted: false, followup: false },
      expected: 'survived',
    },
  ];

  for (const { name, inputs, expected } of cases) {
    it(name, () => {
      assert.equal(deriveReportOutcome(inputs), expected);
    });
  }

  it('honours a caller-supplied historical threshold', () => {
    const inputs = { survived: false, survival_ratio: 0.4, reverted: false, followup: true };
    assert.equal(deriveReportOutcome(inputs, 0.3), 'followup');
    assert.equal(deriveReportOutcome(inputs, 0.45), 'substantially_rewritten');
  });
});

// ── buildArbiterSurvivalLabel ──────────────────────────────────────────────

describe('survival-label — buildArbiterSurvivalLabel', () => {
  it('stamps schema versions and derives report_outcome, producing a schema-valid label', () => {
    const built = buildArbiterSurvivalLabel({
      prUrl: 'https://gitlab.example.com/group/project/-/merge_requests/9',
      horizon_days: 14,
      label_provenance: 'harvested',
      line_ranges: makeLineRanges(),
      outcome: {
        survived: false,
        survival_ratio: 0.2,
        reverted: false,
        undone_by: 'agent',
        followup: true,
        reason_codes: ['substantial_rewrite'],
      },
      envelope: {
        labeller_version: '0.1.0',
        normalization_version: '1.0.0',
        pr_head_sha: SHA_PR_HEAD,
        merge_sha: SHA_MERGE,
        horizon_terminal_sha: SHA_TERMINAL,
        integration_branch: 'auto/integration',
        computed_at: '2026-09-08T10:30:00Z',
      },
    });
    assert.equal(built.schema_version, ARBITER_SURVIVAL_LABEL_SCHEMA_VERSION);
    assert.equal(built.envelope.schema_version, ARBITER_SURVIVAL_LABEL_SCHEMA_VERSION);
    assert.equal(built.outcome.report_outcome, 'substantially_rewritten');
    assertValid(built, 'built label');
  });

  it('derives a missing outcome from null components and omits owner_correction', () => {
    const built = buildArbiterSurvivalLabel({
      prUrl: 'https://github.com/example-org/example-repo/pull/999',
      horizon_days: 60,
      label_provenance: 'harvested',
      line_ranges: [],
      outcome: {
        survived: null,
        survival_ratio: null,
        reverted: null,
        undone_by: null,
        followup: null,
        reason_codes: ['missing_horizon'],
      },
      envelope: {
        labeller_version: '0.1.0',
        normalization_version: '1.0.0',
        pr_head_sha: SHA_PR_HEAD,
        merge_sha: SHA_MERGE,
        horizon_terminal_sha: SHA_TERMINAL,
        integration_branch: 'auto/integration',
        computed_at: '2026-09-08T10:30:00Z',
      },
    });
    assert.equal(built.outcome.report_outcome, null);
    assert.ok(!('owner_correction' in built));
    assertValid(built, 'built missing label');
  });
});

// ── 5. canonicalHash determinism ───────────────────────────────────────────

// rebuild an object with keys inserted in reverse-sorted order at every depth
function reverseKeyOrder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeyOrder);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort().reverse()) {
      out[key] = reverseKeyOrder((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

describe('survival-label — canonicalHash', () => {
  it('is insensitive to key insertion order at every depth', () => {
    const reordered = reverseKeyOrder(survivedLabel) as ArbiterSurvivalLabelV1;
    assert.notEqual(JSON.stringify(reordered), JSON.stringify(survivedLabel));
    assert.equal(canonicalHash(reordered), canonicalHash(survivedLabel));
    assert.equal(canonicalSerialize(reordered), canonicalSerialize(survivedLabel));
  });

  it('changes when any field changes', () => {
    const tweaked = structuredClone(survivedLabel);
    tweaked.outcome.survival_ratio = 0.999;
    assert.notEqual(canonicalHash(tweaked), canonicalHash(survivedLabel));
  });

  it('is a lowercase 64-char hex digest', () => {
    assert.match(canonicalHash(survivedLabel), /^[a-f0-9]{64}$/);
  });

  it('is stable across repeated computation', () => {
    assert.equal(canonicalHash(survivedLabel), canonicalHash(structuredClone(survivedLabel)));
  });
});

// ── 6. Consumer-drift fixture ──────────────────────────────────────────────

/**
 * Every field the hokusai-data-pipeline ingest reads, as dotted paths from the
 * label root. Hand-maintained: when the pipeline starts reading a new field,
 * add it here; this test then fails until the schema marks it required (or the
 * schema side fails when it drops a field the pipeline still reads).
 */
const CONSUMER_REQUIRED_FIELDS: readonly string[] = [
  'schema_version',
  'prUrl',
  'horizon_days',
  'label_provenance',
  'line_ranges',
  'outcome',
  'outcome.survived',
  'outcome.survival_ratio',
  'outcome.reverted',
  'outcome.undone_by',
  'outcome.followup',
  'outcome.report_outcome',
  'outcome.reason_codes',
  'envelope',
  'envelope.schema_version',
  'envelope.labeller_version',
  'envelope.normalization_version',
  'envelope.pr_head_sha',
  'envelope.merge_sha',
  'envelope.horizon_terminal_sha',
  'envelope.integration_branch',
  'envelope.computed_at',
];

type SchemaNode = {
  $ref?: string;
  required?: string[];
  properties?: Record<string, SchemaNode>;
};

function deref(node: SchemaNode): SchemaNode {
  if (node.$ref !== undefined) {
    const parts = node.$ref.replace(/^#\//, '').split('/');
    let cur: unknown = schema;
    for (const part of parts) {
      cur = (cur as Record<string, unknown>)[part];
      assert.ok(cur !== undefined, `unresolvable $ref ${node.$ref}`);
    }
    return deref(cur as SchemaNode);
  }
  return node;
}

describe('survival-label — consumer drift guard (HOK-2499 pattern)', () => {
  for (const path of CONSUMER_REQUIRED_FIELDS) {
    it(`schema requires consumer-read field '${path}'`, () => {
      const segments = path.split('.');
      let node = deref(schema as SchemaNode);
      for (const segment of segments) {
        assert.ok(
          Array.isArray(node.required) && node.required.includes(segment),
          `'${segment}' (of '${path}') is not required in the schema — the pipeline reads it; ` +
            'either mark it required or update the pipeline before removing it',
        );
        const child = node.properties?.[segment];
        assert.ok(child !== undefined, `'${segment}' (of '${path}') missing from schema properties`);
        node = deref(child);
      }
    });
  }

  it('consumer field list contains no unknown schema paths (typo guard)', () => {
    // The loop above already fails on unknown paths; this documents the intent
    // and keeps at least one aggregate assertion if the list is ever emptied.
    assert.ok(CONSUMER_REQUIRED_FIELDS.length >= 20);
  });
});

// ── 7. Round-trip fixture pair ─────────────────────────────────────────────

describe('survival-label — checked-in round-trip fixture pair', () => {
  const fixtures = JSON.parse(readFileSync(FIXTURES_PATH, 'utf-8')) as {
    harvested: ArbiterSurvivalLabelV1;
    owner_corrected: ArbiterSurvivalLabelV1;
  };

  it('harvested fixture validates', () => {
    assertValid(fixtures.harvested, 'fixture harvested');
    assert.equal(fixtures.harvested.label_provenance, 'harvested');
  });

  it('owner_corrected fixture validates', () => {
    assertValid(fixtures.owner_corrected, 'fixture owner_corrected');
    assert.equal(fixtures.owner_corrected.label_provenance, 'owner_corrected');
  });

  it('correction supersedes the harvested row by canonical hash', () => {
    assert.equal(
      fixtures.owner_corrected.owner_correction?.supersedes.label_hash,
      canonicalHash(fixtures.harvested),
      'supersedes.label_hash must equal canonicalHash(harvested) — the pipeline joins on it',
    );
  });

  it('correction preserves the harvested identity (same prUrl and horizon)', () => {
    assert.equal(fixtures.owner_corrected.prUrl, fixtures.harvested.prUrl);
    assert.equal(fixtures.owner_corrected.horizon_days, fixtures.harvested.horizon_days);
    assert.equal(
      fixtures.owner_corrected.owner_correction?.supersedes.computed_at,
      fixtures.harvested.envelope.computed_at,
    );
    assert.equal(
      fixtures.owner_corrected.owner_correction?.correction.previous_report_outcome,
      fixtures.harvested.outcome.report_outcome,
    );
  });

  it('correction is a later row, never a mutation of the harvested one', () => {
    assert.ok(
      fixtures.owner_corrected.envelope.computed_at > fixtures.harvested.envelope.computed_at,
      'owner_corrected.computed_at must be later so latest-wins queries pick it',
    );
  });
});
