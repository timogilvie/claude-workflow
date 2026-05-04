/**
 * Shared Linear API client used by both Claude and Codex tooling.
 *
 * Centralizing these helpers prevents drift between scripts.
 *
 * @module linear
 */

const LINEAR_ENDPOINT = 'https://api.linear.app/graphql';
const REQUEST_TIMEOUT_MS = 15_000;
const teamStateCache = new Map<string, Map<string, string>>();

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

/**
 * Linear issue state.
 */
export interface LinearState {
  id?: string;
  name: string;
}

/**
 * Linear label.
 */
export interface LinearLabel {
  id: string;
  name: string;
  color?: string;
  description?: string;
  team?: {
    id: string;
    name: string;
  };
}

/**
 * Linear team.
 */
export interface LinearTeam {
  id: string;
  name: string;
  key: string;
  states?: {
    nodes: Array<{
      id: string;
      name: string;
    }>;
  };
}

/**
 * Linear project.
 */
export interface LinearProject {
  id: string;
  name: string;
  description?: string;
  state: string;
  issues?: {
    nodes: Array<{ id: string }>;
  };
}

/**
 * Linear project milestone.
 */
export interface LinearProjectMilestone {
  id: string;
  name: string;
}

/**
 * Linear issue comment.
 */
export interface LinearComment {
  body: string;
  user: {
    name: string;
  };
  createdAt: string;
}

/**
 * Linear issue relation.
 */
export interface LinearRelation {
  type: string;
  relatedIssue?: {
    id: string;
    identifier: string;
    completedAt?: string | null;
    canceledAt?: string | null;
  };
  issue?: {
    id: string;
    identifier: string;
    completedAt?: string | null;
    canceledAt?: string | null;
  };
}

/**
 * Linear user.
 */
export interface LinearUser {
  name: string;
  email: string;
}

/**
 * Linear issue (comprehensive type).
 */
export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description?: string;
  state: LinearState;
  labels: {
    nodes: LinearLabel[];
  };
  project?: LinearProject;
  priority?: number;
  estimate?: number;
  assignee?: LinearUser;
  creator?: LinearUser;
  team: LinearTeam;
  parent?: {
    id: string;
    identifier: string;
    title: string;
  };
  children?: {
    nodes: LinearIssue[];
  };
  comments?: {
    nodes: LinearComment[];
  };
  relations?: {
    nodes: LinearRelation[];
  };
  inverseRelations?: {
    nodes: LinearRelation[];
  };
  url?: string;
  completedAt?: string | null;
  canceledAt?: string | null;
}

export interface LinearIssueSummary {
  id: string;
  identifier: string;
  title: string;
  state?: LinearState;
  completedAt?: string | null;
  canceledAt?: string | null;
}

/**
 * Linear initiative.
 */
export interface LinearInitiative {
  id: string;
  name: string;
  description?: string;
  content?: string;
  status: string;
  slugId: string;
  targetDate?: string;
  owner?: {
    name: string;
  };
  projects: {
    nodes: LinearProject[];
  };
}

/**
 * Parameters for creating a new issue.
 */
export interface IssueCreateParams {
  title: string;
  description?: string;
  teamId: string;
  projectId?: string;
  parentId?: string;
  priority?: number;
  estimate?: number;
  projectMilestoneId?: string;
  labelIds?: string[];
}

/**
 * Input for updating an issue.
 *
 * Supported fields:
 * - `stateId`: Update issue state
 * - `labelIds`: Update issue labels (replaces existing)
 * - `addedLabelIds`: Add labels without removing existing
 * - `removedLabelIds`: Remove specific labels
 * - `description`: Update issue description (plain text or markdown)
 * - `title`: Update issue title
 * - `priority`: Update priority (0-3)
 * - `estimate`: Update point estimate
 * - `assigneeId`: Update assignee
 * - Other fields: See Linear GraphQL schema
 */
export interface IssueUpdateInput {
  stateId?: string;
  labelIds?: string[];
  description?: string;
  title?: string;
  priority?: number;
  estimate?: number;
  assigneeId?: string;
  [key: string]: unknown;
}

/**
 * Parsed issue identifier.
 */
interface ParsedIdentifier {
  teamKey: string;
  number: number;
}

/**
 * Generic GraphQL response data.
 */
interface GraphQLData {
  [key: string]: unknown;
}

// ────────────────────────────────────────────────────────────────
// Internal Helpers
// ────────────────────────────────────────────────────────────────

const headers = (): Record<string, string> => ({
  Authorization: process.env.LINEAR_API_KEY || '',
  'Content-Type': 'application/json',
});

async function request(query: string, variables?: Record<string, unknown>): Promise<GraphQLData> {
  if (!process.env.LINEAR_API_KEY) {
    throw new Error('LINEAR_API_KEY is not set. Export it in your shell or add it to .env');
  }

  const res = await fetch(LINEAR_ENDPOINT, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const data = await res.json() as { data?: GraphQLData; errors?: Array<{ message: string }> };
  if (data.errors) {
    throw new Error(`Linear API error: ${JSON.stringify(data.errors)}`);
  }
  return data.data || {};
}

/**
 * Parse "HOK-123" into { teamKey: "HOK", number: 123 }
 */
function parseIdentifier(identifier: string): ParsedIdentifier {
  const match = identifier.match(/^([A-Z]+)-(\d+)$/);
  if (!match) {
    throw new Error(`Invalid issue identifier: ${identifier}. Expected format: HOK-123`);
  }
  return { teamKey: match[1], number: parseInt(match[2], 10) };
}

/**
 * Fetch issue by identifier with custom fields fragment.
 */
async function fetchIssueByIdentifier(identifier: string, fieldsFragment: string): Promise<LinearIssue> {
  const { teamKey, number } = parseIdentifier(identifier);

  const data = await request(`
    query {
      issues(filter: { number: { eq: ${number} }, team: { key: { eq: "${teamKey}" } } }, first: 1) {
        nodes {
          ${fieldsFragment}
        }
      }
    }
  `);

  const issues = data.issues as { nodes?: LinearIssue[] } | undefined;
  const issue = issues?.nodes?.[0];
  if (!issue) {
    throw new Error(`Issue not found: ${identifier}`);
  }

  return issue;
}

async function getTeamWorkflowStates(teamId: string): Promise<Map<string, string>> {
  const cached = teamStateCache.get(teamId);
  if (cached) {
    return cached;
  }

  const data = await request(
    `
      query($teamId: String!) {
        team(id: $teamId) {
          states {
            nodes {
              id
              name
            }
          }
        }
      }
    `,
    { teamId },
  );

  const states = (data.team as { states?: { nodes?: Array<{ id: string; name: string }> } } | undefined)
    ?.states?.nodes || [];
  const byName = new Map<string, string>();
  for (const state of states) {
    byName.set(state.name.toLowerCase(), state.id);
  }
  teamStateCache.set(teamId, byName);
  return byName;
}

// ────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────

/**
 * Get all projects.
 *
 * @returns Array of projects
 *
 * @example
 * ```typescript
 * const projects = await getProjects();
 * console.log(projects.map(p => p.name));
 * ```
 */
export async function getProjects(): Promise<LinearProject[]> {
  const data = await request(`
    query {
      projects {
        nodes {
          id
          name
          description
          state
        }
      }
    }
  `);

  const projects = data.projects as { nodes?: LinearProject[] } | undefined;
  return projects?.nodes || [];
}

/**
 * Get all teams.
 *
 * @returns Array of teams
 */
export async function getTeams(): Promise<LinearTeam[]> {
  const data = await request(`
    query {
      teams {
        nodes {
          id
          name
          key
        }
      }
    }
  `);

  const teams = data.teams as { nodes?: LinearTeam[] } | undefined;
  return teams?.nodes || [];
}

/**
 * Get backlog issues (Backlog or Todo state).
 *
 * @param projectName - Optional project name filter
 * @returns Array of issues
 */
export async function getBacklog(projectName?: string): Promise<LinearIssue[]> {
  const filters = ['state: { name: { in: ["Backlog", "Todo"] } }'];

  if (projectName) {
    filters.push(`project: { name: { eq: "${projectName}" } }`);
  }

  const filterClause = filters.length ? `filter: { ${filters.join(', ')} }` : '';

  const data = await request(`
    query {
      issues(${filterClause}, first: 50) {
        nodes {
          id
          identifier
          title
          description
          state { name id }
          labels { nodes { name } }
          project { id name }
          estimate
          priority
          parent {
            id
            identifier
            title
          }
          children {
            nodes {
              id
              identifier
              title
              description
              state { name }
              labels { nodes { name } }
            }
          }
          relations {
            nodes {
              type
              relatedIssue { id identifier completedAt canceledAt }
            }
          }
          inverseRelations {
            nodes {
              type
              issue { id identifier completedAt canceledAt }
            }
          }
        }
      }
    }
  `);

  const issues = data.issues as { nodes?: LinearIssue[] } | undefined;
  return issues?.nodes || [];
}

/**
 * Leaner backlog query for scoring — omits parent, children, project, state.id
 *
 * @param projectName - Optional project name filter
 * @returns Array of issues with minimal fields
 */
export async function getBacklogForScoring(projectName?: string): Promise<LinearIssue[]> {
  const filters = ['state: { name: { in: ["Backlog", "Todo"] } }'];

  if (projectName) {
    filters.push(`project: { name: { eq: "${projectName}" } }`);
  }

  const filterClause = filters.length ? `filter: { ${filters.join(', ')} }` : '';

  const data = await request(`
    query {
      issues(${filterClause}, first: 50) {
        nodes {
          identifier
          title
          description
          state { name }
          labels { nodes { name } }
          estimate
          priority
          relations {
            nodes {
              type
              relatedIssue { id identifier completedAt canceledAt }
            }
          }
          inverseRelations {
            nodes {
              type
              issue { id identifier completedAt canceledAt }
            }
          }
        }
      }
    }
  `);

  const issues = data.issues as { nodes?: LinearIssue[] } | undefined;
  return issues?.nodes || [];
}

/**
 * Set issue state by state name.
 *
 * @param identifier - Issue identifier (e.g., 'HOK-123')
 * @param stateName - State name (e.g., 'In Progress')
 * @returns Update result
 */
export async function setIssueState(identifier: string, stateName: string): Promise<{ success: boolean; issue: LinearIssue }> {
  const issue = await fetchIssueByIdentifier(identifier, `
    id
    team {
      id
    }
  `);
  const states = await getTeamWorkflowStates(issue.team.id);
  const targetStateId = states.get(stateName.toLowerCase());

  if (!targetStateId) {
    const available = [...states.keys()].join(', ');
    throw new Error(`State "${stateName}" not found. Available: ${available}`);
  }

  return await updateIssue(issue.id, { stateId: targetStateId });
}

type LinearIssueUpdateResult = {
  success: boolean;
  issue: LinearIssue;
};

export async function setIssuesState(
  identifiers: string[],
  stateName: string,
): Promise<{ updated: string[]; failed: Array<{ issueId: string; error: string }> }> {
  if (identifiers.length === 0) {
    return { updated: [], failed: [] };
  }

  const failed: Array<{ issueId: string; error: string }> = [];
  const updated: string[] = [];
  const PAGE_SIZE = 250;
  const fetchedIdentifiers = new Set<string>();
  const allNodes: Array<{ id: string; identifier: string; team: { id: string } }> = [];

  // Fetch in pages to avoid the 250-node GraphQL limit
  for (let offset = 0; offset < identifiers.length; offset += PAGE_SIZE) {
    const chunk = identifiers.slice(offset, offset + PAGE_SIZE);
    let data: Record<string, unknown>;
    try {
      data = await request(
        `
          query($identifiers: [String!]) {
            issues(filter: { identifier: { in: $identifiers } }, first: ${PAGE_SIZE}) {
              nodes {
                id
                identifier
                team {
                  id
                }
              }
            }
          }
        `,
        { identifiers: chunk },
      );
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      for (const identifier of chunk) {
        failed.push({ issueId: identifier, error: `Failed to fetch issue: ${error}` });
        fetchedIdentifiers.add(identifier);
      }
      continue;
    }
    const nodes = (data.issues as {
      nodes?: Array<{ id: string; identifier: string; team: { id: string } }>;
    } | undefined)?.nodes || [];
    for (const node of nodes) {
      fetchedIdentifiers.add(node.identifier);
    }
    allNodes.push(...nodes);
  }

  const issues = allNodes;

  // Any identifier not returned by the API (and not already in failed) was not found
  const missing = identifiers.filter((id) => !fetchedIdentifiers.has(id));
  for (const identifier of missing) {
    failed.push({ issueId: identifier, error: `Issue not found: ${identifier}` });
  }

  const statesByTeam = new Map<string, Map<string, string>>();
  const teamIds = [...new Set(issues.map((issue) => issue.team.id))];
  await Promise.all(teamIds.map(async (teamId) => {
    statesByTeam.set(teamId, await getTeamWorkflowStates(teamId));
  }));

  const planned = issues.map((issue) => {
    const stateId = statesByTeam.get(issue.team.id)?.get(stateName.toLowerCase());
    if (!stateId) {
      failed.push({
        issueId: issue.identifier,
        error: `State "${stateName}" not found for team ${issue.team.id}`,
      });
      return null;
    }
    return { issue, stateId };
  }).filter((item): item is { issue: { id: string; identifier: string; team: { id: string } }; stateId: string } => item !== null);

  const results = await Promise.allSettled(
    planned.map(({ issue, stateId }) => updateIssue(issue.id, { stateId })),
  );

  for (let i = 0; i < results.length; i += 1) {
    const result = results[i];
    const issue = planned[i].issue;
    if (result.status === 'fulfilled' && result.value.success) {
      updated.push(issue.identifier);
    } else if (result.status === 'fulfilled') {
      failed.push({
        issueId: issue.identifier,
        error: 'Failed to update issue state',
      });
    } else {
      failed.push({
        issueId: issue.identifier,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  }

  return { updated, failed };
}

/**
 * Create a new issue.
 *
 * @param params - Issue creation parameters
 * @returns Created issue
 */
export async function createIssue(params: IssueCreateParams): Promise<LinearIssue> {
  const input: Record<string, unknown> = {
    title: params.title,
    description: params.description,
    teamId: params.teamId,
  };

  if (params.projectId) input.projectId = params.projectId;
  if (params.parentId) input.parentId = params.parentId;
  if (params.priority !== undefined) input.priority = params.priority;
  if (params.estimate !== undefined) input.estimate = params.estimate;
  if (params.projectMilestoneId) input.projectMilestoneId = params.projectMilestoneId;
  if (params.labelIds && params.labelIds.length > 0) input.labelIds = params.labelIds;

  const data = await request(
    `
      mutation($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          issue {
            id
            identifier
            title
            url
          }
        }
      }
    `,
    { input },
  );

  const result = data.issueCreate as { issue: LinearIssue };
  return result.issue;
}

/**
 * Get or create a project milestone.
 *
 * @param projectId - Project ID
 * @param milestoneName - Milestone name
 * @returns Milestone ID
 */
export async function getOrCreateProjectMilestone(projectId: string, milestoneName: string): Promise<string> {
  // First, get the project and check its milestones
  const findData = await request(
    `
      query($projectId: String!) {
        project(id: $projectId) {
          id
          projectMilestones {
            nodes {
              id
              name
            }
          }
        }
      }
    `,
    { projectId },
  );

  const project = findData.project as {
    projectMilestones?: { nodes?: LinearProjectMilestone[] };
  } | undefined;

  const existing = project?.projectMilestones?.nodes?.find(
    (m) => m.name === milestoneName
  );

  if (existing) {
    return existing.id;
  }

  // Create new milestone
  const createData = await request(
    `
      mutation($name: String!, $projectId: String!) {
        projectMilestoneCreate(input: {
          name: $name
          projectId: $projectId
        }) {
          success
          projectMilestone {
            id
            name
          }
        }
      }
    `,
    { name: milestoneName, projectId },
  );

  const result = createData.projectMilestoneCreate as {
    projectMilestone?: { id: string };
  };
  return result.projectMilestone?.id || '';
}

/**
 * Get full issue details.
 *
 * @param identifier - Issue identifier (e.g., 'HOK-123')
 * @returns Issue details
 */
export async function getIssue(identifier: string): Promise<LinearIssue> {
  return await fetchIssueByIdentifier(identifier, `
    id
    identifier
    title
    description
    state { name }
    labels { nodes { id name } }
    project { id name }
    priority
    estimate
    assignee { name email }
    creator { name email }
    team { id name key }
    parent {
      id
      identifier
      title
    }
    children {
      nodes {
        id
        identifier
        title
        description
        state { name }
        labels { nodes { id name } }
      }
    }
    comments {
      nodes {
        body
        user { name }
        createdAt
      }
    }
    relations {
      nodes {
        type
        relatedIssue { id identifier completedAt canceledAt }
      }
    }
    inverseRelations {
      nodes {
        type
        issue { id identifier completedAt canceledAt }
      }
    }
    url
    completedAt
    canceledAt
  `);
}

/**
 * Lightweight: only id, identifier, title (for update-issue.ts log output).
 *
 * @param identifier - Issue identifier
 * @returns Basic issue info
 */
export async function getIssueBasic(identifier: string): Promise<Pick<LinearIssue, 'id' | 'identifier' | 'title'>> {
  return await fetchIssueByIdentifier(identifier, 'id identifier title') as Pick<LinearIssue, 'id' | 'identifier' | 'title'>;
}

/**
 * Lightweight: only completedAt/canceledAt (for get-issue-state.ts).
 *
 * @param identifier - Issue identifier
 * @returns Completion state
 */
export async function getIssueCompletionState(identifier: string): Promise<Pick<LinearIssue, 'id' | 'completedAt' | 'canceledAt'>> {
  return await fetchIssueByIdentifier(identifier, 'id completedAt canceledAt') as Pick<LinearIssue, 'id' | 'completedAt' | 'canceledAt'>;
}

/**
 * List the open primary/challenger issues for a challenge root identifier.
 *
 * @param prefix - Root identifier such as "HOK-123"
 * @returns Open issues matching the root and challenger identifiers
 */
export async function listOpenIssuesByIdentifierPrefix(prefix: string): Promise<LinearIssueSummary[]> {
  const root = parseIdentifier(prefix);
  const identifier = `${root.teamKey}-${root.number}`;
  const identifiers = new Set([identifier, deriveChallengerIdentifier(identifier)]);
  const data = await request(
    `
      query($term: String!, $teamKey: String!) {
        searchIssues(
          term: $term
          first: 10
          includeArchived: false
          filter: {
            team: { key: { eq: $teamKey } }
            completedAt: { null: true }
            canceledAt: { null: true }
          }
        ) {
          nodes {
            id
            identifier
            title
            state { name }
            completedAt
            canceledAt
          }
        }
      }
    `,
    { term: identifier, teamKey: root.teamKey },
  );

  const nodes = (data.searchIssues as { nodes?: LinearIssueSummary[] } | undefined)?.nodes || [];
  return nodes.filter((issue) =>
    issue.completedAt == null
    && issue.canceledAt == null
    && identifiers.has(issue.identifier),
  );
}

/**
 * Lightweight: id + team + current labels (for add-issue-label.ts).
 *
 * @param identifier - Issue identifier
 * @returns Issue with labeling info
 */
export async function getIssueForLabeling(identifier: string): Promise<LinearIssue> {
  return await fetchIssueByIdentifier(identifier, `
    id
    team { id }
    labels { nodes { id name } }
  `);
}

function deriveChallengerIdentifier(identifier: string): string {
  return `${identifier}_c`;
}

/**
 * Update an issue.
 *
 * Supports all IssueUpdateInput fields including description, state, labels, etc.
 *
 * @param issueId - Issue ID (internal ID, not identifier like "HOK-123")
 * @param input - Update input (see IssueUpdateInput for supported fields)
 * @returns Update result with success flag and updated issue info
 *
 * @example
 * ```typescript
 * // Update description
 * await updateIssue(issueId, { description: "New description" });
 * // Update multiple fields
 * await updateIssue(issueId, { title: "New title", priority: 2 });
 * ```
 */
export async function updateIssue(issueId: string, input: IssueUpdateInput): Promise<LinearIssueUpdateResult> {
  const data = await request(
    `
      mutation($issueId: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $issueId, input: $input) {
          success
          issue {
            id
            identifier
            url
          }
        }
      }
    `,
    { issueId, input },
  );

  const result = data.issueUpdate as LinearIssueUpdateResult;
  return result;
}

/**
 * Create an issue relation.
 *
 * @param issueId - Source issue ID
 * @param relatedIssueId - Target issue ID
 * @param type - Relation type
 * @returns Success status
 */
export async function createIssueRelation(issueId: string, relatedIssueId: string, type: string): Promise<boolean> {
  const data = await request(
    `
      mutation($issueId: String!, $relatedIssueId: String!, $type: IssueRelationType!) {
        issueRelationCreate(input: {
          issueId: $issueId
          relatedIssueId: $relatedIssueId
          type: $type
        }) {
          success
        }
      }
    `,
    { issueId, relatedIssueId, type },
  );

  const result = data.issueRelationCreate as { success?: boolean };
  return Boolean(result.success);
}

// ========== Label Management ==========

/**
 * Get labels, optionally filtered by team.
 *
 * @param teamId - Optional team ID filter
 * @returns Array of labels
 */
export async function getLabels(teamId?: string): Promise<LinearLabel[]> {
  const filter = teamId ? `filter: { team: { id: { eq: "${teamId}" } } }` : '';

  const data = await request(`
    query {
      issueLabels(${filter}) {
        nodes {
          id
          name
          color
          description
          team { id name }
        }
      }
    }
  `);

  const labels = data.issueLabels as { nodes?: LinearLabel[] } | undefined;
  return labels?.nodes || [];
}

/**
 * Create a new label.
 *
 * @param name - Label name
 * @param teamId - Team ID
 * @param options - Optional color and description
 * @returns Created label
 */
export async function createLabel(
  name: string,
  teamId: string,
  options: { color?: string; description?: string } = {}
): Promise<LinearLabel> {
  const input: Record<string, unknown> = {
    name,
    teamId,
  };

  if (options.color) input.color = options.color;
  if (options.description) input.description = options.description;

  const data = await request(
    `
      mutation($input: IssueLabelCreateInput!) {
        issueLabelCreate(input: $input) {
          success
          issueLabel {
            id
            name
            color
          }
        }
      }
    `,
    { input },
  );

  const result = data.issueLabelCreate as { issueLabel: LinearLabel };
  return result.issueLabel;
}

/**
 * Add labels to an issue.
 *
 * @param issueId - Issue ID
 * @param labelIds - Array of label IDs
 * @returns Update result
 */
export async function addLabelsToIssue(issueId: string, labelIds: string[]): Promise<{ success: boolean; issue: LinearIssue }> {
  const data = await request(
    `
      mutation($issueId: String!, $labelIds: [String!]!) {
        issueUpdate(id: $issueId, input: { labelIds: $labelIds }) {
          success
          issue {
            id
            identifier
            labels { nodes { name } }
          }
        }
      }
    `,
    { issueId, labelIds },
  );

  const result = data.issueUpdate as { success: boolean; issue: LinearIssue };
  return result;
}

/**
 * Get existing label or create a new one.
 *
 * @param name - Label name
 * @param teamId - Team ID
 * @param options - Label options (color, description)
 * @param labelsCache - Optional pre-fetched labels array.
 *                      SIDE EFFECT: Newly created labels will be pushed to this array.
 * @returns The label object
 */
export async function getOrCreateLabel(
  name: string,
  teamId: string,
  options: { color?: string; description?: string } = {},
  labelsCache: LinearLabel[] | null = null
): Promise<LinearLabel> {
  // Use pre-fetched labels if provided, otherwise fetch
  const labels = labelsCache || await getLabels(teamId);
  const existing = labels.find(l => l.name === name);

  if (existing) {
    return existing;
  }

  // Create new label
  const newLabel = await createLabel(name, teamId, options);

  // Maintain cache coherence: add newly created label to the cache
  if (labelsCache && newLabel) {
    labelsCache.push(newLabel);
  }

  return newLabel;
}

// ========== Initiative Management ==========

/**
 * Get initiatives with optional status filter.
 *
 * @param statusFilter - Optional status filter array
 * @returns Array of initiatives
 */
export async function getInitiatives(statusFilter?: string[]): Promise<LinearInitiative[]> {
  const filters = [];
  if (statusFilter && statusFilter.length > 0) {
    filters.push(`status: { in: [${statusFilter.map(s => `"${s}"`).join(', ')}] }`);
  } else {
    filters.push('status: { nin: ["Completed"] }');
  }

  const filterClause = `filter: { ${filters.join(', ')} }`;

  const data = await request(`
    query {
      initiatives(${filterClause}, first: 50) {
        nodes {
          id
          name
          description
          content
          status
          slugId
          targetDate
          owner { name }
          projects {
            nodes {
              id
              name
              issues(first: 1) {
                nodes { id }
              }
            }
          }
        }
      }
    }
  `);

  const initiatives = data.initiatives as { nodes?: LinearInitiative[] } | undefined;
  return initiatives?.nodes || [];
}

/**
 * Get a single initiative by ID.
 *
 * @param initiativeId - Initiative ID
 * @returns Initiative details
 */
export async function getInitiative(initiativeId: string): Promise<LinearInitiative> {
  const data = await request(
    `
      query($id: String!) {
        initiative(id: $id) {
          id
          name
          description
          content
          status
          slugId
          targetDate
          owner { name }
          projects {
            nodes {
              id
              name
            }
          }
        }
      }
    `,
    { id: initiativeId },
  );

  return data.initiative as LinearInitiative;
}
