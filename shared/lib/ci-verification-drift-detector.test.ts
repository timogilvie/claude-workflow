import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectVerificationDrift } from './ci-verification-drift-detector.ts';
import type { GitHubDiscoveryResult } from './github-ci-discovery.ts';
import type { PrePrVerificationConfigSchema } from './config.ts';

function discovery(checks: string[], workflows: GitHubDiscoveryResult['workflows'] = []): GitHubDiscoveryResult {
  return {
    checks,
    source: 'ruleset',
    timestamp: '2026-08-04T12:00:00.000Z',
    workflows,
  };
}

describe('ci-verification-drift-detector', () => {
  it('reports aligned checks when recipe commands map to enforced checks', () => {
    const report = detectVerificationDrift({
      repository: 'acme/widgets',
      discovery: discovery(['Lint Check', 'Unit Tests']),
      config: {
        enabled: true,
        source: 'github-enforced',
        recipe: {
          commands: ['npm run lint', 'npm run test:unit'],
        },
      },
      timestamp: '2026-08-04T12:00:00.000Z',
    });

    assert.equal(report.hasActionableDrift, false);
    assert.deepEqual(report.findings.map((finding) => finding.type), ['aligned', 'aligned']);
  });

  it('flags enforced checks when the recipe is missing', () => {
    const report = detectVerificationDrift({
      repository: 'acme/widgets',
      discovery: discovery(['Type Check']),
      config: {
        enabled: true,
        source: 'github-enforced',
        recipe: { commands: [] },
      },
    });

    assert.equal(report.hasActionableDrift, true);
    assert.equal(report.findings[0].type, 'recipe-missing');
    assert.equal(report.findings[0].requiresAcknowledgement, true);
  });

  it('flags an unmapped enforced check when commands have no safe local equivalent', () => {
    const report = detectVerificationDrift({
      repository: 'acme/widgets',
      discovery: discovery(['Security Scan']),
      config: {
        enabled: true,
        source: 'github-enforced',
        recipe: { commands: ['npm run lint'] },
      },
    });

    assert.equal(report.findings[0].type, 'unmapped-check');
    assert.match(report.findings[0].suggestedFix ?? '', /remote-only exception/);
  });

  it('treats acknowledged remote-only checks as aligned with rationale', () => {
    const report = detectVerificationDrift({
      repository: 'acme/widgets',
      discovery: discovery(['Security Scan']),
      config: {
        enabled: true,
        source: 'github-enforced',
        recipe: { commands: ['npm run lint'] },
        remoteOnlyExceptions: [
          {
            checkName: 'Security Scan',
            reason: 'Requires org secrets unavailable locally',
            acknowledgedBy: 'security@example.com',
            acknowledgedAt: '2026-08-04T12:00:00Z',
          },
        ],
      },
    });

    assert.equal(report.hasActionableDrift, false);
    assert.equal(report.findings[0].type, 'aligned');
    assert.equal(report.findings[0].acknowledged, true);
    assert.match(report.findings[0].reason, /Requires org secrets/);
  });

  it('reports metadata unavailable when GitHub cannot be inspected', () => {
    const report = detectVerificationDrift({
      repository: 'acme/widgets',
      metadataError: 'GitHub API permission denied',
      config: {
        enabled: true,
        source: 'github-enforced',
        recipe: { commands: ['npm test'] },
      },
    });

    assert.equal(report.findings[0].type, 'metadata-unavailable');
    assert.equal(report.hasActionableDrift, true);
  });

  it('requires manual review for ambiguous mappings', () => {
    const report = detectVerificationDrift({
      repository: 'acme/widgets',
      discovery: discovery(['Unit Tests']),
      config: {
        enabled: true,
        source: 'github-enforced',
        recipe: {
          commands: ['npm run test:unit', 'npm run unit:test'],
        },
      },
    });

    assert.equal(report.findings[0].type, 'manual-review');
    assert.equal(report.findings[0].requiresAcknowledgement, true);
  });

  it('reports workflow-changed without executing workflow YAML', () => {
    const config: PrePrVerificationConfigSchema = {
      enabled: true,
      source: 'github-enforced',
      recipe: { commands: ['npm run test:unit'] },
      mappingAcknowledgements: {
        checks: {
          'Unit Tests': {
            localCommand: 'npm run test:unit',
            workflowPath: '.github/workflows/ci.yml',
            jobName: 'unit',
          },
        },
        acknowledgedBy: 'maintainer@example.com',
        acknowledgedAt: '2026-08-04T12:00:00Z',
      },
    };

    const report = detectVerificationDrift({
      repository: 'acme/widgets',
      discovery: discovery(['Unit Tests'], [
        {
          name: 'unit',
          path: '.github/workflows/ci-new.yml',
          triggers: ['pull_request'],
        },
      ]),
      config,
    });

    assert.equal(report.findings[0].type, 'workflow-changed');
    assert.match(report.findings[0].suggestedFix ?? '', /Do not execute arbitrary workflow YAML locally/);
  });

  it('flags local workflow jobs that are not covered by the explicit contract', () => {
    const report = detectVerificationDrift({
      repository: 'acme/widgets',
      discovery: discovery(['Unit Tests']),
      localWorkflowJobs: [
        { jobName: 'Unit Tests', workflowPath: '.github/workflows/ci.yml' },
        { jobName: 'Security Scan', workflowPath: '.github/workflows/ci.yml' },
      ],
      config: {
        enabled: true,
        source: 'explicit',
        recipe: { commands: ['npm run test:unit'] },
      },
    });

    const uncovered = report.findings.find((finding) => finding.type === 'workflow-uncovered');
    assert.equal(uncovered?.checkName, 'Security Scan');
    assert.equal(uncovered?.severity, 'error');
    assert.equal(uncovered?.requiresAcknowledgement, true);
  });

  it('does not flag local workflow jobs allowlisted as non-enforced', () => {
    const report = detectVerificationDrift({
      repository: 'acme/widgets',
      discovery: discovery(['Unit Tests']),
      localWorkflowJobs: [
        { jobName: 'Unit Tests', workflowPath: '.github/workflows/ci.yml' },
        { jobName: 'Aggregate Status', workflowPath: '.github/workflows/ci.yml' },
      ],
      config: {
        enabled: true,
        source: 'explicit',
        recipe: { commands: ['npm run test:unit'] },
        nonEnforcedJobs: ['Aggregate Status'],
      },
    });

    assert.ok(!report.findings.some((finding) => finding.type === 'workflow-uncovered'));
  });
});
