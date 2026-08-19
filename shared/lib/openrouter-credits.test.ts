import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fetchOpenRouterCredits, type OpenRouterCreditsTransport } from './openrouter-credits.ts';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe('openrouter-credits', () => {
  it('fetches and normalizes prepaid credit balance', async () => {
    let calledUrl = '';
    const transport: OpenRouterCreditsTransport = async (url, init) => {
      calledUrl = url;
      assert.equal(init.headers && (init.headers as Record<string, string>).Authorization, 'Bearer sk-test');
      return jsonResponse({
        total_credits: 110,
        total_usage: 110.157967615,
        usage_daily: 10.05,
      });
    };

    const result = await fetchOpenRouterCredits({
      env: { OPENROUTER_API_KEY: 'sk-test' },
      transport,
    });

    assert.equal(calledUrl, 'https://openrouter.ai/api/v1/credits');
    assert.deepEqual(result, {
      totalCredits: 110,
      totalUsage: 110.157967615,
      balanceUsd: -0.157967615,
      usageDaily: 10.05,
    });
  });

  it('returns null when the key is missing or unauthorized', async () => {
    assert.equal(await fetchOpenRouterCredits({ env: {}, transport: async () => jsonResponse({}) }), null);

    const unauthorized = await fetchOpenRouterCredits({
      env: { OPENROUTER_API_KEY: 'bad' },
      transport: async () => jsonResponse({ error: 'unauthorized' }, 401),
    });
    assert.equal(unauthorized, null);
  });

  it('throws on network errors, non-json bodies, and missing fields', async () => {
    await assert.rejects(
      fetchOpenRouterCredits({
        env: { OPENROUTER_API_KEY: 'sk-test' },
        transport: async () => {
          throw new Error('socket hang up');
        },
      }),
      /socket hang up/,
    );

    await assert.rejects(
      fetchOpenRouterCredits({
        env: { OPENROUTER_API_KEY: 'sk-test' },
        transport: async () => ({
          ok: true,
          status: 200,
          text: async () => 'not-json',
        } as Response),
      }),
      /not valid JSON/,
    );

    await assert.rejects(
      fetchOpenRouterCredits({
        env: { OPENROUTER_API_KEY: 'sk-test' },
        transport: async () => jsonResponse({ total_credits: 1 }),
      }),
      /total_usage/,
    );
  });
});
