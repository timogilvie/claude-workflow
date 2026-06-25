import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveProviderForModel } from '../shared/lib/llm-cli.ts';

describe('backfill-stage-scores provider routing', () => {
  it('routes gpt-5.5 (default model) to codex provider', () => {
    const provider = resolveProviderForModel('gpt-5.5');
    assert.equal(provider, 'codex');
  });

  it('routes claude-sonnet-4-6 to claude provider', () => {
    const provider = resolveProviderForModel('claude-sonnet-4-6');
    assert.equal(provider, 'claude');
  });

  it('routes claude-opus-4-8 to claude provider', () => {
    const provider = resolveProviderForModel('claude-opus-4-8');
    assert.equal(provider, 'claude');
  });

  it('routes gpt-4 to codex provider', () => {
    const provider = resolveProviderForModel('gpt-4');
    assert.equal(provider, 'codex');
  });

  it('routes o1-preview to codex provider', () => {
    const provider = resolveProviderForModel('o1-preview');
    assert.equal(provider, 'codex');
  });

  it('defaults to claude provider when model is undefined', () => {
    const provider = resolveProviderForModel(undefined);
    assert.equal(provider, 'claude');
  });

  it('handles claude-haiku correctly', () => {
    const provider = resolveProviderForModel('claude-haiku-4-5-20251001');
    assert.equal(provider, 'claude');
  });
});
