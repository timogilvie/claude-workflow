/**
 * Reusable, fixture-backed GitHub deps builder for workflow-tool tests.
 *
 * Mirrors the loadFixture() pattern from linear-tools.test.ts and the
 * FixtureState / GitHubToolDeps shape used inline in github.test.ts.
 *
 * Usage:
 *   const { deps, state } = createFixtureBackedGithubDeps();
 *   const result = await githubCreatePr({ ... }, deps);
 *   assert.equal(state.calls.createPullRequest, 1);
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  GitHubToolDeps,
  GitHubToolLabelTarget,
  GitHubToolPullRequest,
} from '../github.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, 'github');

export function loadGithubFixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf-8')) as T;
}

export interface GithubFixtureErrors {
  rate_limited: string;
  not_found: string;
  conflict: string;
  transient_network: string;
}

export function loadGithubErrors(): GithubFixtureErrors {
  return loadGithubFixture<GithubFixtureErrors>('errors.json');
}

export interface GithubFixtureState {
  pullRequests: GitHubToolPullRequest[];
  labelsByTarget: Map<string, GitHubToolLabelTarget>;
  failListOpenPullRequests: Error[];
  failCreatePullRequest: Error[];
  failUpdatePullRequest: Error[];
  failGetLabels: Error[];
  failAddLabel: Error[];
  calls: Record<string, number>;
  sleepCalls: number[];
}

export interface GithubFixtureSeed {
  pullRequests?: GitHubToolPullRequest[];
  labelTargets?: Array<{
    repo: string;
    targetKind: 'pull_request' | 'issue';
    targetNumber: number;
    labels: string[];
    url: string;
  }>;
  failListOpenPullRequests?: Error[];
  failCreatePullRequest?: Error[];
  failUpdatePullRequest?: Error[];
  failGetLabels?: Error[];
  failAddLabel?: Error[];
  maxAttempts?: number;
  retryDelayMs?: number;
  onCreateSideEffect?: (state: GithubFixtureState) => void;
  onAddLabelSideEffect?: (state: GithubFixtureState) => void;
}

function targetKey(
  repo: string,
  targetKind: 'pull_request' | 'issue',
  targetNumber: number,
): string {
  return `${repo}:${targetKind}:${targetNumber}`;
}

export function createFixtureBackedGithubDeps(seed?: GithubFixtureSeed): {
  deps: GitHubToolDeps;
  state: GithubFixtureState;
} {
  const state: GithubFixtureState = {
    pullRequests: seed?.pullRequests ? [...seed.pullRequests] : [],
    labelsByTarget: new Map(
      (seed?.labelTargets ?? []).map((target) => [
        targetKey(target.repo, target.targetKind, target.targetNumber),
        {
          number: target.targetNumber,
          labels: [...target.labels],
          url: target.url,
        },
      ]),
    ),
    failListOpenPullRequests: [...(seed?.failListOpenPullRequests ?? [])],
    failCreatePullRequest: [...(seed?.failCreatePullRequest ?? [])],
    failUpdatePullRequest: [...(seed?.failUpdatePullRequest ?? [])],
    failGetLabels: [...(seed?.failGetLabels ?? [])],
    failAddLabel: [...(seed?.failAddLabel ?? [])],
    calls: {
      listOpenPullRequests: 0,
      createPullRequest: 0,
      updatePullRequest: 0,
      getLabels: 0,
      addLabel: 0,
    },
    sleepCalls: [],
  };

  const deps: GitHubToolDeps = {
    async listOpenPullRequests({ repo, head, base }) {
      state.calls.listOpenPullRequests += 1;
      const failure = state.failListOpenPullRequests.shift();
      if (failure) {
        throw failure;
      }
      return state.pullRequests.filter(
        (pr) => pr.url.includes(repo) && pr.head === head && pr.base === base,
      );
    },
    async createPullRequest({ repo, head, base, title, body }) {
      state.calls.createPullRequest += 1;
      const failure = state.failCreatePullRequest.shift();
      if (failure) {
        seed?.onCreateSideEffect?.(state);
        throw failure;
      }
      const nextNumber =
        Math.max(0, ...state.pullRequests.map((pr) => pr.number)) + 1;
      const pr: GitHubToolPullRequest = {
        number: nextNumber,
        title,
        body,
        head,
        base,
        url: `https://github.com/${repo}/pull/${nextNumber}`,
      };
      state.pullRequests.push(pr);
      // Auto-register label target so addLabel calls work without pre-seeding.
      state.labelsByTarget.set(targetKey(repo, 'pull_request', nextNumber), {
        number: nextNumber,
        labels: [],
        url: pr.url,
      });
      return pr;
    },
    async updatePullRequest({ repo, number, title, body }) {
      state.calls.updatePullRequest += 1;
      const failure = state.failUpdatePullRequest.shift();
      if (failure) {
        throw failure;
      }
      const current = state.pullRequests.find(
        (pr) => pr.number === number && pr.url.includes(repo),
      );
      if (!current) {
        throw new Error(`Pull request #${number} not found`);
      }
      current.title = title;
      current.body = body;
      return current;
    },
    async getLabels({ repo, targetKind, targetNumber }) {
      state.calls.getLabels += 1;
      const failure = state.failGetLabels.shift();
      if (failure) {
        throw failure;
      }
      const current = state.labelsByTarget.get(
        targetKey(repo, targetKind, targetNumber),
      );
      if (!current) {
        throw new Error(`${targetKind} #${targetNumber} not found`);
      }
      return {
        number: current.number,
        labels: [...current.labels],
        url: current.url,
      };
    },
    async addLabel({ repo, targetKind, targetNumber, label }) {
      state.calls.addLabel += 1;
      const failure = state.failAddLabel.shift();
      if (failure) {
        seed?.onAddLabelSideEffect?.(state);
        throw failure;
      }
      const key = targetKey(repo, targetKind, targetNumber);
      const current = state.labelsByTarget.get(key);
      if (!current) {
        throw new Error(`${targetKind} #${targetNumber} not found`);
      }
      if (
        !current.labels.some(
          (existing) => existing.toLowerCase() === label.toLowerCase(),
        )
      ) {
        current.labels.push(label);
      }
      return {
        number: current.number,
        labels: [...current.labels],
        url: current.url,
      };
    },
    async sleep(ms) {
      state.sleepCalls.push(ms);
    },
    maxAttempts: seed?.maxAttempts ?? 3,
    retryDelayMs: seed?.retryDelayMs ?? 10,
  };

  return { deps, state };
}
