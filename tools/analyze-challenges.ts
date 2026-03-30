#!/usr/bin/env -S npx tsx

import { runTool } from '../shared/lib/tool-runner.ts';
import { readChallengeComparisons, type ChallengeComparison } from '../shared/lib/challenge-comparison.ts';
import { readEvalRecords, type EvalRecord } from '../shared/lib/eval-persistence.ts';

interface JoinedChallengeRecord {
  comparison: ChallengeComparison;
  primaryEval?: EvalRecord;
  challengerEval?: EvalRecord;
}

interface ModelStats {
  wins: number;
  total: number;
  winRate: number;
}

interface RoleStats {
  [model: string]: ModelStats;
}

interface StageQuality {
  winnerAvg: number;
  loserAvg: number;
  delta: number;
  count: number;
}

interface CostStats {
  winnerAvg: number;
  loserAvg: number;
  count: number;
}

interface AggregatedStats {
  totalComparisons: number;
  overallWinRates: Map<string, ModelStats>;
  winRatesByRole: {
    planner: RoleStats;
    coder: RoleStats;
    reviewer: RoleStats;
  };
  winRatesByChallengeType: Map<string, ModelStats>;
  winRatesByDepth: Map<string, ModelStats>;
  stageQuality: {
    expansion?: StageQuality;
    plan?: StageQuality;
    implementation?: StageQuality;
    review?: StageQuality;
  };
  costEfficiency?: CostStats;
}

function joinRecords(
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

function incrementModelStat(map: Map<string, ModelStats>, model: string, isWin: boolean): void {
  const stats = map.get(model) || { wins: 0, total: 0, winRate: 0 };
  stats.total++;
  if (isWin) stats.wins++;
  stats.winRate = stats.total > 0 ? stats.wins / stats.total : 0;
  map.set(model, stats);
}

function computeAggregations(joined: JoinedChallengeRecord[]): AggregatedStats {
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

    // Overall win rates
    incrementModelStat(stats.overallWinRates, primaryModel, winner === 'primary');
    incrementModelStat(stats.overallWinRates, challengerModel, winner === 'challenger');

    // Win rates by role (only when routing is available)
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

    // Win rates by challenge type
    if (challengeType) {
      incrementModelStat(stats.winRatesByChallengeType, challengeType, true);
    }

    // Win rates by depth combination
    if (primaryRouting && challengerRouting) {
      const primaryDepth = `${primaryRouting.planDepth}×${primaryRouting.codeDepth}`;
      const challengerDepth = `${challengerRouting.planDepth}×${challengerRouting.codeDepth}`;
      incrementModelStat(stats.winRatesByDepth, primaryDepth, winner === 'primary');
      incrementModelStat(stats.winRatesByDepth, challengerDepth, winner === 'challenger');
    }

    // Stage quality correlation
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

    // Cost efficiency
    if (primaryEval?.workflowCost !== undefined && challengerEval?.workflowCost !== undefined) {
      const winnerCost = winner === 'primary' ? primaryEval.workflowCost : challengerEval.workflowCost;
      const loserCost = winner === 'primary' ? challengerEval.workflowCost : primaryEval.workflowCost;
      if (typeof winnerCost === 'number' && typeof loserCost === 'number') {
        costs.winner.push(winnerCost);
        costs.loser.push(loserCost);
      }
    }
  }

  // Compute stage quality averages
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

  // Compute cost efficiency
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

function formatTextOutput(stats: AggregatedStats): string {
  const lines: string[] = [];

  lines.push(`Challenge Results Summary (${stats.totalComparisons} comparisons)\n`);

  // Overall win rates
  lines.push('Overall Win Rates:');
  const sortedModels = Array.from(stats.overallWinRates.entries()).sort(
    (a, b) => b[1].winRate - a[1].winRate
  );
  for (const [model, stat] of sortedModels) {
    const pct = (stat.winRate * 100).toFixed(1);
    lines.push(`  ${model.padEnd(30)} ${stat.wins}/${stat.total}  ${pct}%`);
  }
  lines.push('');

  // Win rates by role
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

  // Win rates by challenge type
  if (stats.winRatesByChallengeType.size > 0) {
    lines.push('By Challenge Type:');
    for (const [type, stat] of stats.winRatesByChallengeType.entries()) {
      lines.push(`  ${type.padEnd(20)} ${stat.total} comparisons`);
    }
    lines.push('');
  }

  // Stage quality
  const stageNames = ['expansion', 'plan', 'implementation', 'review'] as const;
  const hasStageData = stageNames.some((s) => stats.stageQuality[s]);
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

  // Cost efficiency
  if (stats.costEfficiency) {
    const { winnerAvg, loserAvg } = stats.costEfficiency;
    lines.push('Cost Efficiency:');
    lines.push(`  Avg cost (winner): $${winnerAvg.toFixed(2)}  |  Avg cost (loser): $${loserAvg.toFixed(2)}`);
    lines.push('');
  }

  return lines.join('\n');
}

runTool({
  name: 'analyze-challenges',
  description: 'Analyze challenge comparison results and display aggregated statistics.',
  options: {
    json: { type: 'boolean', description: 'Output JSON instead of formatted text' },
    from: { type: 'string', description: 'Filter records from this date (ISO 8601)' },
    to: { type: 'string', description: 'Filter records to this date (ISO 8601)' },
    type: { type: 'string', description: 'Filter by challenge type' },
    model: { type: 'string', description: 'Filter by specific model' },
  },
  async run({ args, positional }) {
    const repoDir = positional[0] || process.cwd();
    const comparisons = readChallengeComparisons(repoDir);

    if (comparisons.length === 0) {
      console.log('No challenge records found.');
      return;
    }

    // Apply filters
    let filtered = comparisons;

    if (args.from) {
      const fromDate = new Date(args.from as string);
      filtered = filtered.filter((c) => new Date(c.timestamp) >= fromDate);
    }

    if (args.to) {
      const toDate = new Date(args.to as string);
      filtered = filtered.filter((c) => new Date(c.timestamp) <= toDate);
    }

    if (args.type) {
      const targetType = args.type as string;
      filtered = filtered.filter((c) => c.challengeType === targetType);
    }

    if (args.model) {
      const targetModel = args.model as string;
      filtered = filtered.filter(
        (c) => c.primaryModel === targetModel || c.challengerModel === targetModel
      );
    }

    // Join with eval records
    const evals = readEvalRecords(repoDir);
    const joined = joinRecords(filtered, evals);

    // Compute aggregations
    const stats = computeAggregations(joined);

    // Output
    if (args.json) {
      console.log(JSON.stringify({ stats, records: joined }, null, 2));
    } else {
      console.log(formatTextOutput(stats));
    }
  },
});
