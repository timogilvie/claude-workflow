import assert from 'node:assert/strict';
import test from 'node:test';
import { listOpenIssuesByIdentifierPrefix, setIssueState, setIssuesState, updateIssue } from './linear.ts';

type GraphQLPayload = {
  query: string;
  variables?: Record<string, unknown>;
};

function installFetchMock(handler: (payload: GraphQLPayload) => unknown | Promise<unknown>) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = (init?.body || '{}').toString();
    const payload = JSON.parse(body) as GraphQLPayload;
    const data = await handler(payload);
    return new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  return () => {
    globalThis.fetch = originalFetch;
  };
}

function isBatchIssueLookup(payload: GraphQLPayload, teamKey = 'HOK') {
  return payload.query.includes('issues(filter: { number: { in:')
    && payload.query.includes(`team: { key: { eq: "${teamKey}" } }`);
}

test('setIssueState caches team workflow states across calls', async () => {
  process.env.LINEAR_API_KEY = 'test';
  const teamId = 'team-cache-1';
  let teamQueryCount = 0;
  let updateCount = 0;

  const restore = installFetchMock((payload) => {
    if (payload.query.includes('issues(filter: { number: { eq:')) {
      const number = payload.query.includes('eq: 101') ? 'HOK-101' : 'HOK-102';
      return { issues: { nodes: [{ id: `issue-${number}`, identifier: number, team: { id: teamId } }] } };
    }
    if (payload.query.includes('query($teamId: String!)')) {
      teamQueryCount += 1;
      return { team: { states: { nodes: [{ id: 'state-in-progress', name: 'In Progress' }] } } };
    }
    if (payload.query.includes('mutation($issueId: String!, $input: IssueUpdateInput!)')) {
      updateCount += 1;
      return { issueUpdate: { success: true, issue: { id: 'x', identifier: 'HOK-1', url: 'u' } } };
    }
    throw new Error(`Unhandled query: ${payload.query}`);
  });

  try {
    await setIssueState('HOK-101', 'In Progress');
    await setIssueState('HOK-102', 'In Progress');
    assert.equal(teamQueryCount, 1);
    assert.equal(updateCount, 2);
  } finally {
    restore();
  }
});

test('setIssuesState with empty identifiers returns without API calls', async () => {
  process.env.LINEAR_API_KEY = 'test';
  let called = false;
  const restore = installFetchMock(() => {
    called = true;
    return {};
  });

  try {
    const result = await setIssuesState([], 'In Progress');
    assert.deepEqual(result, { updated: [], failed: [] });
    assert.equal(called, false);
  } finally {
    restore();
  }
});

test('setIssuesState batches issue lookup, team state lookup, and updates', async () => {
  process.env.LINEAR_API_KEY = 'test';
  const teamFetches = new Set<string>();
  let issueLookupCount = 0;
  let mutationCount = 0;

  const restore = installFetchMock((payload) => {
    if (isBatchIssueLookup(payload)) {
      issueLookupCount += 1;
      return {
        issues: {
          nodes: [
            { id: 'i1', identifier: 'HOK-201', team: { id: 't1' } },
            { id: 'i2', identifier: 'HOK-202', team: { id: 't1' } },
            { id: 'i3', identifier: 'HOK-301', team: { id: 't2' } },
            { id: 'i4', identifier: 'HOK-302', team: { id: 't2' } },
          ],
        },
      };
    }
    if (payload.query.includes('query($teamId: String!)')) {
      const teamId = String(payload.variables?.teamId || '');
      teamFetches.add(teamId);
      return { team: { states: { nodes: [{ id: `state-${teamId}`, name: 'In Progress' }] } } };
    }
    if (payload.query.includes('mutation($issueId: String!, $input: IssueUpdateInput!)')) {
      mutationCount += 1;
      return { issueUpdate: { success: true, issue: { id: 'x', identifier: 'x', url: 'u' } } };
    }
    throw new Error(`Unhandled query: ${payload.query}`);
  });

  try {
    const result = await setIssuesState(['HOK-201', 'HOK-202', 'HOK-301', 'HOK-302'], 'In Progress');
    assert.equal(issueLookupCount, 1);
    assert.equal(teamFetches.size, 2);
    assert.equal(mutationCount, 4);
    assert.deepEqual(result.failed, []);
    assert.deepEqual(result.updated.sort(), ['HOK-201', 'HOK-202', 'HOK-301', 'HOK-302']);
  } finally {
    restore();
  }
});

test('setIssuesState does not use the unsupported identifier issue filter', async () => {
  process.env.LINEAR_API_KEY = 'test';
  const queries: string[] = [];

  const restore = installFetchMock((payload) => {
    queries.push(payload.query);
    if (isBatchIssueLookup(payload)) {
      return {
        issues: {
          nodes: [
            { id: 'issue-regression', identifier: 'HOK-303', team: { id: 'team-regression' } },
          ],
        },
      };
    }
    if (payload.query.includes('query($teamId: String!)')) {
      return { team: { states: { nodes: [{ id: 'state-regression', name: 'In Progress' }] } } };
    }
    if (payload.query.includes('mutation($issueId: String!, $input: IssueUpdateInput!)')) {
      return {
        issueUpdate: {
          success: true,
          issue: { id: 'issue-regression', identifier: 'HOK-303', url: 'u' },
        },
      };
    }
    throw new Error(`Unhandled query: ${payload.query}`);
  });

  try {
    const result = await setIssuesState(['HOK-303'], 'In Progress');
    assert.deepEqual(result.failed, []);
    assert.deepEqual(result.updated, ['HOK-303']);
    const unsupportedFilter = [
      'identifier:',
      '{ in:',
    ].join(' ');
    assert.equal(queries.some((query) => query.includes(unsupportedFilter)), false);
    assert.equal(queries.some((query) => query.includes('number: { in:')), true);
  } finally {
    restore();
  }
});

test('setIssuesState returns failed entries on mutation errors without throwing', async () => {
  process.env.LINEAR_API_KEY = 'test';

  const restore = installFetchMock((payload) => {
    if (isBatchIssueLookup(payload)) {
      return {
        issues: {
          nodes: [
            { id: 'ok-id', identifier: 'HOK-401', team: { id: 't3' } },
            { id: 'bad-id', identifier: 'HOK-402', team: { id: 't3' } },
          ],
        },
      };
    }
    if (payload.query.includes('query($teamId: String!)')) {
      return { team: { states: { nodes: [{ id: 'state-t3', name: 'In Progress' }] } } };
    }
    if (payload.query.includes('mutation($issueId: String!, $input: IssueUpdateInput!)')) {
      if (payload.variables?.issueId === 'bad-id') {
        return { issueUpdate: { success: false, issue: { id: 'bad-id', identifier: 'HOK-402', url: 'u' } } };
      }
      return { issueUpdate: { success: true, issue: { id: 'ok-id', identifier: 'HOK-401', url: 'u' } } };
    }
    throw new Error(`Unhandled query: ${payload.query}`);
  });

  try {
    const result = await setIssuesState(['HOK-401', 'HOK-402'], 'In Progress');
    assert.deepEqual(result.updated, ['HOK-401']);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].issueId, 'HOK-402');
    assert.equal(result.failed[0].error, 'Failed to update issue state');
  } finally {
    restore();
  }
});

test('setIssuesState reports a generic error when Linear returns success false', async () => {
  process.env.LINEAR_API_KEY = 'test';

  const restore = installFetchMock((payload) => {
    if (isBatchIssueLookup(payload)) {
      return {
        issues: {
          nodes: [
            { id: 'bad-id', identifier: 'HOK-502', team: { id: 't5' } },
          ],
        },
      };
    }
    if (payload.query.includes('query($teamId: String!)')) {
      return { team: { states: { nodes: [{ id: 'state-t5', name: 'In Progress' }] } } };
    }
    if (payload.query.includes('mutation($issueId: String!, $input: IssueUpdateInput!)')) {
      return {
        issueUpdate: {
          success: false,
          issue: null,
        },
      };
    }
    throw new Error(`Unhandled query: ${payload.query}`);
  });

  try {
    const result = await setIssuesState(['HOK-502'], 'In Progress');
    assert.deepEqual(result.updated, []);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].issueId, 'HOK-502');
    assert.equal(result.failed[0].error, 'Failed to update issue state');
  } finally {
    restore();
  }
});

test('setIssuesState reports malformed mutation responses per issue', async () => {
  process.env.LINEAR_API_KEY = 'test';

  const restore = installFetchMock((payload) => {
    if (isBatchIssueLookup(payload)) {
      return {
        issues: {
          nodes: [
            { id: 'bad-id', identifier: 'HOK-503', team: { id: 't5' } },
          ],
        },
      };
    }
    if (payload.query.includes('query($teamId: String!)')) {
      return { team: { states: { nodes: [{ id: 'state-t5', name: 'In Progress' }] } } };
    }
    if (payload.query.includes('mutation($issueId: String!, $input: IssueUpdateInput!)')) {
      return {};
    }
    throw new Error(`Unhandled query: ${payload.query}`);
  });

  try {
    const result = await setIssuesState(['HOK-503'], 'In Progress');
    assert.deepEqual(result.updated, []);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].issueId, 'HOK-503');
    assert.equal(result.failed[0].error, 'Linear API response missing issueUpdate result');
    assert.equal(result.failed[0].category, 'graphql');
  } finally {
    restore();
  }
});

test('updateIssue mutation does not request userErrors', async () => {
  process.env.LINEAR_API_KEY = 'test';
  let capturedQuery = '';

  const restore = installFetchMock((payload) => {
    capturedQuery = payload.query;
    return {
      issueUpdate: {
        success: true,
        issue: { id: 'issue-1', identifier: 'HOK-601', url: 'u' },
      },
    };
  });

  try {
    const result = await updateIssue('issue-1', { stateId: 'state-1' });
    assert.equal(result.success, true);
    assert.match(capturedQuery, /success/);
    assert.doesNotMatch(capturedQuery, /userErrors/);
  } finally {
    restore();
  }
});

test('listOpenIssuesByIdentifierPrefix returns only open primary/challenger issues', async () => {
  process.env.LINEAR_API_KEY = 'test';
  let receivedIdentifiers: unknown[] = [];

  const restore = installFetchMock((payload) => {
    if (payload.query.includes('searchIssues(')) {
      receivedIdentifiers = [payload.variables?.term, `${payload.variables?.term}_c`];
      return {
        searchIssues: {
          nodes: [
            {
              id: 'issue-1',
              identifier: 'HOK-701',
              title: 'Primary',
              state: { name: 'In Progress' },
              completedAt: null,
              canceledAt: null,
            },
            {
              id: 'issue-2',
              identifier: 'HOK-701_c',
              title: 'Challenger',
              state: { name: 'Backlog' },
              completedAt: null,
              canceledAt: null,
            },
            {
              id: 'issue-3',
              identifier: 'HOK-701_c',
              title: 'Closed challenger',
              state: { name: 'Done' },
              completedAt: '2026-05-01T00:00:00Z',
              canceledAt: null,
            },
          ],
        },
      };
    }
    throw new Error(`Unhandled query: ${payload.query}`);
  });

  try {
    const issues = await listOpenIssuesByIdentifierPrefix('HOK-701');
    assert.deepEqual(receivedIdentifiers, ['HOK-701', 'HOK-701_c']);
    assert.deepEqual(issues.map((issue) => issue.identifier), ['HOK-701', 'HOK-701_c']);
  } finally {
    restore();
  }
});
