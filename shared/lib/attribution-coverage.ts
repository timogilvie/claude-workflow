import { type PrAttribution, type AttributionSignal } from './pr-attribution.ts';

export type AttributionConfidence = 'verified' | 'strong' | 'weak';

export interface DimensionCoverage {
  total: number; // total PRs in sample
  attributed: number; // PRs with non-unknown value
  coverage: number; // percentage (0-100)
}

export interface MacroDimensionCoverage {
  total: number; // eligible repos included in the mean
  coverage: number; // unweighted mean percentage across eligible repos
}

export interface SectionGate {
  render: boolean;
  reason: string;
}

export interface RepositoryAttributionReport {
  repo: string;
  sampledMergedPrs: number;
  signalCounts: Record<AttributionSignal | 'firstPartyRoute', number>;
  coverage: Record<AttributionSignal | 'firstPartyRoute' | 'union' | 'unattributed', number>;
  dimensionCoverage: {
    agentAuthored: DimensionCoverage;
    harness: DimensionCoverage;
    model: DimensionCoverage;
    agentOrHarness: DimensionCoverage; // union of agentAuthored and harness
  };
  eligible: boolean;
  eligibilityReason: string;
  sections: {
    survivalByModel: SectionGate;
    survivalByHarness: SectionGate;
  };
  pullRequests: PrAttribution[];
}

export interface AuditEntry {
  agentAuthored?: boolean;
  harness?: string;
  model?: string;
}

export interface AuditData {
  [repoSlug: string]: {
    [prNumber: string]: AuditEntry;
  };
}

export interface PrecisionMetrics {
  audited: boolean;
  agentAuthored?: { confirmed: number; audited: number };
  harness?: { confirmed: number; audited: number };
  model?: { confirmed: number; audited: number };
}

export interface MultiRepoAttributionReport {
  schemaVersion: 2;
  generatedAt: string;
  sampleLimit: number;
  detectorSignatures: Record<string, unknown>;
  config: Record<string, unknown>;
  repositories: RepositoryAttributionReport[];
  aggregate: {
    micro: {
      agentAuthored: DimensionCoverage;
      harness: DimensionCoverage;
      model: DimensionCoverage;
      agentOrHarness: DimensionCoverage;
    };
    macro: {
      agentAuthored: MacroDimensionCoverage;
      harness: MacroDimensionCoverage;
      model: MacroDimensionCoverage;
      agentOrHarness: MacroDimensionCoverage;
    };
    feasibility: {
      eligibleRepos: number;
      totalRepos: number;
      agentOrHarnessGate: { passed: number; total: number; percentage: number };
    };
    precision: PrecisionMetrics;
  };
}

export interface AttributionRepoConfig {
  minEligiblePrs?: number;
  modelCoverageFloor?: number;
  harnessCoverageFloor?: number;
  disabledSignals?: AttributionSignal[];
}

export interface AttributionConfigFile {
  defaults?: AttributionRepoConfig;
  repos?: Record<string, AttributionRepoConfig>;
}

export const DEFAULT_ATTRIBUTION_CONFIG: Required<AttributionRepoConfig> = {
  minEligiblePrs: 20,
  modelCoverageFloor: 60,
  harnessCoverageFloor: 60,
  disabledSignals: [],
};

function pct(count: number, denominator: number): number {
  if (denominator === 0) return 0;
  return Number(((count / denominator) * 100).toFixed(1));
}

export function loadConfig(
  configFile: AttributionConfigFile | undefined,
  repoSlug: string,
): Required<AttributionRepoConfig> {
  const defaults: Required<AttributionRepoConfig> = { ...DEFAULT_ATTRIBUTION_CONFIG, ...configFile?.defaults };
  const repoOverrides = configFile?.repos?.[repoSlug] || {};

  return {
    minEligiblePrs: repoOverrides.minEligiblePrs ?? defaults.minEligiblePrs,
    modelCoverageFloor: repoOverrides.modelCoverageFloor ?? defaults.modelCoverageFloor,
    harnessCoverageFloor: repoOverrides.harnessCoverageFloor ?? defaults.harnessCoverageFloor,
    disabledSignals: repoOverrides.disabledSignals ?? defaults.disabledSignals,
  };
}

function computeDimensionCoverage(
  prs: PrAttribution[],
  dimension: 'agentAuthored' | 'harness' | 'model',
): DimensionCoverage {
  const attributed = prs.filter((pr) => pr[dimension].value !== 'unknown').length;
  return {
    total: prs.length,
    attributed,
    coverage: pct(attributed, prs.length),
  };
}

function computeAgentOrHarnessCoverage(prs: PrAttribution[]): DimensionCoverage {
  const attributed = prs.filter(
    (pr) => pr.agentAuthored.value !== 'unknown' || pr.harness.value !== 'unknown',
  ).length;
  return {
    total: prs.length,
    attributed,
    coverage: pct(attributed, prs.length),
  };
}

function countSignals(prs: PrAttribution[]): Record<AttributionSignal | 'firstPartyRoute', number> {
  const counts: Record<AttributionSignal | 'firstPartyRoute', number> = {
    firstPartyRoute: 0,
    botAuthor: 0,
    coAuthoredBy: 0,
    branchPrefix: 0,
    label: 0,
    commitSignature: 0,
  };

  for (const pr of prs) {
    for (const signal of pr.signals) {
      counts[signal] += 1;
    }
  }

  return counts;
}

function checkSectionGates(
  config: Required<AttributionRepoConfig>,
  dimensionCoverage: {
    agentAuthored: DimensionCoverage;
    harness: DimensionCoverage;
    model: DimensionCoverage;
    agentOrHarness: DimensionCoverage;
  },
  eligible: boolean,
): {
  survivalByModel: SectionGate;
  survivalByHarness: SectionGate;
} {
  if (!eligible) {
    return {
      survivalByModel: { render: false, reason: 'ineligible_repo' },
      survivalByHarness: { render: false, reason: 'ineligible_repo' },
    };
  }

  // Use exact ratios for floor comparison (not the rounded display percentage)
  const modelRatio = dimensionCoverage.model.total > 0
    ? (dimensionCoverage.model.attributed / dimensionCoverage.model.total) * 100
    : 0;
  const modelFloorMet = modelRatio >= config.modelCoverageFloor;

  const harnessRatio = dimensionCoverage.harness.total > 0
    ? (dimensionCoverage.harness.attributed / dimensionCoverage.harness.total) * 100
    : 0;
  const harnessFloorMet = harnessRatio >= config.harnessCoverageFloor;

  return {
    survivalByModel: {
      render: modelFloorMet,
      reason: modelFloorMet ? 'floor_met' : `floor_not_met_${config.modelCoverageFloor}%`,
    },
    survivalByHarness: {
      render: harnessFloorMet,
      reason: harnessFloorMet ? 'floor_met' : `floor_not_met_${config.harnessCoverageFloor}%`,
    },
  };
}

export function computeRepositoryReport(
  repo: string,
  prs: PrAttribution[],
  config: Required<AttributionRepoConfig>,
): RepositoryAttributionReport {
  const signalCounts = countSignals(prs);
  const dimensionCoverage = {
    agentAuthored: computeDimensionCoverage(prs, 'agentAuthored'),
    harness: computeDimensionCoverage(prs, 'harness'),
    model: computeDimensionCoverage(prs, 'model'),
    agentOrHarness: computeAgentOrHarnessCoverage(prs),
  };

  const eligible = prs.length >= config.minEligiblePrs;
  const eligibilityReason = eligible ? 'meets_min_prs' : `below_min_prs_${config.minEligiblePrs}`;

  const sections = checkSectionGates(config, dimensionCoverage, eligible);

  const coverage: Record<AttributionSignal | 'firstPartyRoute' | 'union' | 'unattributed', number> = {
    firstPartyRoute: pct(signalCounts.firstPartyRoute, prs.length),
    botAuthor: pct(signalCounts.botAuthor, prs.length),
    coAuthoredBy: pct(signalCounts.coAuthoredBy, prs.length),
    branchPrefix: pct(signalCounts.branchPrefix, prs.length),
    label: pct(signalCounts.label, prs.length),
    commitSignature: pct(signalCounts.commitSignature, prs.length),
    union: pct(
      prs.filter((pr) => pr.signals.length > 0).length,
      prs.length,
    ),
    unattributed: pct(
      prs.filter((pr) => pr.signals.length === 0).length,
      prs.length,
    ),
  };

  return {
    repo,
    sampledMergedPrs: prs.length,
    signalCounts,
    coverage,
    dimensionCoverage,
    eligible,
    eligibilityReason,
    sections,
    pullRequests: prs,
  };
}

export function computeAggregates(
  repositories: RepositoryAttributionReport[],
  auditData?: AuditData,
): MultiRepoAttributionReport['aggregate'] {
  const allPrs = repositories.flatMap((r) => r.pullRequests);
  const eligibleRepos = repositories.filter((r) => r.eligible);

  // Micro: aggregated over all PRs
  const micro = {
    agentAuthored: computeDimensionCoverage(allPrs, 'agentAuthored'),
    harness: computeDimensionCoverage(allPrs, 'harness'),
    model: computeDimensionCoverage(allPrs, 'model'),
    agentOrHarness: computeAgentOrHarnessCoverage(allPrs),
  };

  // Macro: unweighted mean of eligible repos
  let macroAgentAuthoredCoverage = 0;
  let macroHarnessCoverage = 0;
  let macroModelCoverage = 0;
  let macroAgentOrHarnessCoverage = 0;

  for (const repo of eligibleRepos) {
    macroAgentAuthoredCoverage += repo.dimensionCoverage.agentAuthored.coverage;
    macroHarnessCoverage += repo.dimensionCoverage.harness.coverage;
    macroModelCoverage += repo.dimensionCoverage.model.coverage;
    macroAgentOrHarnessCoverage += repo.dimensionCoverage.agentOrHarness.coverage;
  }

  const eligibleRepoCount = eligibleRepos.length;
  const macro = {
    agentAuthored: {
      total: eligibleRepoCount,
      coverage: eligibleRepoCount > 0 ? Number((macroAgentAuthoredCoverage / eligibleRepoCount).toFixed(1)) : 0,
    },
    harness: {
      total: eligibleRepoCount,
      coverage: eligibleRepoCount > 0 ? Number((macroHarnessCoverage / eligibleRepoCount).toFixed(1)) : 0,
    },
    model: {
      total: eligibleRepoCount,
      coverage: eligibleRepoCount > 0 ? Number((macroModelCoverage / eligibleRepoCount).toFixed(1)) : 0,
    },
    agentOrHarness: {
      total: eligibleRepoCount,
      coverage: eligibleRepoCount > 0 ? Number((macroAgentOrHarnessCoverage / eligibleRepoCount).toFixed(1)) : 0,
    },
  };

  // Feasibility gate: how many eligible repos clear ≥60% agent-or-harness
  const agentOrHarnessGate = {
    passed: eligibleRepos.filter((r) => r.dimensionCoverage.agentOrHarness.coverage >= 60).length,
    total: eligibleRepos.length,
    percentage: eligibleRepos.length > 0
      ? pct(
          eligibleRepos.filter((r) => r.dimensionCoverage.agentOrHarness.coverage >= 60).length,
          eligibleRepos.length,
        )
      : 0,
  };

  // Precision: optional audit merge
  const precision: PrecisionMetrics = { audited: false };
  if (auditData) {
    precision.audited = true;

    // Precision is measured over audited non-unknown assertions only:
    // confirmed predictions / audited predictions. Audited negatives with an
    // unknown prediction are correct abstentions, not precision denominator.
    let agentAuthoredConfirmed = 0;
    let agentAuthoredAudited = 0;
    let harnessConfirmed = 0;
    let harnessAudited = 0;
    let modelConfirmed = 0;
    let modelAudited = 0;

    for (const repo of repositories) {
      const auditEntries = auditData[repo.repo] || {};
      for (const pr of repo.pullRequests) {
        const audit = auditEntries[String(pr.number)];
        if (!audit) continue;

        if ('agentAuthored' in audit) {
          if (pr.agentAuthored.value === 'agent') {
            agentAuthoredAudited += 1;
            if (audit.agentAuthored === true) {
              agentAuthoredConfirmed += 1;
            }
          }
        }

        if ('harness' in audit) {
          if (pr.harness.value !== 'unknown') {
            harnessAudited += 1;
            if (audit.harness && pr.harness.value === audit.harness) {
              harnessConfirmed += 1;
            }
          }
        }

        if ('model' in audit) {
          if (pr.model.value !== 'unknown') {
            modelAudited += 1;
            if (audit.model && pr.model.value === audit.model) {
              modelConfirmed += 1;
            }
          }
        }
      }
    }

    if (agentAuthoredAudited > 0) {
      precision.agentAuthored = { confirmed: agentAuthoredConfirmed, audited: agentAuthoredAudited };
    }
    if (harnessAudited > 0) {
      precision.harness = { confirmed: harnessConfirmed, audited: harnessAudited };
    }
    if (modelAudited > 0) {
      precision.model = { confirmed: modelConfirmed, audited: modelAudited };
    }
  }

  return {
    micro,
    macro,
    feasibility: {
      eligibleRepos: eligibleRepos.length,
      totalRepos: repositories.length,
      agentOrHarnessGate,
    },
    precision,
  };
}
