// Shared Linear API client used by both Claude and Codex tooling.
// Centralizing these helpers prevents drift between scripts.

const LINEAR_ENDPOINT = 'https://api.linear.app/graphql';

const headers = () => ({
  Authorization: process.env.LINEAR_API_KEY || '',
  'Content-Type': 'application/json',
});

async function request(query, variables) {
  const res = await fetch(LINEAR_ENDPOINT, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ query, variables }),
  });

  const data = await res.json();
  if (data.errors) {
    throw new Error(`Linear API error: ${JSON.stringify(data.errors)}`);
  }
  return data.data;
}

export async function getProjects() {
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

  return data.projects?.nodes || [];
}

export async function getTeams() {
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

  return data.teams?.nodes || [];
}

export async function getBacklog(projectName) {
  const filters = ['state: { name: { eq: "Backlog" } }'];

  if (projectName) {
    filters.push(`project: { name: { eq: "${projectName}" } }`);
  }

  const filterClause = filters.length ? `filter: { ${filters.join(', ')} }` : '';

  const data = await request(`
    query {
      issues(${filterClause}) {
        nodes {
          id
          title
          description
          state { name }
          labels { nodes { name } }
          project { id name }
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
        }
      }
    }
  `);

  return data.issues?.nodes || [];
}

export async function createIssue(params) {
  const input = {
    title: params.title,
    description: params.description,
    teamId: params.teamId,
  };

  if (params.projectId) input.projectId = params.projectId;
  if (params.parentId) input.parentId = params.parentId;
  if (params.priority !== undefined) input.priority = params.priority;
  if (params.estimate !== undefined) input.estimate = params.estimate;
  if (params.projectMilestoneId) input.projectMilestoneId = params.projectMilestoneId;

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

  return data.issueCreate.issue;
}

export async function createProject(name, description, teamId) {
  const data = await request(
    `
      mutation($name: String!, $description: String!, $teamIds: [String!]!) {
        projectCreate(input: {
          name: $name
          description: $description
          teamIds: $teamIds
        }) {
          success
          project {
            id
            name
          }
        }
      }
    `,
    { name, description, teamIds: [teamId] },
  );

  return data.projectCreate?.project;
}

export async function getOrCreateProjectMilestone(projectId, milestoneName) {
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

  const existing = findData.project?.projectMilestones?.nodes?.find(
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

  return createData.projectMilestoneCreate?.projectMilestone?.id;
}

export async function createIssueRelation(issueId, relatedIssueId, type) {
  const data = await request(
    `
      mutation($issueId: String!, $relatedIssueId: String!, $type: String!) {
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

  return Boolean(data.issueRelationCreate?.success);
}
