// tools/linear.ts

export const getProjects = async () => {
  const res = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: {
      Authorization: process.env.LINEAR_API_KEY || '',
      'Content-Type': 'application/json',
    } as Record<string, string>,
    body: JSON.stringify({
      query: `
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
      `,
    }),
  });

  const data = await res.json();
  if (data.errors) {
    throw new Error(`Linear API error: ${JSON.stringify(data.errors)}`);
  }
  return data.data?.projects?.nodes || [];
};

export const getBacklog = async (projectName?: string) => {
  // Build filter to only get items in Backlog state
  const filters = [];
  
  // Always filter for Backlog state
  filters.push('state: { name: { eq: "Backlog" } }');
  
  // Add project filter if projectName is provided
  if (projectName) {
    filters.push(`project: { name: { eq: "${projectName}" } }`);
  }
  
  const filter = filters.length > 0 
    ? `filter: { ${filters.join(', ')} }`
    : '';
    
  const res = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: {
      Authorization: process.env.LINEAR_API_KEY || '',
      'Content-Type': 'application/json',
    } as Record<string, string>,
    body: JSON.stringify({
      query: `
        query {
          issues(${filter}) {
            nodes {
              id
              title
              description
              state { name }
              labels {
                nodes { name }
              }
              project {
                name
              }
            }
          }
        }
      `,
    }),
  });

  const data = await res.json();
  if (data.errors) {
    throw new Error(`Linear API error: ${JSON.stringify(data.errors)}`);
  }
  return data.data?.issues?.nodes || [];
};