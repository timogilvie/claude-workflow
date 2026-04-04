import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BOLD, CYAN, DIM, GREEN, NC, RED, YELLOW } from './colors.ts';
import type { ReviewFinding, ReviewResult } from './review-engine.ts';
import type { ReviewLogFormat } from './review-progress.ts';

/**
 * Validate the review progress log format argument.
 */
export function parseLogFormat(value: string | undefined): ReviewLogFormat {
  if (!value || value === 'text') {
    return 'text';
  }
  if (value === 'json') {
    return 'json';
  }
  throw new Error(`Invalid --log-format value: ${value}. Expected "text" or "json".`);
}

/**
 * Format review findings grouped by severity.
 */
export function formatFindings(findings: ReviewResult['codeReviewFindings'], title: string): string {
  if (!findings || findings.length === 0) {
    return `${title}: None`;
  }

  const blockers = findings.filter((finding) => finding.severity === 'blocker');
  const warnings = findings.filter((finding) => finding.severity === 'warning');

  const lines: string[] = [];
  lines.push(`${BOLD}${title}${NC}`);

  if (blockers.length > 0) {
    lines.push(`  ${RED}${BOLD}Blockers: ${blockers.length}${NC}`);
    blockers.forEach((finding, index) => {
      lines.push(`    ${RED}${index + 1}.${NC} ${BOLD}[${finding.category}]${NC} ${DIM}${finding.location}${NC}`);
      lines.push(`       ${finding.description}`);
    });
  }

  if (warnings.length > 0) {
    lines.push(`  ${YELLOW}${BOLD}Warnings: ${warnings.length}${NC}`);
    warnings.forEach((finding, index) => {
      lines.push(`    ${YELLOW}${index + 1}.${NC} ${BOLD}[${finding.category}]${NC} ${DIM}${finding.location}${NC}`);
      lines.push(`       ${finding.description}`);
    });
  }

  return lines.join('\n');
}

/**
 * Format the local review-changes result for terminal output.
 */
export function formatReviewResult(result: ReviewResult, verbose: boolean): string {
  const lines: string[] = [];

  lines.push('');
  lines.push(`${BOLD}${CYAN}${'═'.repeat(63)}${NC}`);
  lines.push(`${BOLD}${CYAN}  CODE REVIEW RESULTS${NC}`);
  lines.push(`${BOLD}${CYAN}${'═'.repeat(63)}${NC}`);
  lines.push('');

  const verdictColor = result.verdict === 'ready' ? GREEN : RED;
  const verdictText = result.verdict === 'ready' ? 'READY ✓' : 'NOT READY ✗';
  lines.push(`  ${BOLD}Verdict:${NC} ${verdictColor}${BOLD}${verdictText}${NC}`);
  lines.push('');

  if (result.metadata) {
    lines.push(`  ${DIM}Branch:${NC}  ${result.metadata.branch}`);
    lines.push(`  ${DIM}Files:${NC}   ${result.metadata.files.length} changed`);
    if (result.metadata.hasUiChanges) {
      lines.push(`  ${DIM}UI:${NC}      Changes detected`);
    }
    if (result.metadata.designContextAvailable) {
      const uiStatus = result.metadata.uiVerificationRun ? 'verified' : 'skipped';
      lines.push(`  ${DIM}Design:${NC}  Context available (${uiStatus})`);
    }
    lines.push('');
  }

  lines.push(formatFindings(result.codeReviewFindings, 'Code Review'));
  lines.push('');

  if (result.uiFindings && result.uiFindings.length > 0) {
    lines.push(formatFindings(result.uiFindings, 'UI Review'));
    lines.push('');
  }

  if (verbose) {
    lines.push(`${BOLD}Full Result (JSON):${NC}`);
    lines.push(JSON.stringify(result, null, 2));
    lines.push('');
  }

  lines.push(`${BOLD}${CYAN}${'═'.repeat(63)}${NC}`);
  lines.push('');

  return lines.join('\n');
}

/**
 * Format reviewer persona attribution for PR review findings.
 */
export function formatPersonaAttribution(finding: ReviewFinding): string {
  if (!finding.reviewers || finding.reviewers.length === 0) {
    return '';
  }

  if (finding.reviewers.length === 1) {
    return ` ${DIM}[${finding.reviewers[0]}]${NC}`;
  }

  return ` ${DIM}[${finding.reviewers.join(', ')}]${NC}`;
}

/**
 * Display PR review results with a plan-compliance breakdown.
 */
export function displayPrReviewResults(result: ReviewResult, prNumber: number, prTitle: string): void {
  console.log('\n' + '='.repeat(80));
  console.log(`PR #${prNumber}: ${prTitle}`);
  console.log('='.repeat(80) + '\n');

  if (result.verdict === 'ready') {
    console.log(`✅ ${GREEN}READY TO MERGE${NC} - No blocking issues found\n`);
  } else {
    console.log(`❌ ${RED}NOT READY${NC} - Blocking issues must be addressed\n`);
  }

  const planComplianceFindings = result.codeReviewFindings.filter((finding) => finding.category === 'plan_compliance');
  const otherCodeFindings = result.codeReviewFindings.filter((finding) => finding.category !== 'plan_compliance');

  const codeBlockers = otherCodeFindings.filter((finding) => finding.severity === 'blocker');
  const codeWarnings = otherCodeFindings.filter((finding) => finding.severity === 'warning');
  const planBlockers = planComplianceFindings.filter((finding) => finding.severity === 'blocker');
  const planWarnings = planComplianceFindings.filter((finding) => finding.severity === 'warning');
  const uiBlockers = result.uiFindings?.filter((finding) => finding.severity === 'blocker') || [];
  const uiWarnings = result.uiFindings?.filter((finding) => finding.severity === 'warning') || [];

  const totalBlockers = codeBlockers.length + planBlockers.length + uiBlockers.length;
  const totalWarnings = codeWarnings.length + planWarnings.length + uiWarnings.length;

  console.log(`📊 ${BOLD}Summary${NC}`);
  console.log(`   Blockers: ${totalBlockers}`);
  console.log(`   Warnings: ${totalWarnings}`);
  console.log('');

  if (otherCodeFindings.length > 0) {
    console.log(`💻 ${BOLD}Code Review Findings${NC}\n`);

    if (codeBlockers.length > 0) {
      console.log(`  ${RED}🚫 BLOCKERS${NC}\n`);
      codeBlockers.forEach((finding, index) => {
        const personaStr = formatPersonaAttribution(finding);
        console.log(`  ${index + 1}. ${RED}${finding.location}${NC} [${finding.category}]${personaStr}`);
        console.log(`     ${finding.description}\n`);
      });
    }

    if (codeWarnings.length > 0) {
      console.log(`  ${YELLOW}⚠️  WARNINGS${NC}\n`);
      codeWarnings.forEach((finding, index) => {
        const personaStr = formatPersonaAttribution(finding);
        console.log(`  ${index + 1}. ${YELLOW}${finding.location}${NC} [${finding.category}]${personaStr}`);
        console.log(`     ${finding.description}\n`);
      });
    }
  } else {
    console.log(`💻 ${BOLD}Code Review${NC}`);
    console.log(`   ${GREEN}✓${NC} No issues found\n`);
  }

  if (planComplianceFindings.length > 0) {
    console.log(`📋 ${BOLD}Plan Compliance${NC}\n`);

    if (planBlockers.length > 0) {
      console.log(`  ${RED}🚫 BLOCKERS${NC}\n`);
      planBlockers.forEach((finding, index) => {
        const personaStr = formatPersonaAttribution(finding);
        console.log(`  ${index + 1}. ${RED}${finding.location}${NC}${personaStr}`);
        console.log(`     ${finding.description}\n`);
      });
    }

    if (planWarnings.length > 0) {
      console.log(`  ${YELLOW}⚠️  WARNINGS${NC}\n`);
      planWarnings.forEach((finding, index) => {
        const personaStr = formatPersonaAttribution(finding);
        console.log(`  ${index + 1}. ${YELLOW}${finding.location}${NC}${personaStr}`);
        console.log(`     ${finding.description}\n`);
      });
    }
  }

  if (result.uiFindings && result.uiFindings.length > 0) {
    console.log(`🎨 ${BOLD}UI Review Findings${NC}\n`);

    if (uiBlockers.length > 0) {
      console.log(`  ${RED}🚫 BLOCKERS${NC}\n`);
      uiBlockers.forEach((finding, index) => {
        const personaStr = formatPersonaAttribution(finding);
        console.log(`  ${index + 1}. ${RED}${finding.location}${NC} [${finding.category}]${personaStr}`);
        console.log(`     ${finding.description}\n`);
      });
    }

    if (uiWarnings.length > 0) {
      console.log(`  ${YELLOW}⚠️  WARNINGS${NC}\n`);
      uiWarnings.forEach((finding, index) => {
        const personaStr = formatPersonaAttribution(finding);
        console.log(`  ${index + 1}. ${YELLOW}${finding.location}${NC} [${finding.category}]${personaStr}`);
        console.log(`     ${finding.description}\n`);
      });
    }
  }

  console.log('='.repeat(80) + '\n');
}

/**
 * Auto-detect the review base commit from the task metadata for the current branch.
 */
export function detectSinceCommit(branchName: string, repoDir: string, verbose: boolean): string | undefined {
  const match = branchName.match(/^(?:task|feature|bugfix|bug)\/(.+)$/);
  if (!match) return undefined;

  const slug = match[1];
  for (const dir of ['features', 'bugs']) {
    const taskPath = join(repoDir, dir, slug, 'selected-task.json');
    if (existsSync(taskPath)) {
      try {
        const task = JSON.parse(readFileSync(taskPath, 'utf-8'));
        if (task.reviewBaseCommit) {
          if (verbose) {
            console.error(`Auto-detected sinceCommit from ${taskPath}: ${task.reviewBaseCommit.slice(0, 8)}`);
          }
          return task.reviewBaseCommit;
        }
      } catch {
        // Ignore parse errors.
      }
    }
  }

  return undefined;
}
