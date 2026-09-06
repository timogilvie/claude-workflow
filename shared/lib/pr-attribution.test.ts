import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  attributePullRequest,
  type PullRequestInput,
} from './pr-attribution.ts';

function makePr(overrides: Partial<PullRequestInput> = {}): PullRequestInput {
  return {
    number: 1,
    authorLogin: 'octocat',
    authorType: 'User',
    headRef: 'feature/change',
    labels: [],
    mergedAt: '2026-09-01T00:00:00Z',
    commitMessages: ['Human authored change'],
    body: '',
    headSha: 'abc1234',
    ...overrides,
  };
}

describe('pr-attribution three-dimension engine', () => {
  it('detects copilot bot login -> github-copilot harness, strong agent', () => {
    const pr = makePr({
      authorLogin: 'github-copilot[bot]',
      authorType: 'Bot',
    });

    const result = attributePullRequest(pr);

    assert.equal(result.agentAuthored.value, 'agent');
    assert.equal(result.agentAuthored.confidence, 'strong');
    assert.equal(result.harness.value, 'github-copilot');
    assert.equal(result.harness.confidence, 'strong');
    assert.equal(result.model.value, 'unknown');
    assert(result.signals.includes('botAuthor'));
  });

  it('detects claude bot login -> claude-code harness, strong agent', () => {
    const pr = makePr({
      authorLogin: 'claude[bot]',
      authorType: 'Bot',
    });

    const result = attributePullRequest(pr);

    assert.equal(result.agentAuthored.value, 'agent');
    assert.equal(result.harness.value, 'claude-code');
    assert.equal(result.model.value, 'unknown');
  });

  it('detects model-bearing Co-Authored-By trailer -> model attribution', () => {
    const pr = makePr({
      authorLogin: 'octocat',
      authorType: 'User',
      commitMessages: [
        'Fix parser\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>',
      ],
    });

    const result = attributePullRequest(pr);

    assert.equal(result.agentAuthored.value, 'agent');
    assert.equal(result.harness.value, 'claude-code');
    assert.equal(result.model.value, 'claude-fable-5-1');
    assert.equal(result.model.confidence, 'strong');
    assert(result.signals.includes('coAuthoredBy'));
  });

  it('detects generic Claude trailer -> agent/harness, no model', () => {
    const pr = makePr({
      authorLogin: 'octocat',
      authorType: 'User',
      commitMessages: [
        'Fix parser\n\nCo-Authored-By: Claude <noreply@anthropic.com>',
      ],
    });

    const result = attributePullRequest(pr);

    assert.equal(result.agentAuthored.value, 'agent');
    assert.equal(result.harness.value, 'claude-code');
    assert.equal(result.model.value, 'unknown'); // generic trailer, no model
  });

  it('precedence: strong (bot login) beats weak (branch prefix)', () => {
    const pr = makePr({
      authorLogin: 'github-copilot[bot]',
      authorType: 'Bot',
      headRef: 'claude/feature',
    });

    const result = attributePullRequest(pr);

    // bot login (strong) wins over branch prefix (weak)
    assert.equal(result.harness.value, 'github-copilot');
    assert.equal(result.harness.confidence, 'strong');
    assert(!result.harness.conflict);

    // evidence includes only the winning signal (botAuthor)
    // branch prefix is weak and doesn't win, so not included
    assert(result.harness.evidence.some((e) => e.signal === 'botAuthor'));
    assert.equal(result.harness.evidence.filter((e) => e.signal === 'branchPrefix').length, 0);
  });

  it('precedence within strong tier: botAuthor beats commitSignature', () => {
    const pr = makePr({
      authorLogin: 'openai-codex[bot]',
      authorType: 'Bot',
      commitMessages: ['Generated with Claude Code'],
    });

    const result = attributePullRequest(pr);

    // botAuthor (order 4) has higher precedence than commitSignature (order 5)
    // so openai-codex wins even though claude-code also signals
    assert.equal(result.harness.value, 'openai-codex');
    assert.equal(result.harness.confidence, 'strong');
    assert.equal(result.harness.conflict, false);

    // Only botAuthor evidence is retained (it won)
    assert(result.harness.evidence.some((e) => e.signal === 'botAuthor'));
    assert.equal(result.harness.evidence.length, 1);
  });

  it('agentAuthored never conflicts (all signals say agent)', () => {
    const pr = makePr({
      authorLogin: 'openai-codex[bot]',
      authorType: 'Bot',
      commitMessages: ['Generated with Claude Code'],
      headRef: 'claude/feature',
    });

    const result = attributePullRequest(pr);

    // Multiple signals fire with different harness mappings, but agentAuthored stays agent
    assert.equal(result.agentAuthored.value, 'agent');
    assert.equal(result.agentAuthored.confidence, 'strong');
    assert.equal(result.agentAuthored.conflict, false);
    // agentAuthored evidence includes all signals from the winning tier (strong)
    // botAuthor and commitSignature are both strong, branchPrefix is weak so excluded
    assert(result.agentAuthored.evidence.length >= 2);
    assert(result.agentAuthored.evidence.some((e) => e.signal === 'botAuthor'));
    assert(result.agentAuthored.evidence.some((e) => e.signal === 'commitSignature'));
  });

  it('no signals -> all dimensions unknown', () => {
    const pr = makePr({
      authorLogin: 'octocat',
      authorType: 'User',
      headRef: 'main',
      labels: [],
      commitMessages: ['Regular commit message'],
    });

    const result = attributePullRequest(pr);

    assert.equal(result.agentAuthored.value, 'unknown');
    assert.equal(result.harness.value, 'unknown');
    assert.equal(result.model.value, 'unknown');
    assert.equal(result.signals.length, 0);
    assert.equal(result.agentAuthored.evidence.length, 0);
  });

  it('branch prefix weak signal alone', () => {
    const pr = makePr({
      authorLogin: 'octocat',
      authorType: 'User',
      headRef: 'claude/feature',
      labels: [],
      commitMessages: ['Regular commit'],
    });

    const result = attributePullRequest(pr);

    assert.equal(result.agentAuthored.value, 'agent');
    assert.equal(result.agentAuthored.confidence, 'weak');
    assert.equal(result.harness.value, 'claude-code');
    assert.equal(result.harness.confidence, 'weak');
    assert(result.signals.includes('branchPrefix'));
  });

  it('label signal (weak) with harness mapping', () => {
    const pr = makePr({
      authorLogin: 'octocat',
      authorType: 'User',
      labels: ['copilot'],
    });

    const result = attributePullRequest(pr);

    assert.equal(result.agentAuthored.value, 'agent');
    assert.equal(result.agentAuthored.confidence, 'weak');
    assert.equal(result.harness.value, 'github-copilot');
    assert.equal(result.harness.confidence, 'weak');
    assert(result.signals.includes('label'));
  });

  it('commit signature alone', () => {
    const pr = makePr({
      authorLogin: 'octocat',
      authorType: 'User',
      commitMessages: ['Fix parser\n\nGenerated with GitHub Copilot'],
    });

    const result = attributePullRequest(pr);

    assert.equal(result.agentAuthored.value, 'agent');
    assert.equal(result.agentAuthored.confidence, 'strong');
    assert.equal(result.harness.value, 'github-copilot');
    assert(result.signals.includes('commitSignature'));
  });

  it('disabled signal is skipped', () => {
    const pr = makePr({
      authorLogin: 'github-copilot[bot]',
      authorType: 'Bot',
      headRef: 'claude/feature',
    });

    const result = attributePullRequest(pr, new Set(['botAuthor']));

    // With botAuthor disabled, only branch prefix remains (weak)
    assert.equal(result.harness.value, 'claude-code');
    assert.equal(result.harness.confidence, 'weak');
    assert(!result.signals.includes('botAuthor'));
    assert(result.signals.includes('branchPrefix'));
  });

  it('multiple trailers in commit, first model-bearing one wins', () => {
    const pr = makePr({
      commitMessages: [
        [
          'Fix parser',
          '',
          'Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>',
          'Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>',
        ].join('\n'),
      ],
    });

    const result = attributePullRequest(pr);

    assert.equal(result.model.value, 'claude-opus-5');
  });

  it('commits with no trailers do not affect detection', () => {
    const pr = makePr({
      authorLogin: 'octocat',
      commitMessages: [
        'First commit\nNo trailers here',
        'Generated with Claude Code\nNo trailer on this one either',
      ],
    });

    const result = attributePullRequest(pr);

    assert.equal(result.harness.value, 'claude-code');
    assert(result.signals.includes('commitSignature'));
  });

  it('empty PR body is tolerated', () => {
    const pr = makePr({
      body: '',
      headSha: undefined,
    });

    const result = attributePullRequest(pr);

    assert.equal(result.agentAuthored.value, 'unknown');
  });

  describe('first-party executed_route (Phase 3)', () => {
    it('valid executed route from wavemill-meta -> verified attribution', () => {
      const body = `Some PR description

<!-- wavemill-meta
route_schema: 1
executed_route: {"coder":{"model":"claude-opus-5","adapter":"claude-code","status":"executed","headSha":"abc1234"}}
-->`;

      const pr = makePr({
        body,
        headSha: 'abc1234',
      });

      const result = attributePullRequest(pr);

      assert.equal(result.agentAuthored.value, 'agent');
      assert.equal(result.agentAuthored.confidence, 'verified');
      assert.equal(result.harness.value, 'claude-code');
      assert.equal(result.harness.confidence, 'verified');
      assert.equal(result.model.value, 'claude-opus-5');
      assert.equal(result.model.confidence, 'verified');
      assert(result.signals.includes('firstPartyRoute'));
    });

    it('executed route beats conflicting bot-author heuristic', () => {
      const body = `<!-- wavemill-meta
route_schema: 1
executed_route: {"coder":{"model":"claude-opus-5","adapter":"claude-code","status":"executed","headSha":"xyz9999"}}
-->`;

      const pr = makePr({
        body,
        headSha: 'xyz9999',
        authorLogin: 'github-copilot[bot]',
        authorType: 'Bot',
      });

      const result = attributePullRequest(pr);

      // Verified first-party wins over strong bot-author
      assert.equal(result.harness.value, 'claude-code');
      assert.equal(result.harness.confidence, 'verified');
      // Only verified tier evidence is included (firstPartyRoute)
      assert(result.harness.evidence.some((e) => e.signal === 'firstPartyRoute'));
      assert.equal(result.harness.evidence.filter((e) => e.signal === 'botAuthor').length, 0);
    });

    it('stale route (head SHA mismatch) -> fallthrough to heuristics', () => {
      const body = `<!-- wavemill-meta
route_schema: 1
executed_route: {"coder":{"model":"claude-opus-5","adapter":"claude-code","status":"executed","headSha":"oldsha"}}
-->`;

      const pr = makePr({
        body,
        headSha: 'newsha', // Mismatch!
      });

      const result = attributePullRequest(pr);

      // Should be unknown since stale route is ignored
      assert.equal(result.model.value, 'unknown');
    });

    it('coder status not executed -> no attribution from route', () => {
      const body = `<!-- wavemill-meta
route_schema: 1
executed_route: {"coder":{"model":"claude-opus-5","adapter":"claude-code","status":"inherited","headSha":"abc1234"}}
-->`;

      const pr = makePr({
        body,
        headSha: 'abc1234',
      });

      const result = attributePullRequest(pr);

      // inherited status -> no attribution
      assert.equal(result.model.value, 'unknown');
      assert(!result.signals.includes('firstPartyRoute'));
    });

    it('malformed route JSON -> ignored, no error', () => {
      const body = `<!-- wavemill-meta
route_schema: 1
executed_route: {not valid json
-->`;

      const pr = makePr({
        body,
        headSha: 'abc1234',
      });

      const result = attributePullRequest(pr);

      // Malformed JSON is silently ignored
      assert.equal(result.agentAuthored.value, 'unknown');
    });

    it('wrong route_schema -> ignored', () => {
      const body = `<!-- wavemill-meta
route_schema: 2
executed_route: {"coder":{"model":"claude-opus-5","adapter":"claude-code","status":"executed"}}
-->`;

      const pr = makePr({
        body,
        headSha: 'abc1234',
      });

      const result = attributePullRequest(pr);

      // Wrong schema version ignored
      assert.equal(result.agentAuthored.value, 'unknown');
    });

    it('firstPartyRoute disabled via config -> heuristics only', () => {
      const body = `<!-- wavemill-meta
route_schema: 1
executed_route: {"coder":{"model":"claude-opus-5","adapter":"claude-code","status":"executed","headSha":"abc1234"}}
-->`;

      const pr = makePr({
        body,
        headSha: 'abc1234',
      });

      const result = attributePullRequest(pr, new Set(['firstPartyRoute']));

      // Disabled signal is not used
      assert.equal(result.agentAuthored.value, 'unknown');
      assert(!result.signals.includes('firstPartyRoute'));
    });

    it('no body -> no route extraction', () => {
      const pr = makePr({
        body: undefined,
        headSha: 'abc1234',
      });

      const result = attributePullRequest(pr);

      assert.equal(result.agentAuthored.value, 'unknown');
    });

    it('no headSha -> no route extraction', () => {
      const body = `<!-- wavemill-meta
route_schema: 1
executed_route: {"coder":{"model":"claude-opus-5","adapter":"claude-code","status":"executed"}}
-->`;

      const pr = makePr({
        body,
        headSha: undefined,
      });

      const result = attributePullRequest(pr);

      assert.equal(result.agentAuthored.value, 'unknown');
    });
  });
});
