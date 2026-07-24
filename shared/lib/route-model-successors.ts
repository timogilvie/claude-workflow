import { getEffectiveRegistry, resolveCodexChatgptSuccessor } from './model-registry.ts';
import type { WorkflowRouteDecision } from './workflow-router.ts';

type RouteRole = 'planner' | 'coder' | 'reviewer';

/**
 * Upgrades explicitly retired Codex model IDs in a routing decision before it
 * is persisted or launched. This covers decisions received from Hokusai and
 * decisions restored from the expanded-route cache.
 */
export function upgradeRouteModelSuccessors(
  decision: WorkflowRouteDecision,
  repoDir?: string,
): WorkflowRouteDecision {
  const registry = getEffectiveRegistry(repoDir);
  const upgrades: Array<{ role: RouteRole; from: string; to: string }> = [];
  const upgraded = { ...decision };

  for (const role of ['planner', 'coder', 'reviewer'] as const) {
    const from = decision[role];
    const to = resolveCodexChatgptSuccessor(from, registry);
    if (!to || to === from) continue;
    upgraded[role] = to;
    upgrades.push({ role, from, to });
  }

  if (upgrades.length === 0) return decision;

  return {
    ...upgraded,
    reasoning: [
      ...decision.reasoning,
      ...upgrades.map(({ role, from, to }) =>
        `Upgraded retired ${role} model ${from} to its ChatGPT Codex successor ${to}.`,
      ),
    ],
  };
}
