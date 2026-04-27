import type { ChallengeComparison } from './challenge-comparison.ts';
import type { EvalRecord } from './eval-schema.ts';

export interface JoinedChallengeRecord {
  comparison: ChallengeComparison;
  primaryEval?: EvalRecord;
  challengerEval?: EvalRecord;
}

export interface ModelStats {
  wins: number;
  total: number;
  winRate: number;
}

export interface RoleStats {
  [model: string]: ModelStats;
}

export interface StageQuality {
  winnerAvg: number;
  loserAvg: number;
  delta: number;
  count: number;
}

export interface CostStats {
  winnerAvg: number;
  loserAvg: number;
  count: number;
}

export interface AggregatedStats {
  totalComparisons: number;
  overallWinRates: Map<string, ModelStats>;
  winRatesByRole: {
    planner: RoleStats;
    coder: RoleStats;
    reviewer: RoleStats;
  };
  winRatesByChallengeType: Map<string, ModelStats>;
  winRatesByDepth: Map<string, ModelStats>;
  winRatesByResourceVariant: {
    router: Map<string, ModelStats>;
    planner: Map<string, ModelStats>;
    reviewer: Map<string, ModelStats>;
  };
  stageQuality: {
    expansion?: StageQuality;
    plan?: StageQuality;
    implementation?: StageQuality;
    review?: StageQuality;
  };
  costEfficiency?: CostStats;
}

function variantFromEval(record: EvalRecord | undefined, surface: 'router' | 'planner' | 'reviewer'): string {
  return record?.resourceSelections?.find((selection) => selection.surface === surface)?.variant || '';
}

/**
 * Join challenge comparison records with their matching eval records.
 */
export function joinRecords(
  comparisons: ChallengeComparison[],
  evals: EvalRecord[],
): JoinedChallengeRecord[] {
  return comparisons.map((comparison) => {
    const primaryEval = evals.find(
      (e) => e.challengePairId === comparison.challengePairId && e.prUrl === comparison.primaryPrUrl
    );
    const challengerEval = evals.find(
      (e) => e.challengePairId === comparison.challengePairId && e.prUrl === comparison.challengerPrUrl
    );
    return { comparison, primaryEval, challengerEval };
  });
}

/**
 * Increment wins and totals for a model entry.
 */
export function incrementModelStat(map: Map<string, ModelStats>, model: string, isWin: boolean): void {
  const stats = map.get(model) || { wins: 0, total: 0, winRate: 0 };
  stats.total++;
  if (isWin) stats.wins++;
  stats.winRate = stats.total > 0 ? stats.wins / stats.total : 0;
  map.set(model, stats);
}

/**
 * Compute aggregate win-rate, quality, and cost statistics for challenge comparisons.
 */
export function computeAggregations(joined: JoinedChallengeRecord[]): AggregatedStats {
  const stats: AggregatedStats = {
    totalComparisons: joined.length,
    overallWinRates: new Map(),
    winRatesByRole: {
      planner: {},
      coder: {},
      reviewer: {},
    },
    winRatesByChallengeType: new Map(),
    winRatesByDepth: new Map(),
    winRatesByResourceVariant: {
      router: new Map(),
      planner: new Map(),
      reviewer: new Map(),
    },
    stageQuality: {},
  };

  const stageScores: {
    [stage: string]: { winner: number[]; loser: number[] };
  } = {
    expansion: { winner: [], loser: [] },
    plan: { winner: [], loser: [] },
    implementation: { winner: [], loser: [] },
    review: { winner: [], loser: [] },
  };

  const costs: { winner: number[]; loser: number[] } = { winner: [], loser: [] };

  for (const record of joined) {
    const { comparison, primaryEval, challengerEval } = record;
    const { winner, primaryModel, challengerModel, primaryRouting, challengerRouting, challengeType } = comparison;

    incrementModelStat(stats.overallWinRates, primaryModel, winner === 'primary');
    incrementModelStat(stats.overallWinRates, challengerModel, winner === 'challenger');

    if (primaryRouting && challengerRouting) {
      const roles = ['planner', 'coder', 'reviewer'] as const;
      for (const role of roles) {
        const primaryRoleModel = primaryRouting[role];
        const challengerRoleModel = challengerRouting[role];
        if (primaryRoleModel) {
          const key = primaryRoleModel;
          const stat = stats.winRatesByRole[role][key] || { wins: 0, total: 0, winRate: 0 };
          stat.total++;
          if (winner === 'primary') stat.wins++;
          stat.winRate = stat.total > 0 ? stat.wins / stat.total : 0;
          stats.winRatesByRole[role][key] = stat;
        }
        if (challengerRoleModel) {
          const key = challengerRoleModel;
          const stat = stats.winRatesByRole[role][key] || { wins: 0, total: 0, winRate: 0 };
          stat.total++;
          if (winner === 'challenger') stat.wins++;
          stat.winRate = stat.total > 0 ? stat.wins / stat.total : 0;
          stats.winRatesByRole[role][key] = stat;
        }
      }
    }

    if (challengeType) {
      const challengeTypeStats = stats.winRatesByChallengeType.get(challengeType) || { wins: 0, total: 0, winRate: 0 };
      challengeTypeStats.total++;
      stats.winRatesByChallengeType.set(challengeType, challengeTypeStats);
    }

    if (primaryRouting && challengerRouting) {
      const primaryDepth = `${primaryRouting.planDepth}×${primaryRouting.codeDepth}`;
      const challengerDepth = `${challengerRouting.planDepth}×${challengerRouting.codeDepth}`;
      incrementModelStat(stats.winRatesByDepth, primaryDepth, winner === 'primary');
      incrementModelStat(stats.winRatesByDepth, challengerDepth, winner === 'challenger');

      const variantBuckets: Array<['router' | 'planner' | 'reviewer', string, string]> = [
        [
          'router',
          primaryRouting.routerVariant || variantFromEval(primaryEval, 'router'),
          challengerRouting.routerVariant || variantFromEval(challengerEval, 'router'),
        ],
        [
          'planner',
          primaryRouting.plannerPromptVariant || variantFromEval(primaryEval, 'planner'),
          challengerRouting.plannerPromptVariant || variantFromEval(challengerEval, 'planner'),
        ],
        [
          'reviewer',
          primaryRouting.reviewerPromptVariant || variantFromEval(primaryEval, 'reviewer'),
          challengerRouting.reviewerPromptVariant || variantFromEval(challengerEval, 'reviewer'),
        ],
      ];
      for (const [surface, primaryVariant, challengerVariant] of variantBuckets) {
        if (primaryVariant) {
          incrementModelStat(stats.winRatesByResourceVariant[surface], primaryVariant, winner === 'primary');
        }
        if (challengerVariant) {
          incrementModelStat(stats.winRatesByResourceVariant[surface], challengerVariant, winner === 'challenger');
        }
      }
    }

    if (primaryEval?.stageOutcomes && challengerEval?.stageOutcomes) {
      const winnerEval = winner === 'primary' ? primaryEval : challengerEval;
      const loserEval = winner === 'primary' ? challengerEval : primaryEval;

      const stages = ['expansion', 'plan', 'implementation', 'review'] as const;
      for (const stage of stages) {
        const winnerScore = winnerEval.stageOutcomes?.[stage]?.score;
        const loserScore = loserEval.stageOutcomes?.[stage]?.score;
        if (typeof winnerScore === 'number' && typeof loserScore === 'number') {
          stageScores[stage].winner.push(winnerScore);
          stageScores[stage].loser.push(loserScore);
        }
      }
    }

    if (primaryEval?.workflowCost !== undefined && challengerEval?.workflowCost !== undefined) {
      const winnerCost = winner === 'primary' ? primaryEval.workflowCost : challengerEval.workflowCost;
      const loserCost = winner === 'primary' ? challengerEval.workflowCost : primaryEval.workflowCost;
      if (typeof winnerCost === 'number' && typeof loserCost === 'number') {
        costs.winner.push(winnerCost);
        costs.loser.push(loserCost);
      }
    }
  }

  for (const [stage, scores] of Object.entries(stageScores)) {
    if (scores.winner.length > 0) {
      const winnerAvg = scores.winner.reduce((a, b) => a + b, 0) / scores.winner.length;
      const loserAvg = scores.loser.reduce((a, b) => a + b, 0) / scores.loser.length;
      stats.stageQuality[stage as keyof typeof stats.stageQuality] = {
        winnerAvg,
        loserAvg,
        delta: winnerAvg - loserAvg,
        count: scores.winner.length,
      };
    }
  }

  if (costs.winner.length > 0) {
    const winnerAvg = costs.winner.reduce((a, b) => a + b, 0) / costs.winner.length;
    const loserAvg = costs.loser.reduce((a, b) => a + b, 0) / costs.loser.length;
    stats.costEfficiency = {
      winnerAvg,
      loserAvg,
      count: costs.winner.length,
    };
  }

  return stats;
}

/**
 * Format challenge aggregation results for terminal output.
 */
export function formatChallengeTextOutput(stats: AggregatedStats): string {
  const lines: string[] = [];

  lines.push(`Challenge Results Summary (${stats.totalComparisons} comparisons)\n`);

  lines.push('Overall Win Rates:');
  const sortedModels = Array.from(stats.overallWinRates.entries()).sort(
    (a, b) => b[1].winRate - a[1].winRate
  );
  for (const [model, stat] of sortedModels) {
    const pct = (stat.winRate * 100).toFixed(1);
    lines.push(`  ${model.padEnd(30)} ${stat.wins}/${stat.total}  ${pct}%`);
  }
  lines.push('');

  const roles = ['planner', 'coder', 'reviewer'] as const;
  for (const role of roles) {
    const roleStats = stats.winRatesByRole[role];
    if (Object.keys(roleStats).length > 0) {
      lines.push(`Win Rates as ${role.charAt(0).toUpperCase() + role.slice(1)}:`);
      const sortedRoles = Object.entries(roleStats).sort((a, b) => b[1].winRate - a[1].winRate);
      for (const [model, stat] of sortedRoles) {
        const pct = (stat.winRate * 100).toFixed(1);
        lines.push(`  ${model.padEnd(30)} ${stat.wins}/${stat.total}  ${pct}%`);
      }
      lines.push('');
    }
  }

  if (stats.winRatesByChallengeType.size > 0) {
    lines.push('By Challenge Type:');
    for (const [type, stat] of stats.winRatesByChallengeType.entries()) {
      lines.push(`  ${type.padEnd(20)} ${stat.total} comparisons`);
    }
    lines.push('');
  }

  for (const surface of ['router', 'planner', 'reviewer'] as const) {
    const variants = Array.from(stats.winRatesByResourceVariant[surface].entries());
    if (variants.length > 0) {
      lines.push(`By ${surface.charAt(0).toUpperCase() + surface.slice(1)} Resource Variant:`);
      for (const [variant, stat] of variants.sort((a, b) => b[1].winRate - a[1].winRate)) {
        const pct = (stat.winRate * 100).toFixed(1);
        lines.push(`  ${variant.padEnd(20)} ${stat.wins}/${stat.total}  ${pct}%`);
      }
      lines.push('');
    }
  }

  const stageNames = ['expansion', 'plan', 'implementation', 'review'] as const;
  const hasStageData = stageNames.some((stage) => stats.stageQuality[stage]);
  if (hasStageData) {
    lines.push('Stage Quality (winner vs loser avg):');
    for (const stage of stageNames) {
      const quality = stats.stageQuality[stage];
      if (quality) {
        const deltaSign = quality.delta >= 0 ? '+' : '';
        const deltaStr = `${deltaSign}${quality.delta.toFixed(2)}`;
        const marker = Math.abs(quality.delta) > 0.15 ? ' ← strongest signal' : '';
        lines.push(
          `  ${stage.padEnd(15)}: ${quality.winnerAvg.toFixed(2)} vs ${quality.loserAvg.toFixed(2)}  (${deltaStr})${marker}`
        );
      }
    }
    lines.push('');
  }

  if (stats.costEfficiency) {
    const { winnerAvg, loserAvg } = stats.costEfficiency;
    lines.push('Cost Efficiency:');
    lines.push(`  Avg cost (winner): $${winnerAvg.toFixed(2)}  |  Avg cost (loser): $${loserAvg.toFixed(2)}`);
    lines.push('');
  }

  return lines.join('\n');
}
