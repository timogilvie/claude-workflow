import type { DriftFinding, DriftReport } from './ci-contract-drift-detector.ts';

export type DriftProposalAction =
  | 'ADD'
  | 'UPDATE'
  | 'MARK_REMOTE_ONLY'
  | 'REMOVE';

export interface DriftProposalChange {
  action: DriftProposalAction;
  checkName: string;
  type?: 'workflow' | 'remote-only' | 'integration';
  workflowFile?: string;
  workflowJob?: string;
  rationale?: string;
}

export interface DriftProposal {
  timestamp: string;
  repository: string;
  branch: string;
  proposedChanges: DriftProposalChange[];
  nextSteps: string[];
}

export function buildDriftProposal(report: DriftReport): DriftProposal {
  const proposedChanges = report.findings
    .map(changeForFinding)
    .filter((change): change is DriftProposalChange => change !== null);

  return {
    timestamp: new Date().toISOString(),
    repository: report.repository,
    branch: report.branch,
    proposedChanges,
    nextSteps: [
      'Review every proposed change before editing .wavemill-config.json.',
      'For workflow mappings, confirm the local recipe command is the intended equivalent.',
      'For remote-only checks, add a maintainer rationale, acknowledgement email, and acknowledgement date.',
      'Run npx tsx tools/validate-drift.ts again after updating the config.',
    ],
  };
}

function changeForFinding(finding: DriftFinding): DriftProposalChange | null {
  if (finding.state === 'CHECK_MISSING') {
    if (finding.workflowFile && finding.workflowJob) {
      return {
        action: 'ADD',
        checkName: finding.checkName,
        type: 'workflow',
        workflowFile: finding.workflowFile,
        workflowJob: finding.workflowJob,
      };
    }
    return {
      action: 'MARK_REMOTE_ONLY',
      checkName: finding.checkName,
      type: 'remote-only',
      rationale: 'TODO: explain why this enforced check has no safe local equivalent.',
    };
  }

  if (finding.state === 'CHECK_UNMAPPED') {
    return {
      action: 'UPDATE',
      checkName: finding.checkName,
      type: 'remote-only',
      rationale: finding.recipeEntry?.type === 'remote-only'
        ? finding.recipeEntry.rationale
        : undefined,
    };
  }

  if (finding.state === 'WORKFLOW_CHANGED' || finding.state === 'REQUIRES_REVIEW') {
    return {
      action: 'UPDATE',
      checkName: finding.checkName,
      type: finding.recipeEntry?.type,
      workflowFile: finding.workflowFile,
      workflowJob: finding.workflowJob,
    };
  }

  return null;
}
