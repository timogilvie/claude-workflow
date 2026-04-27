import type { LinearIssue } from './linear.ts';

export interface ResolvedDependencies {
  dependsOn: string[];
  dependsOnLinear: string[];
}

/**
 * Resolve Linear issue blocking relations into PR dependency metadata.
 *
 * Examines `inverseRelations` for "blocks" relations (i.e., issues that block
 * the given issue). Completed/canceled blockers are excluded. For each remaining
 * blocker, `resolvePr` is called to map the Linear identifier to a PR number.
 */
export async function resolveLinearDependencies(
  issue: LinearIssue,
  resolvePr: (linearId: string) => Promise<number | null> | number | null,
): Promise<ResolvedDependencies> {
  const dependsOnSet = new Set<string>();
  const dependsOnLinearSet = new Set<string>();

  const candidates = issue.inverseRelations?.nodes ?? [];

  for (const node of candidates) {
    if (node.type !== 'blocks') continue;

    const blocker = node.issue;
    if (!blocker) continue;
    if (blocker.completedAt || blocker.canceledAt) continue;

    try {
      const prNumber = await resolvePr(blocker.identifier);
      if (prNumber != null) {
        dependsOnSet.add(`PR#${prNumber}`);
      } else {
        dependsOnLinearSet.add(blocker.identifier);
      }
    } catch {
      dependsOnLinearSet.add(blocker.identifier);
    }
  }

  return {
    dependsOn: [...dependsOnSet],
    dependsOnLinear: [...dependsOnLinearSet],
  };
}
