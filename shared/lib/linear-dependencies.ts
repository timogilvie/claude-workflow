import { escapeShellArg, execShellCommand } from './shell-utils.ts';
import { getIssue, type LinearIssue, type LinearRelation } from './linear.ts';

export interface DependencyResolutionInput {
  relations?: { nodes: LinearRelation[] } | null;
  inverseRelations?: { nodes: LinearRelation[] } | null;
  resolvePrForIssue: (identifier: string) => number | null;
}

export interface DependencyResolutionResult {
  depends_on: string[];
  depends_on_linear: string[];
}

interface PullRequestSearchResult {
  number: number;
  headRefName?: string;
  title?: string;
}

interface FetchLinearDependenciesOptions {
  repoDir?: string;
}

function isUnresolved(identifier: string | undefined, completedAt?: string | null, canceledAt?: string | null): identifier is string {
  return Boolean(identifier) && !completedAt && !canceledAt;
}

function collectBlockingIdentifiers(issue: Pick<LinearIssue, 'relations' | 'inverseRelations'>): string[] {
  const identifiers = new Set<string>();

  for (const relation of issue.inverseRelations?.nodes ?? []) {
    if (relation.type !== 'blocks') {
      continue;
    }

    const blocker = relation.issue;
    if (isUnresolved(blocker?.identifier, blocker?.completedAt, blocker?.canceledAt)) {
      identifiers.add(blocker.identifier);
    }
  }

  return [...identifiers];
}

function comparePrRefs(left: string, right: string): number {
  return Number.parseInt(left.slice(3), 10) - Number.parseInt(right.slice(3), 10);
}

function compareIssueIds(left: string, right: string): number {
  return left.localeCompare(right);
}

function listPullRequestsForDependencyScan(repoDir?: string): PullRequestSearchResult[] {
  const args = [
    'gh',
    'pr',
    'list',
    '--state',
    'all',
    '--json',
    'number,headRefName,title',
  ];
  const command = args.map((arg) => escapeShellArg(arg)).join(' ');
  const output = String(execShellCommand(command, {
    cwd: repoDir,
    encoding: 'utf-8',
  })).trim();

  if (!output) {
    return [];
  }

  return JSON.parse(output) as PullRequestSearchResult[];
}

function buildPrResolver(
  issueIdentifiers: string[],
  repoDir?: string,
): (identifier: string) => number | null {
  if (issueIdentifiers.length === 0) {
    return () => null;
  }

  const pullRequests = listPullRequestsForDependencyScan(repoDir);
  const prNumbersByIssue = new Map<string, number>();

  for (const identifier of issueIdentifiers) {
    const normalizedIdentifier = identifier.toLowerCase();
    const matchingNumbers = pullRequests
      .filter((pr) => {
        const headRefName = pr.headRefName?.toLowerCase() ?? '';
        const title = pr.title?.toLowerCase() ?? '';
        return headRefName.includes(normalizedIdentifier) || title.includes(normalizedIdentifier);
      })
      .map((pr) => pr.number)
      .sort((left, right) => left - right);

    if (matchingNumbers.length > 0) {
      prNumbersByIssue.set(identifier, matchingNumbers[0]);
    }
  }

  return (identifier: string) => prNumbersByIssue.get(identifier) ?? null;
}

export function resolveDependencies(input: DependencyResolutionInput): DependencyResolutionResult {
  const issueIdentifiers = collectBlockingIdentifiers(input);
  const dependsOn = new Set<string>();
  const dependsOnLinear = new Set<string>();

  for (const identifier of issueIdentifiers) {
    const prNumber = input.resolvePrForIssue(identifier);
    if (prNumber !== null) {
      dependsOn.add(`PR#${prNumber}`);
      continue;
    }

    dependsOnLinear.add(identifier);
  }

  return {
    depends_on: [...dependsOn].sort(comparePrRefs),
    depends_on_linear: [...dependsOnLinear].sort(compareIssueIds),
  };
}

export async function fetchLinearDependencies(
  issueIdentifier: string,
  options: FetchLinearDependenciesOptions = {},
): Promise<DependencyResolutionResult> {
  const issue = await getIssue(issueIdentifier);
  const blockingIdentifiers = collectBlockingIdentifiers(issue);
  const resolvePrForIssue = buildPrResolver(blockingIdentifiers, options.repoDir);

  return resolveDependencies({
    relations: issue.relations,
    inverseRelations: issue.inverseRelations,
    resolvePrForIssue,
  });
}
