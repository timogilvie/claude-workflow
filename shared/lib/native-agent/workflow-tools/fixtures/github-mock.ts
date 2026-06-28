/**
 * Fixture-backed GitHub mock helper for workflow-tools integration tests.
 *
 * Exposes createGitHubMock() — a factory that builds an injectable GitHubToolDeps
 * with call-count tracking and a per-operation failure queue. Tests can seed
 * existing PRs/labels from JSON fixtures or provide custom data inline.
 *
 * Mirrors the makeFakeClient() pattern in linear-tools.test.ts.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GitHubToolDeps, GitHubToolLabelTarget, GitHubToolPullRequest } from '../github.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, 'github');

export function loadGitHubFixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, `${name}.json`), 'utf-8')) as T;
}

// ---------------------------------------------------------------------------
// Call-count tracker
// ---------------------------------------------------------------------------

export interface GitHubMockCalls {
  listOpenPullRequests: number;
  createPullRequest: number;
  updatePullRequest: number;
  getLabels: number;
  addLabel: number;
}

// ---------------------------------------------------------------------------
// State held by the mock
// ---------------------------------------------------------------------------

export interface GitHubMockState {
  pullRequests: GitHubToolPullRequest[];
  labelsByTarget: Map<string, GitHubToolLabelTarget>;
  calls: GitHubMockCalls;
  sleepCalls: number[];
}

// ---------------------------------------------------------------------------
// Seed options
// ---------------------------------------------------------------------------

export interface GitHubMockSeed {
  pullRequests?: GitHubToolPullRequest[];
  labelTargets?: Array<{
    repo: string;
    targetKind: 'pull_request' | 'issue';
    targetNumber: number;
    labels: string[];
    url: string;
  }>;
  /** Transient errors injected before listOpenPullRequests calls (consumed in FIFO order). */
  failListOpenPullRequests?: Error[];
  /** Transient errors injected before createPullRequest calls. */
  failCreatePullRequest?: Error[];
  /** Transient errors injected before updatePullRequest calls. */
  failUpdatePullRequest?: Error[];
  /** Transient errors injected before getLabels calls. */
  failGetLabels?: Error[];
  /** Transient errors injected before addLabel calls. */
  failAddLabel?: Error[];
  /**
   * Side-effect run BEFORE throwing a create failure.
   * Use to simulate the PR being created externally before the error surfaces.
   */
  onCreateSideEffect?: (state: GitHubMockState) => void;
  /**
   * Side-effect run BEFORE throwing an addLabel failure.
   * Use to simulate the label being added externally before the error surfaces.
   */
  onAddLabelSideEffect?: (state: GitHubMockState) => void;
  maxAttempts?: number;
  retryDelayMs?: number;
}

function targetKey(repo: string, targetKind: 'pull_request' | 'issue', targetNumber: number): string {
  return `${repo}:${targetKind}:${targetNumber}`;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a fixture-backed mock that satisfies GitHubToolDeps.
 *
 * Call counts are accumulated in state.calls. Errors are consumed from the
 * head of each failure queue, so the first N calls fail and the rest succeed.
 */
export function createGitHubMock(seed: GitHubMockSeed = {}): {
  deps: GitHubToolDeps;
  state: GitHubMockState;
} {
  const state: GitHubMockState = {
    pullRequests: seed.pullRequests ? [...seed.pullRequests] : [],
    labelsByTarget: new Map(
      (seed.labelTargets ?? []).map((t) => [
        targetKey(t.repo, t.targetKind, t.targetNumber),
        { number: t.targetNumber, labels: [...t.labels], url: t.url },
      ]),
    ),
    calls: {
      listOpenPullRequests: 0,
      createPullRequest: 0,
      updatePullRequest: 0,
      getLabels: 0,
      addLabel: 0,
    },
    sleepCalls: [],
  };

  const failListOpenPullRequests = [...(seed.failListOpenPullRequests ?? [])];
  const failCreatePullRequest = [...(seed.failCreatePullRequest ?? [])];
  const failUpdatePullRequest = [...(seed.failUpdatePullRequest ?? [])];
  const failGetLabels = [...(seed.failGetLabels ?? [])];
  const failAddLabel = [...(seed.failAddLabel ?? [])];

  const deps: GitHubToolDeps = {
    async listOpenPullRequests({ repo, head, base }) {
      state.calls.listOpenPullRequests += 1;
      const err = failListOpenPullRequests.shift();
      if (err) throw err;
      return state.pullRequests.filter(
        (pr) => pr.url.includes(repo) && pr.head === head && pr.base === base,
      );
    },

    async createPullRequest({ repo, head, base, title, body }) {
      state.calls.createPullRequest += 1;
      const err = failCreatePullRequest.shift();
      if (err) {
        seed.onCreateSideEffect?.(state);
        throw err;
      }
      const number = Math.max(0, ...state.pullRequests.map((pr) => pr.number)) + 1;
      const pr: GitHubToolPullRequest = {
        number,
        title,
        body,
        head,
        base,
        url: `https://github.com/${repo}/pull/${number}`,
      };
      state.pullRequests.push(pr);
      state.labelsByTarget.set(targetKey(repo, 'pull_request', number), {
        number,
        labels: [],
        url: pr.url,
      });
      return pr;
    },

    async updatePullRequest({ repo, number, title, body }) {
      state.calls.updatePullRequest += 1;
      const err = failUpdatePullRequest.shift();
      if (err) throw err;
      const pr = state.pullRequests.find((p) => p.number === number && p.url.includes(repo));
      if (!pr) throw new Error(`Pull request #${number} not found in ${repo}`);
      pr.title = title;
      pr.body = body;
      return pr;
    },

    async getLabels({ repo, targetKind, targetNumber }) {
      state.calls.getLabels += 1;
      const err = failGetLabels.shift();
      if (err) throw err;
      const current = state.labelsByTarget.get(targetKey(repo, targetKind, targetNumber));
      if (!current) throw new Error(`${targetKind} #${targetNumber} not found in ${repo}`);
      return { number: current.number, labels: [...current.labels], url: current.url };
    },

    async addLabel({ repo, targetKind, targetNumber, label }) {
      state.calls.addLabel += 1;
      const err = failAddLabel.shift();
      if (err) {
        seed.onAddLabelSideEffect?.(state);
        throw err;
      }
      const key = targetKey(repo, targetKind, targetNumber);
      const current = state.labelsByTarget.get(key);
      if (!current) throw new Error(`${targetKind} #${targetNumber} not found in ${repo}`);
      if (!current.labels.some((l) => l.toLowerCase() === label.toLowerCase())) {
        current.labels.push(label);
      }
      return { number: current.number, labels: [...current.labels], url: current.url };
    },

    async sleep(ms) {
      state.sleepCalls.push(ms);
    },

    maxAttempts: seed.maxAttempts ?? 3,
    retryDelayMs: seed.retryDelayMs ?? 10,
  };

  return { deps, state };
}
