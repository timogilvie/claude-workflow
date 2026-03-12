import type { ReviewMetric } from './review-metrics.ts';
import { CYAN, GREEN, YELLOW, RED, BOLD, DIM, NC } from './colors.ts';

export interface FilterOptions {
  from?: string;
  to?: string;
  outcome?: 'resolved' | 'escalated' | 'error';
  branch?: string;
  issue?: string;
}

export interface AggregateStats {
  totalReviews: number;
  avgIterations: number;
  resolutionRate: number;
  escalationRate: number;
  errorRate: number;
  iterationDistribution: Record<string, number>;
  findingsSummary: {
    total: number;
    avgPerReview: number;
    blockers: number;
    warnings: number;
    blockersPercent: number;
    warningsPercent: number;
  };
  topCategories: Array<{ category: string; count: number; percent: number }>;
  recentReviews: Array<{
    issue: string;
    branch: string;
    targetBranch: string;
    iterations: number;
    outcome: string;
    date: string;
  }>;
}

export function filterMetrics(metrics: ReviewMetric[], options: FilterOptions): ReviewMetric[] {
  return metrics.filter((metric) => {
    if (options.from) {
      const fromDate = new Date(options.from);
      const metricDate = new Date(metric.timestamp);
      if (metricDate < fromDate) {
        return false;
      }
    }

    if (options.to) {
      const toDate = new Date(options.to);
      toDate.setHours(23, 59, 59, 999);
      const metricDate = new Date(metric.timestamp);
      if (metricDate > toDate) {
        return false;
      }
    }

    if (options.outcome && metric.outcome !== options.outcome) {
      return false;
    }

    if (options.branch && !metric.branch.includes(options.branch)) {
      return false;
    }

    if (options.issue && metric.issueId !== options.issue) {
      return false;
    }

    return true;
  });
}

export function computeStats(metrics: ReviewMetric[], limit: number): AggregateStats {
  const totalReviews = metrics.length;

  if (totalReviews === 0) {
    return {
      totalReviews: 0,
      avgIterations: 0,
      resolutionRate: 0,
      escalationRate: 0,
      errorRate: 0,
      iterationDistribution: {},
      findingsSummary: {
        total: 0,
        avgPerReview: 0,
        blockers: 0,
        warnings: 0,
        blockersPercent: 0,
        warningsPercent: 0,
      },
      topCategories: [],
      recentReviews: [],
    };
  }

  const totalIterations = metrics.reduce((sum, metric) => sum + metric.totalIterations, 0);
  const avgIterations = totalIterations / totalReviews;

  const resolved = metrics.filter((metric) => metric.outcome === 'resolved').length;
  const escalated = metrics.filter((metric) => metric.outcome === 'escalated').length;
  const errors = metrics.filter((metric) => metric.outcome === 'error').length;

  const resolutionRate = (resolved / totalReviews) * 100;
  const escalationRate = (escalated / totalReviews) * 100;
  const errorRate = (errors / totalReviews) * 100;

  const iterationDistribution: Record<string, number> = {};
  for (const metric of metrics) {
    const key = metric.totalIterations >= 4 ? '4+' : String(metric.totalIterations);
    iterationDistribution[key] = (iterationDistribution[key] || 0) + 1;
  }

  let totalBlockers = 0;
  let totalWarnings = 0;
  const categoryCount: Record<string, number> = {};

  for (const metric of metrics) {
    for (const iteration of metric.iterations) {
      totalBlockers += iteration.findingsSummary.blockers;
      totalWarnings += iteration.findingsSummary.warnings;

      if (!iteration.findings) {
        continue;
      }

      for (const finding of iteration.findings) {
        categoryCount[finding.category] = (categoryCount[finding.category] || 0) + 1;
      }
    }
  }

  const totalFindings = totalBlockers + totalWarnings;
  const avgPerReview = totalFindings / totalReviews;
  const blockersPercent = totalFindings > 0 ? (totalBlockers / totalFindings) * 100 : 0;
  const warningsPercent = totalFindings > 0 ? (totalWarnings / totalFindings) * 100 : 0;

  const topCategories = Object.entries(categoryCount)
    .map(([category, count]) => ({
      category,
      count,
      percent: (count / totalFindings) * 100,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  const recentReviews = [...metrics]
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, limit)
    .map((metric) => ({
      issue: metric.issueId || 'N/A',
      branch: metric.branch,
      targetBranch: metric.targetBranch,
      iterations: metric.totalIterations,
      outcome: metric.outcome,
      date: metric.timestamp.split('T')[0],
    }));

  return {
    totalReviews,
    avgIterations,
    resolutionRate,
    escalationRate,
    errorRate,
    iterationDistribution,
    findingsSummary: {
      total: totalFindings,
      avgPerReview,
      blockers: totalBlockers,
      warnings: totalWarnings,
      blockersPercent,
      warningsPercent,
    },
    topCategories,
    recentReviews,
  };
}

export function formatStats(stats: AggregateStats): string {
  const lines: string[] = [];

  lines.push('');
  lines.push(`${BOLD}${CYAN}${'═'.repeat(63)}${NC}`);
  lines.push(`${BOLD}${CYAN}  REVIEW METRICS SUMMARY${NC}`);
  lines.push(`${BOLD}${CYAN}${'═'.repeat(63)}${NC}`);
  lines.push('');

  if (stats.totalReviews === 0) {
    lines.push(`${DIM}No review metrics found.${NC}`);
    lines.push('');
    lines.push(`${DIM}Run some workflows with self-review to collect data.${NC}`);
    lines.push('');
    lines.push(`${BOLD}${CYAN}${'═'.repeat(63)}${NC}`);
    lines.push('');
    return lines.join('\n');
  }

  lines.push(`${BOLD}Overall Statistics:${NC}`);
  lines.push(`  Total reviews:        ${stats.totalReviews}`);
  lines.push(`  Average iterations:   ${stats.avgIterations.toFixed(1)}`);
  lines.push(
    `  Resolution rate:      ${GREEN}${stats.resolutionRate.toFixed(1)}%${NC} (${Math.round((stats.resolutionRate / 100) * stats.totalReviews)}/${stats.totalReviews})`,
  );
  lines.push(
    `  Escalation rate:      ${YELLOW}${stats.escalationRate.toFixed(1)}%${NC} (${Math.round((stats.escalationRate / 100) * stats.totalReviews)}/${stats.totalReviews})`,
  );
  lines.push(
    `  Error rate:           ${RED}${stats.errorRate.toFixed(1)}%${NC} (${Math.round((stats.errorRate / 100) * stats.totalReviews)}/${stats.totalReviews})`,
  );
  lines.push('');

  lines.push(`${BOLD}Iteration Distribution:${NC}`);
  const sortedDist = Object.entries(stats.iterationDistribution).sort((a, b) => {
    const numA = a[0] === '4+' ? 4 : parseInt(a[0], 10);
    const numB = b[0] === '4+' ? 4 : parseInt(b[0], 10);
    return numA - numB;
  });

  for (const [key, count] of sortedDist) {
    const percent = ((count / stats.totalReviews) * 100).toFixed(1);
    const label = key === '1' ? '1 iteration' : `${key} iterations`;
    const bar = '█'.repeat(Math.round((count / stats.totalReviews) * 30));
    lines.push(`  ${label.padEnd(15)} ${percent.padStart(5)}% (${count.toString().padStart(2)}) ${DIM}${bar}${NC}`);
  }
  lines.push('');

  lines.push(`${BOLD}Findings Summary:${NC}`);
  lines.push(`  Total findings:       ${stats.findingsSummary.total}`);
  lines.push(`  Avg per review:       ${stats.findingsSummary.avgPerReview.toFixed(1)}`);
  lines.push(
    `  Blockers:             ${RED}${stats.findingsSummary.blockers}${NC} (${stats.findingsSummary.blockersPercent.toFixed(1)}%)`,
  );
  lines.push(
    `  Warnings:             ${YELLOW}${stats.findingsSummary.warnings}${NC} (${stats.findingsSummary.warningsPercent.toFixed(1)}%)`,
  );
  lines.push('');

  if (stats.topCategories.length > 0) {
    lines.push(`${BOLD}Top Finding Categories:${NC}`);
    stats.topCategories.forEach((category, index) => {
      lines.push(
        `  ${(index + 1).toString().padStart(2)}. ${category.category.padEnd(30)} ${category.count.toString().padStart(3)} (${category.percent.toFixed(1)}%)`,
      );
    });
    lines.push('');
  }

  if (stats.recentReviews.length > 0) {
    lines.push(`${BOLD}Recent Reviews (last ${stats.recentReviews.length}):${NC}`);
    for (const review of stats.recentReviews) {
      const outcomeColor =
        review.outcome === 'resolved' ? GREEN : review.outcome === 'escalated' ? YELLOW : RED;
      const iterText = review.iterations === 1 ? '1 iteration' : `${review.iterations} iterations`;
      lines.push(
        `  ${DIM}${review.issue.padEnd(10)}${NC} ${review.branch.padEnd(20).slice(0, 20)} ${iterText.padEnd(15)} ${outcomeColor}${review.outcome.padEnd(10)}${NC} ${DIM}${review.date}${NC}`,
      );
    }
    lines.push('');
  }

  lines.push(`${BOLD}${CYAN}${'═'.repeat(63)}${NC}`);
  lines.push('');

  return lines.join('\n');
}
