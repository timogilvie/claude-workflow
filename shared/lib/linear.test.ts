import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpError, sanitizeError, setIssueState, setIssuesState } from './linear.ts';

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

/**
 * Lower-level fetch mock that lets the handler return a full Response so
 * tests can simulate HTTP-level failures (5xx, 429) and verify retry behavior.
 */
function installRawFetchMock(
  handler: (payload: GraphQLPayload, callIndex: number) => Response | Promise<Response>,
) {
  const originalFetch = globalThis.fetch;
  let callIndex = 0;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = (init?.body || '{}').toString();
    const payload = JSON.parse(body) as GraphQLPayload;
    const idx = callIndex;
    callIndex += 1;
    return await handler(payload, idx);
  }) as typeof fetch;

  return () => {
    globalThis.fetch = originalFetch;
  };
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
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
    if (payload.query.includes('issues(filter: { identifier: { in: $identifiers } }')) {
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

test('setIssuesState returns failed entries on mutation errors without throwing', async () => {
  process.env.LINEAR_API_KEY = 'test';

  const restore = installFetchMock((payload) => {
    if (payload.query.includes('issues(filter: { identifier: { in: $identifiers } }')) {
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
  } finally {
    restore();
  }
});

test('setIssuesState retries transient 5xx and succeeds', async () => {
  process.env.LINEAR_API_KEY = 'test';
  let updateAttempts = 0;
  let lookupAttempts = 0;

  const restore = installRawFetchMock((payload) => {
    if (payload.query.includes('issues(filter: { identifier: { in: $identifiers } }')) {
      lookupAttempts += 1;
      // First lookup attempt fails 503, second succeeds
      if (lookupAttempts === 1) {
        return new Response('upstream busy', { status: 503, statusText: 'Service Unavailable' });
      }
      return jsonResponse({
        issues: {
          nodes: [{ id: 'i-501', identifier: 'HOK-501', team: { id: 't-retry-1' } }],
        },
      });
    }
    if (payload.query.includes('query($teamId: String!)')) {
      return jsonResponse({ team: { states: { nodes: [{ id: 's-retry', name: 'In Progress' }] } } });
    }
    if (payload.query.includes('mutation($issueId: String!, $input: IssueUpdateInput!)')) {
      updateAttempts += 1;
      return jsonResponse({
        issueUpdate: { success: true, issue: { id: 'i-501', identifier: 'HOK-501', url: 'u' } },
      });
    }
    throw new Error(`Unhandled query: ${payload.query}`);
  });

  try {
    const result = await setIssuesState(['HOK-501'], 'In Progress');
    assert.deepEqual(result.failed, []);
    assert.deepEqual(result.updated, ['HOK-501']);
    assert.equal(lookupAttempts, 2, 'lookup should have been retried');
    assert.equal(updateAttempts, 1);
  } finally {
    restore();
  }
});

test('setIssuesState does not retry hard 4xx errors', async () => {
  process.env.LINEAR_API_KEY = 'test';
  let lookupAttempts = 0;

  const restore = installRawFetchMock((payload) => {
    if (payload.query.includes('issues(filter: { identifier: { in: $identifiers } }')) {
      lookupAttempts += 1;
      return new Response('bad request', { status: 422, statusText: 'Unprocessable Entity' });
    }
    throw new Error(`Unhandled query: ${payload.query}`);
  });

  try {
    const result = await setIssuesState(['HOK-601'], 'In Progress');
    assert.equal(lookupAttempts, 1, '4xx must not be retried');
    assert.deepEqual(result.updated, []);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].issueId, 'HOK-601');
    assert.match(result.failed[0].error, /Failed to fetch issue/);
  } finally {
    restore();
  }
});

test('setIssuesState gracefully handles per-team state lookup failure', async () => {
  process.env.LINEAR_API_KEY = 'test';

  const restore = installRawFetchMock((payload) => {
    if (payload.query.includes('issues(filter: { identifier: { in: $identifiers } }')) {
      return jsonResponse({
        issues: {
          nodes: [
            { id: 'i1', identifier: 'HOK-701', team: { id: 't-good-1' } },
            { id: 'i2', identifier: 'HOK-702', team: { id: 't-bad-1' } },
          ],
        },
      });
    }
    if (payload.query.includes('query($teamId: String!)')) {
      const teamId = String(payload.variables?.teamId || '');
      if (teamId === 't-bad-1') {
        // All retries fail with 500 → graceful degradation
        return new Response('boom', { status: 500, statusText: 'Internal Server Error' });
      }
      return jsonResponse({ team: { states: { nodes: [{ id: 's-good', name: 'In Progress' }] } } });
    }
    if (payload.query.includes('mutation($issueId: String!, $input: IssueUpdateInput!)')) {
      return jsonResponse({
        issueUpdate: { success: true, issue: { id: 'i1', identifier: 'HOK-701', url: 'u' } },
      });
    }
    throw new Error(`Unhandled query: ${payload.query}`);
  });

  try {
    const result = await setIssuesState(['HOK-701', 'HOK-702'], 'In Progress');
    // Good team's issue still updated despite the bad team's failure
    assert.deepEqual(result.updated, ['HOK-701']);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].issueId, 'HOK-702');
    assert.match(result.failed[0].error, /Failed to fetch team states/);
  } finally {
    restore();
  }
});

test('setIssuesState returns failures (does not throw) when all team state lookups fail', async () => {
  process.env.LINEAR_API_KEY = 'test';

  const restore = installRawFetchMock((payload) => {
    if (payload.query.includes('issues(filter: { identifier: { in: $identifiers } }')) {
      return jsonResponse({
        issues: {
          nodes: [
            { id: 'i1', identifier: 'HOK-801', team: { id: 't-down-1' } },
            { id: 'i2', identifier: 'HOK-802', team: { id: 't-down-1' } },
          ],
        },
      });
    }
    if (payload.query.includes('query($teamId: String!)')) {
      return new Response('down', { status: 503, statusText: 'Service Unavailable' });
    }
    throw new Error(`Unhandled query: ${payload.query}`);
  });

  try {
    // Must NOT throw — this is the regression we're guarding
    const result = await setIssuesState(['HOK-801', 'HOK-802'], 'In Progress');
    assert.deepEqual(result.updated, []);
    assert.equal(result.failed.length, 2);
    assert.deepEqual(result.failed.map((f) => f.issueId).sort(), ['HOK-801', 'HOK-802']);
  } finally {
    restore();
  }
});

test('sanitizeError redacts the Linear API key from error messages', () => {
  const original = process.env.LINEAR_API_KEY;
  process.env.LINEAR_API_KEY = 'lin_api_supersecretkey_1234567890';

  try {
    const err = new Error(`auth failed using ${process.env.LINEAR_API_KEY}`);
    const msg = sanitizeError(err);
    assert.ok(!msg.includes('lin_api_supersecretkey_1234567890'), 'API key must be redacted');
    assert.ok(msg.includes('[REDACTED]'));
  } finally {
    process.env.LINEAR_API_KEY = original;
  }
});

test('HttpError carries status, statusText, and retryAfter', () => {
  const err = new HttpError(429, 'Too Many Requests', '{"error":"rate limited"}', '5');
  assert.equal(err.status, 429);
  assert.equal(err.statusText, 'Too Many Requests');
  assert.equal(err.retryAfter, '5');
  assert.ok(err.message.includes('429'));
});
