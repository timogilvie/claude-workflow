import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  analyzePullRequest,
  parseGitHubCommitMessages,
  parseGitHubPullRequest,
  parseReposFileContent,
  summarizeAttribution,
  validateRepoSlug,
  type PullRequestInput,
} from './measure-repo-attribution.ts';

const tempDirs: string[] = [];

function makePr(overrides: Partial<PullRequestInput> = {}): PullRequestInput {
  return {
    number: 1,
    authorLogin: 'octocat',
    authorType: 'User',
    headRef: 'feature/change',
    labels: [],
    mergedAt: '2026-09-01T00:00:00Z',
    commitMessages: ['Human authored change'],
    ...overrides,
  };
}

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'repo-attribution-'));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('measure-repo-attribution analysis', () => {
  it('detects every supported attribution signal case-insensitively', () => {
    const pr = makePr({
      number: 42,
      authorLogin: 'Copilot-SWE-Agent[bot]',
      authorType: 'Bot',
      headRef: 'Codex/fix-parser',
      labels: ['Claude Code'],
      commitMessages: [
        [
          'Improve parser',
          '',
          'Generated with Claude Code',
          'Co-Authored-By: Claude <noreply@anthropic.com>',
        ].join('\n'),
      ],
    });

    const result = analyzePullRequest(pr);

    assert.deepEqual(new Set(result.signals), new Set([
      'botAuthor',
      'coAuthoredBy',
      'branchPrefix',
      'label',
      'commitSignature',
    ]));
    assert.equal(result.evidence.length, 5);
  });

  it('deduplicates overlapping evidence into one union hit per PR', () => {
    const summary = summarizeAttribution('owner/repo', [
      makePr({
        number: 1,
        headRef: 'codex/fix-one',
        commitMessages: ['Generated with OpenAI Codex'],
      }),
      makePr({ number: 2 }),
    ]);

    assert.equal(summary.signalCounts.branchPrefix, 1);
    assert.equal(summary.signalCounts.commitSignature, 1);
    assert.equal(summary.unionCount, 1);
    assert.equal(summary.unattributedCount, 1);
    assert.equal(summary.coverage.union, 50);
    assert.equal(summary.coverage.unattributed, 50);
  });

  it('handles zero-PR repositories without NaN coverage', () => {
    const summary = summarizeAttribution('owner/empty', []);

    assert.equal(summary.sampledMergedPrs, 0);
    assert.equal(summary.unionCount, 0);
    assert.equal(summary.coverage.union, 0);
    assert.equal(summary.coverage.botAuthor, 0);
  });

  it('does not treat generic bots or incidental AI text as attribution', () => {
    const summary = summarizeAttribution('owner/repo', [
      makePr({
        authorLogin: 'dependabot[bot]',
        authorType: 'Bot',
        labels: ['security'],
        commitMessages: ['Fix failing AI parser test'],
      }),
    ]);

    assert.equal(summary.unionCount, 0);
    assert.equal(summary.unattributedCount, 1);
  });

  it('parses GitHub pull and commit API data', () => {
    const commitMessages = parseGitHubCommitMessages([
      { commit: { message: 'First commit' } },
      { commit: { message: 'Second commit' } },
    ], 7);
    const pr = parseGitHubPullRequest({
      number: 7,
      title: 'Change',
      user: { login: 'octocat', type: 'User' },
      head: { ref: 'feature/change' },
      labels: [{ name: 'enhancement' }],
      merged_at: '2026-09-01T00:00:00Z',
    }, commitMessages);

    assert.equal(pr.number, 7);
    assert.deepEqual(pr.labels, ['enhancement']);
    assert.deepEqual(pr.commitMessages, ['First commit', 'Second commit']);
  });

  it('rejects malformed GitHub API data', () => {
    assert.throws(() => parseGitHubPullRequest({ number: 1, merged_at: 'x' }, []), /labels array/);
    assert.throws(() => parseGitHubCommitMessages([{ commit: {} }], 1), /missing message/);
  });

  it('parses repository files and rejects invalid slugs', () => {
    assert.deepEqual(parseReposFileContent('owner/one\n# comment\nowner/two\n'), ['owner/one', 'owner/two']);
    assert.deepEqual(parseReposFileContent('["owner/one","owner/two"]'), ['owner/one', 'owner/two']);
    assert.equal(validateRepoSlug('Owner.Name/repo-name'), 'Owner.Name/repo-name');
    assert.throws(() => validateRepoSlug('not-a-slug'), /Invalid repository slug/);
  });
});

describe('measure-repo-attribution cli arguments', () => {
  it('prints help without requiring gh', () => {
    const result = spawnSync('npx', ['tsx', 'tools/measure-repo-attribution.ts', '--help'], {
      cwd: process.cwd(),
      encoding: 'utf-8',
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /measure-repo-attribution/);
  });

  it('fails clearly on missing repositories before calling gh', () => {
    const result = spawnSync('npx', ['tsx', 'tools/measure-repo-attribution.ts', '--limit', '1'], {
      cwd: process.cwd(),
      encoding: 'utf-8',
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Provide at least one --repo/);
  });

  it('accepts a JSON repos file then reaches gh auth validation', () => {
    const dir = makeTempDir();
    const reposFile = join(dir, 'repos.json');
    writeFileSync(reposFile, '["owner/repo"]\n', 'utf-8');

    const result = spawnSync('npx', ['tsx', 'tools/measure-repo-attribution.ts', '--repos-file', reposFile, '--limit', '0'], {
      cwd: process.cwd(),
      encoding: 'utf-8',
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Invalid --limit value/);
    assert.equal(readFileSync(reposFile, 'utf-8'), '["owner/repo"]\n');
  });

  it('loads repos from file and writes a generated JSON report', () => {
    const tempDir = makeTempDir();
    const binDir = join(tempDir, 'bin');
    mkdirSync(binDir);

    const reposFile = join(tempDir, 'repos.txt');
    const outputFile = join(tempDir, 'nested', 'report.json');
    const callLog = join(tempDir, 'gh-calls.log');
    writeFileSync(reposFile, '# sampled repositories\nacme/project\n', 'utf-8');

    const ghScript = join(binDir, 'gh');
    writeFileSync(
      ghScript,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$GH_CALL_LOG"

if [[ "$1" == "auth" && "$2" == "status" ]]; then
  exit 0
fi

if [[ "$1" == "api" && "$2" == "repos/acme/project/pulls" ]]; then
  cat <<'JSON'
[
  {
    "number": 1,
    "title": "Copilot change",
    "user": { "login": "github-copilot[bot]", "type": "Bot" },
    "head": { "ref": "copilot/update-attribution", "sha": "abc123" },
    "labels": [{ "name": "copilot" }],
    "merged_at": "2026-01-01T00:00:00Z",
    "body": ""
  },
  {
    "number": 2,
    "title": "Manual change",
    "user": { "login": "octocat", "type": "User" },
    "head": { "ref": "feature/manual-change", "sha": "def456" },
    "labels": [],
    "merged_at": "2026-01-02T00:00:00Z",
    "body": ""
  }
]
JSON
  exit 0
fi

if [[ "$1" == "api" && "$2" == "repos/acme/project/pulls/1/commits" ]]; then
  cat <<'JSON'
[
  { "commit": { "message": "Implement attribution\\n\\nGenerated with GitHub Copilot" } }
]
JSON
  exit 0
fi

if [[ "$1" == "api" && "$2" == "repos/acme/project/pulls/2/commits" ]]; then
  cat <<'JSON'
[
  { "commit": { "message": "Fix docs" } }
]
JSON
  exit 0
fi

printf 'unexpected gh invocation: %s\\n' "$*" >&2
exit 9
`,
      'utf-8',
    );
    chmodSync(ghScript, 0o755);

    const result = spawnSync(
      'npx',
      [
        'tsx',
        'tools/measure-repo-attribution.ts',
        '--repos-file',
        reposFile,
        '--limit',
        '2',
        '--output',
        outputFile,
        '--json',
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf-8',
        env: {
          ...process.env,
          GH_CALL_LOG: callLog,
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');

    const stdoutReport = JSON.parse(result.stdout);
    const fileReport = JSON.parse(readFileSync(outputFile, 'utf-8'));
    assert.deepEqual(fileReport, stdoutReport);

    assert.equal(stdoutReport.schemaVersion, 2);
    assert.equal(stdoutReport.sampleLimit, 2);
    assert.equal(stdoutReport.repositories.length, 1);
    assert.equal(stdoutReport.repositories[0].repo, 'acme/project');
    assert.equal(stdoutReport.repositories[0].sampledMergedPrs, 2);
    assert.equal(stdoutReport.repositories[0].pullRequests.length, 2);
    assert.equal(stdoutReport.repositories[0].pullRequests[0].agentAuthored.value, 'agent');
    assert.equal(stdoutReport.repositories[0].pullRequests[0].harness.value, 'github-copilot');
    assert.equal(stdoutReport.repositories[0].pullRequests[1].agentAuthored.value, 'unknown');
    assert.equal(stdoutReport.repositories[0].coverage.union, 50);

    const calls = readFileSync(callLog, 'utf-8').trim().split('\n');
    assert.equal(calls[0], 'auth status');
    assert(calls.some((call) => call.startsWith('api repos/acme/project/pulls ')));
    assert(calls.includes('api repos/acme/project/pulls/1/commits --method GET -f per_page=100 -f page=1'));
    assert(calls.includes('api repos/acme/project/pulls/2/commits --method GET -f per_page=100 -f page=1'));
  });
});
