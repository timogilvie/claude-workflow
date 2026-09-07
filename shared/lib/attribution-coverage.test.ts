import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PrAttribution } from './pr-attribution.ts';
import {
  computeRepositoryReport,
  computeAggregates,
  DEFAULT_ATTRIBUTION_CONFIG,
  loadConfig,
} from './attribution-coverage.ts';

function makePrAttribution(
  number: number,
  overrides: Partial<PrAttribution> = {},
): PrAttribution {
  return {
    number,
    signals: [],
    agentAuthored: { value: 'unknown', confidence: null, conflict: false, evidence: [] },
    harness: { value: 'unknown', confidence: null, conflict: false, evidence: [] },
    model: { value: 'unknown', confidence: null, conflict: false, evidence: [] },
    ...overrides,
  };
}

describe('attribution-coverage module', () => {
  describe('loadConfig', () => {
    it('uses defaults when no config provided', () => {
      const config = loadConfig(undefined, 'owner/repo');

      assert.equal(config.minEligiblePrs, 20);
      assert.equal(config.modelCoverageFloor, 60);
      assert.equal(config.harnessCoverageFloor, 60);
      assert.deepEqual(config.disabledSignals, []);
    });

    it('merges file defaults and per-repo overrides', () => {
      const configFile = {
        defaults: { minEligiblePrs: 30 },
        repos: { 'owner/repo': { modelCoverageFloor: 50 } },
      };
      const config = loadConfig(configFile, 'owner/repo');

      assert.equal(config.minEligiblePrs, 30);
      assert.equal(config.modelCoverageFloor, 50);
      assert.equal(config.harnessCoverageFloor, 60); // from DEFAULT
    });

    it('rejects unknown default config keys', () => {
      const configFile = {
        defaults: { modelCoverageFLoor: 50 },
      };

      assert.throws(
        () => loadConfig(configFile, 'owner/repo'),
        /Unknown attribution config key "modelCoverageFLoor" in attribution config defaults/,
      );
    });

    it('rejects unknown top-level config keys', () => {
      const configFile = {
        default: { modelCoverageFloor: 50 },
      };

      assert.throws(
        () => loadConfig(configFile, 'owner/repo'),
        /Unknown attribution config key "default" in attribution config/,
      );
    });

    it('rejects unknown per-repo config keys', () => {
      const configFile = {
        repos: { 'owner/repo': { disabledSignal: ['botAuthor'] } },
      };

      assert.throws(
        () => loadConfig(configFile, 'owner/repo'),
        /Unknown attribution config key "disabledSignal" in attribution config repos\.owner\/repo/,
      );
    });
  });

  describe('computeRepositoryReport', () => {
    it('computes per-dimension coverage', () => {
      const prs = [
        makePrAttribution(1, {
          agentAuthored: { value: 'agent', confidence: 'strong', conflict: false, evidence: [] },
          harness: { value: 'claude-code', confidence: 'strong', conflict: false, evidence: [] },
          model: { value: 'claude-opus-5', confidence: 'strong', conflict: false, evidence: [] },
          signals: ['botAuthor'],
        }),
        makePrAttribution(2, {
          agentAuthored: { value: 'agent', confidence: 'strong', conflict: false, evidence: [] },
          harness: { value: 'unknown', confidence: null, conflict: false, evidence: [] },
          model: { value: 'unknown', confidence: null, conflict: false, evidence: [] },
          signals: ['botAuthor'],
        }),
        makePrAttribution(3),
      ];

      const report = computeRepositoryReport('owner/repo', prs, DEFAULT_ATTRIBUTION_CONFIG);

      assert.equal(report.repo, 'owner/repo');
      assert.equal(report.sampledMergedPrs, 3);
      assert.equal(report.dimensionCoverage.agentAuthored.attributed, 2);
      assert.equal(report.dimensionCoverage.agentAuthored.coverage, 66.7);
      assert.equal(report.dimensionCoverage.harness.attributed, 1);
      assert.equal(report.dimensionCoverage.harness.coverage, 33.3);
      assert.equal(report.dimensionCoverage.model.attributed, 1);
      assert.equal(report.dimensionCoverage.model.coverage, 33.3);
    });

    it('agentOrHarness union coverage', () => {
      const prs = [
        makePrAttribution(1, {
          agentAuthored: { value: 'agent', confidence: 'strong', conflict: false, evidence: [] },
          harness: { value: 'unknown', confidence: null, conflict: false, evidence: [] },
          signals: [],
        }),
        makePrAttribution(2, {
          agentAuthored: { value: 'unknown', confidence: null, conflict: false, evidence: [] },
          harness: { value: 'claude-code', confidence: 'strong', conflict: false, evidence: [] },
          signals: [],
        }),
        makePrAttribution(3),
      ];

      const report = computeRepositoryReport('owner/repo', prs, DEFAULT_ATTRIBUTION_CONFIG);

      // Both have either agentAuthored or harness attributed
      assert.equal(report.dimensionCoverage.agentOrHarness.attributed, 2);
      assert.equal(report.dimensionCoverage.agentOrHarness.coverage, 66.7);
    });

    it('eligible when sampledMergedPrs >= minEligiblePrs', () => {
      const prs = Array.from({ length: 20 }, (_, i) => makePrAttribution(i + 1));
      const report = computeRepositoryReport('owner/repo', prs, DEFAULT_ATTRIBUTION_CONFIG);

      assert.equal(report.eligible, true);
      assert.equal(report.eligibilityReason, 'meets_min_prs');
    });

    it('ineligible when sampledMergedPrs < minEligiblePrs', () => {
      const prs = Array.from({ length: 19 }, (_, i) => makePrAttribution(i + 1));
      const report = computeRepositoryReport('owner/repo', prs, DEFAULT_ATTRIBUTION_CONFIG);

      assert.equal(report.eligible, false);
      assert.equal(report.eligibilityReason, 'below_min_prs_20');
    });

    it('section gates suppress when ineligible', () => {
      const prs = Array.from({ length: 10 }, (_, i) => makePrAttribution(i + 1));
      const report = computeRepositoryReport('owner/repo', prs, DEFAULT_ATTRIBUTION_CONFIG);

      assert.equal(report.sections.survivalByModel.render, false);
      assert.equal(report.sections.survivalByModel.reason, 'ineligible_repo');
      assert.equal(report.sections.survivalByHarness.render, false);
    });

    it('model floor gate: 12/20 model coverage with floor 60 -> render', () => {
      const prs = [
        ...Array.from({ length: 12 }, (_, i) =>
          makePrAttribution(i + 1, {
            model: { value: 'claude-opus-5', confidence: 'strong', conflict: false, evidence: [] },
            signals: [],
          }),
        ),
        ...Array.from({ length: 8 }, (_, i) => makePrAttribution(i + 13)),
      ];

      const report = computeRepositoryReport('owner/repo', prs, DEFAULT_ATTRIBUTION_CONFIG);

      assert.equal(report.eligible, true);
      // 12/20 = 60% exactly, should meet floor of 60
      assert.equal(report.sections.survivalByModel.render, true);
      assert.equal(report.sections.survivalByModel.reason, 'floor_met');
    });

    it('model floor gate: 11/20 model coverage with floor 60 -> suppress', () => {
      const prs = [
        ...Array.from({ length: 11 }, (_, i) =>
          makePrAttribution(i + 1, {
            model: { value: 'claude-opus-5', confidence: 'strong', conflict: false, evidence: [] },
            signals: [],
          }),
        ),
        ...Array.from({ length: 9 }, (_, i) => makePrAttribution(i + 12)),
      ];

      const report = computeRepositoryReport('owner/repo', prs, DEFAULT_ATTRIBUTION_CONFIG);

      assert.equal(report.eligible, true);
      // 11/20 = 55% < 60%, should not meet floor
      assert.equal(report.sections.survivalByModel.render, false);
    });

    it('independent gates: model floor unmet but harness floor met', () => {
      const prs = [
        ...Array.from({ length: 11 }, (_, i) =>
          makePrAttribution(i + 1, {
            model: { value: 'claude-opus-5', confidence: 'strong', conflict: false, evidence: [] },
            harness: { value: 'claude-code', confidence: 'strong', conflict: false, evidence: [] },
            signals: [],
          }),
        ),
        ...Array.from({ length: 9 }, (_, i) =>
          makePrAttribution(i + 12, {
            harness: { value: 'github-copilot', confidence: 'strong', conflict: false, evidence: [] },
            signals: [],
          }),
        ),
      ];

      const report = computeRepositoryReport('owner/repo', prs, DEFAULT_ATTRIBUTION_CONFIG);

      // model: 11/20 = 55% < 60%
      assert.equal(report.sections.survivalByModel.render, false);
      // harness: 20/20 = 100% >= 60%
      assert.equal(report.sections.survivalByHarness.render, true);
    });

    it('counts signals correctly', () => {
      const prs = [
        makePrAttribution(1, { signals: ['botAuthor'] }),
        makePrAttribution(2, { signals: ['botAuthor', 'coAuthoredBy'] }),
        makePrAttribution(3, { signals: ['branchPrefix'] }),
        makePrAttribution(4, { signals: [] }),
      ];

      const report = computeRepositoryReport('owner/repo', prs, DEFAULT_ATTRIBUTION_CONFIG);

      assert.equal(report.signalCounts.botAuthor, 2);
      assert.equal(report.signalCounts.coAuthoredBy, 1);
      assert.equal(report.signalCounts.branchPrefix, 1);
      assert.equal(report.coverage.botAuthor, 50); // 2/4
      assert.equal(report.coverage.union, 75); // 3/4 (PRs with >= 1 signal)
      assert.equal(report.coverage.unattributed, 25); // 1/4
    });

    it('zero PR sample: 0% coverage, ineligible', () => {
      const prs: PrAttribution[] = [];
      const report = computeRepositoryReport('owner/repo', prs, DEFAULT_ATTRIBUTION_CONFIG);

      assert.equal(report.sampledMergedPrs, 0);
      assert.equal(report.eligible, false);
      assert.equal(report.dimensionCoverage.model.coverage, 0);
    });
  });

  describe('computeAggregates', () => {
    it('micro coverage: pooled over all repos', () => {
      const repos = [
        computeRepositoryReport(
          'owner/repo1',
          [
            makePrAttribution(1, {
              agentAuthored: { value: 'agent', confidence: 'strong', conflict: false, evidence: [] },
              signals: [],
            }),
            makePrAttribution(2),
          ],
          DEFAULT_ATTRIBUTION_CONFIG,
        ),
        computeRepositoryReport(
          'owner/repo2',
          [
            makePrAttribution(1, {
              agentAuthored: { value: 'agent', confidence: 'strong', conflict: false, evidence: [] },
            }),
            makePrAttribution(2, {
              agentAuthored: { value: 'agent', confidence: 'strong', conflict: false, evidence: [] },
            }),
          ],
          DEFAULT_ATTRIBUTION_CONFIG,
        ),
      ];

      const aggregate = computeAggregates(repos);

      // Micro: 3 attributed out of 4 total across both repos
      assert.equal(aggregate.micro.agentAuthored.total, 4);
      assert.equal(aggregate.micro.agentAuthored.attributed, 3);
      assert.equal(aggregate.micro.agentAuthored.coverage, 75);
    });

    it('macro coverage: unweighted mean of eligible repos', () => {
      const repo1 = computeRepositoryReport(
        'owner/repo1',
        Array.from({ length: 20 }, (_, i) =>
          makePrAttribution(i + 1, {
            agentAuthored: { value: 'agent', confidence: 'strong', conflict: false, evidence: [] },
            signals: [],
          }),
        ),
        DEFAULT_ATTRIBUTION_CONFIG,
      );
      const repo2 = computeRepositoryReport(
        'owner/repo2',
        [
          ...Array.from({ length: 10 }, (_, i) =>
            makePrAttribution(i + 1, {
              agentAuthored: { value: 'agent', confidence: 'strong', conflict: false, evidence: [] },
              signals: [],
            }),
          ),
          ...Array.from({ length: 10 }, (_, i) => makePrAttribution(i + 11)),
        ],
        DEFAULT_ATTRIBUTION_CONFIG,
      );

      const aggregate = computeAggregates([repo1, repo2]);

      // Both repos eligible (20 and 20 PRs)
      assert.equal(aggregate.macro.agentAuthored.total, 2);
      // repo1: 100% coverage, repo2: 50% coverage -> mean = 75%
      assert.equal(aggregate.macro.agentAuthored.coverage, 75);
    });

    it('feasibility gate: counts eligible repos clearing >=60% agent-or-harness', () => {
      const repos = [
        computeRepositoryReport(
          'owner/repo1',
          Array.from({ length: 20 }, (_, i) =>
            makePrAttribution(i + 1, {
              agentAuthored: { value: 'agent', confidence: 'strong', conflict: false, evidence: [] },
              signals: [],
            }),
          ),
          DEFAULT_ATTRIBUTION_CONFIG,
        ),
        computeRepositoryReport(
          'owner/repo2',
          [
            ...Array.from({ length: 10 }, (_, i) =>
              makePrAttribution(i + 1, {
                agentAuthored: { value: 'agent', confidence: 'strong', conflict: false, evidence: [] },
                signals: [],
              }),
            ),
            ...Array.from({ length: 10 }, (_, i) => makePrAttribution(i + 11)),
          ],
          DEFAULT_ATTRIBUTION_CONFIG,
        ),
        computeRepositoryReport(
          'owner/repo3',
          Array.from({ length: 10 }, (_, i) => makePrAttribution(i + 1)),
          DEFAULT_ATTRIBUTION_CONFIG,
        ),
      ];

      const aggregate = computeAggregates(repos);

      // repo1: 100%, repo2: 50%, repo3: ineligible
      assert.equal(aggregate.feasibility.totalRepos, 3);
      assert.equal(aggregate.feasibility.eligibleRepos, 2);
      assert.equal(aggregate.feasibility.agentOrHarnessGate.passed, 1);
      assert.equal(aggregate.feasibility.agentOrHarnessGate.total, 2);
    });

    it('precision without audit: audited=false', () => {
      const repos = [
        computeRepositoryReport(
          'owner/repo',
          Array.from({ length: 20 }, (_, i) => makePrAttribution(i + 1)),
          DEFAULT_ATTRIBUTION_CONFIG,
        ),
      ];

      const aggregate = computeAggregates(repos);

      assert.equal(aggregate.precision.audited, false);
      assert(!('agentAuthored' in aggregate.precision));
    });

    it('precision with audit data', () => {
      const repos = [
        computeRepositoryReport(
          'owner/repo',
          [
            makePrAttribution(1, {
              agentAuthored: { value: 'agent', confidence: 'strong', conflict: false, evidence: [] },
              harness: { value: 'claude-code', confidence: 'strong', conflict: false, evidence: [] },
              model: { value: 'claude-opus-5', confidence: 'strong', conflict: false, evidence: [] },
              signals: [],
            }),
            makePrAttribution(2, {
              agentAuthored: { value: 'unknown', confidence: null, conflict: false, evidence: [] },
              signals: [],
            }),
            makePrAttribution(3, {
              agentAuthored: { value: 'agent', confidence: 'weak', conflict: false, evidence: [] },
              harness: { value: 'github-copilot', confidence: 'weak', conflict: false, evidence: [] },
              model: { value: 'gpt-4.1', confidence: 'weak', conflict: false, evidence: [] },
              signals: [],
            }),
            makePrAttribution(4),
          ],
          DEFAULT_ATTRIBUTION_CONFIG,
        ),
      ];

      const auditData = {
        'owner/repo': {
          '1': { agentAuthored: true, harness: 'claude-code', model: 'claude-opus-5' },
          '2': { agentAuthored: false }, // correct abstention is not a precision denominator
          '3': { agentAuthored: false, harness: 'claude-code', model: 'claude-opus-5' },
        },
      };

      const aggregate = computeAggregates(repos, auditData);

      assert.equal(aggregate.precision.audited, true);
      // agentAuthored: PR #1 true positive, PR #3 false positive; PR #2 is an abstention
      assert.deepEqual(aggregate.precision.agentAuthored, { confirmed: 1, audited: 2 });
      // harness/model: PR #1 matches, PR #3 predicts the wrong value
      assert.deepEqual(aggregate.precision.harness, { confirmed: 1, audited: 2 });
      assert.deepEqual(aggregate.precision.model, { confirmed: 1, audited: 2 });
    });
  });
});
