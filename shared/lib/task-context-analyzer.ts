/**
 * Task context analysis for eval routing and stratification (HOK-774).
 *
 * Extracts task metadata from issue data and PR diffs to enable:
 * - Model routing based on task type and complexity
 * - Stratified evaluation (compare similar task types)
 * - Better understanding of what kinds of tasks succeed/fail
 *
 * @module task-context-analyzer
 */

import type {
  TaskContext,
  TaskType,
  ChangeKind,
  ComplexityBand,
  TaskConstraints,
} from './eval-schema.ts';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

export interface IssueData {
  /** Issue title */
  title?: string;

  /** Issue description/body */
  description?: string;

  /** Issue labels */
  labels?: string[];

  /** Issue identifier (e.g., "HOK-774") */
  identifier?: string;
}

export interface TaskContextAnalysisInput {
  /** Issue data from Linear */
  issue?: IssueData;

  /** PR diff text */
  prDiff?: string;

  /** Number of files touched (from PR analysis) */
  filesTouched?: number;

  /** Lines of code touched (from PR analysis) */
  locTouched?: number;
}

// ────────────────────────────────────────────────────────────────
// Task Type Detection
// ────────────────────────────────────────────────────────────────

const TASK_TYPE_KEYWORDS: Record<TaskType, string[]> = {
  bugfix: ['fix', 'bug', 'issue', 'broken', 'error', 'crash', 'regression'],
  feature: ['add', 'feature', 'implement', 'new', 'create', 'support'],
  refactor: ['refactor', 'cleanup', 'reorganize', 'simplify', 'improve structure'],
  chore: ['chore', 'update', 'upgrade', 'dependency', 'deps', 'maintenance'],
  docs: ['docs', 'documentation', 'readme', 'comment', 'docstring'],
  test: ['test', 'testing', 'coverage', 'spec', 'e2e'],
  infra: ['infra', 'ci', 'cd', 'deploy', 'build', 'pipeline', 'docker', 'k8s'],
};

/**
 * Infer task type from issue title, description, and labels.
 *
 * Strategy:
 * 1. Check labels for explicit type markers (e.g., "bug", "feature")
 * 2. Check title for type keywords
 * 3. Check description for type keywords
 * 4. Default to "feature" if ambiguous
 */
export function inferTaskType(issue?: IssueData): TaskType {
  if (!issue) return 'feature';

  const text = `${issue.title || ''} ${issue.description || ''}`.toLowerCase();
  const labels = (issue.labels || []).map((l) => l.toLowerCase());

  // Check labels first (most explicit)
  for (const [type, keywords] of Object.entries(TASK_TYPE_KEYWORDS)) {
    if (labels.some((label) => keywords.includes(label))) {
      return type as TaskType;
    }
  }

  // Check text for keywords (weighted by position in title vs description)
  const scores: Record<TaskType, number> = {
    bugfix: 0,
    feature: 0,
    refactor: 0,
    chore: 0,
    docs: 0,
    test: 0,
    infra: 0,
  };

  const titleText = (issue.title || '').toLowerCase();
  const descText = (issue.description || '').toLowerCase();

  for (const [type, keywords] of Object.entries(TASK_TYPE_KEYWORDS)) {
    const taskType = type as TaskType;
    for (const keyword of keywords) {
      // Title matches weighted higher
      if (titleText.includes(keyword)) {
        scores[taskType] += 3;
      }
      // Description matches weighted lower
      if (descText.includes(keyword)) {
        scores[taskType] += 1;
      }
    }
  }

  // Return highest scoring type, or "feature" if no matches
  const entries = Object.entries(scores) as Array<[TaskType, number]>;
  const sorted = entries.sort((a, b) => b[1] - a[1]);
  return sorted[0][1] > 0 ? sorted[0][0] : 'feature';
}

// ────────────────────────────────────────────────────────────────
// Change Kind Detection
// ────────────────────────────────────────────────────────────────

/**
 * Infer change kind from PR diff.
 *
 * Strategy:
 * - If no diff, default to "modify_existing"
 * - Count new files vs modified files from diff headers
 * - If only new files: "create_new"
 * - If only modified files: "modify_existing"
 * - If both: "mixed"
 */
export function inferChangeKind(prDiff?: string): ChangeKind {
  if (!prDiff || prDiff.trim().length === 0) {
    return 'modify_existing';
  }

  const lines = prDiff.split('\n');
  let newFiles = 0;
  let modifiedFiles = 0;

  for (const line of lines) {
    // Look for git diff headers indicating new files
    if (line.startsWith('diff --git')) {
      // Check if next few lines indicate a new file
      const nextLineIdx = lines.indexOf(line) + 1;
      if (nextLineIdx < lines.length) {
        const nextLine = lines[nextLineIdx];
        // "new file mode" indicates a new file
        if (nextLine && nextLine.includes('new file mode')) {
          newFiles++;
        } else {
          modifiedFiles++;
        }
      }
    }
  }

  // Classify based on file counts
  if (newFiles === 0 && modifiedFiles === 0) {
    return 'modify_existing'; // No clear signal
  }
  if (newFiles > 0 && modifiedFiles === 0) {
    return 'create_new';
  }
  if (newFiles === 0 && modifiedFiles > 0) {
    return 'modify_existing';
  }
  return 'mixed';
}

// ────────────────────────────────────────────────────────────────
// Complexity Estimation
// ────────────────────────────────────────────────────────────────

const COMPLEXITY_KEYWORDS = {
  high: ['complex', 'refactor', 'migration', 'breaking', 'architecture'],
  low: ['simple', 'trivial', 'typo', 'minor', 'small'],
};

/**
 * Estimate task complexity from multiple signals.
 *
 * Factors:
 * - LOC touched (primary signal)
 * - Files touched
 * - Keywords in issue description
 * - Task type (infra/refactor typically more complex)
 *
 * Returns a band: xs, s, m, l, xl
 */
export function estimateComplexity(input: {
  locTouched?: number;
  filesTouched?: number;
  issue?: IssueData;
  taskType?: TaskType;
}): ComplexityBand {
  const { locTouched = 0, filesTouched = 0, issue, taskType } = input;

  // Base score from LOC and files
  let score = 0;

  // LOC scoring (0-40 points)
  if (locTouched < 10) score += 5;
  else if (locTouched < 50) score += 10;
  else if (locTouched < 200) score += 20;
  else if (locTouched < 500) score += 30;
  else score += 40;

  // Files scoring (0-30 points)
  if (filesTouched < 2) score += 5;
  else if (filesTouched < 5) score += 10;
  else if (filesTouched < 10) score += 20;
  else score += 30;

  // Task type scoring (0-15 points)
  if (taskType === 'infra' || taskType === 'refactor') {
    score += 15;
  } else if (taskType === 'feature') {
    score += 10;
  } else if (taskType === 'docs' || taskType === 'test') {
    score += 5;
  }

  // Keyword modifiers (±15 points)
  if (issue) {
    const text = `${issue.title || ''} ${issue.description || ''}`.toLowerCase();
    for (const keyword of COMPLEXITY_KEYWORDS.high) {
      if (text.includes(keyword)) {
        score += 5;
        break;
      }
    }
    for (const keyword of COMPLEXITY_KEYWORDS.low) {
      if (text.includes(keyword)) {
        score -= 10;
        break;
      }
    }
  }

  // Map score to band
  // xs: 0-15, s: 16-30, m: 31-50, l: 51-70, xl: 71+
  if (score <= 15) return 'xs';
  if (score <= 30) return 's';
  if (score <= 50) return 'm';
  if (score <= 70) return 'l';
  return 'xl';
}

// ────────────────────────────────────────────────────────────────
// Constraints Detection
// ────────────────────────────────────────────────────────────────

const CONSTRAINT_KEYWORDS = {
  hasStrictStyle: ['strict style', 'style guide', 'lint', 'formatting rules'],
  mustNotTouchX: ['must not touch', 'do not modify', 'leave unchanged', 'avoid changing'],
  timeboxed: ['deadline', 'timebox', 'urgent', 'asap', 'time-sensitive'],
  noNetAccess: ['offline', 'no network', 'no internet', 'air-gapped'],
};

/**
 * Extract task constraints from issue description.
 */
export function extractConstraints(issue?: IssueData): TaskConstraints {
  if (!issue) return {};

  const text = `${issue.title || ''} ${issue.description || ''}`.toLowerCase();
  const constraints: TaskConstraints = {};

  for (const [key, keywords] of Object.entries(CONSTRAINT_KEYWORDS)) {
    for (const keyword of keywords) {
      if (text.includes(keyword)) {
        constraints[key as keyof TaskConstraints] = true;
        break;
      }
    }
  }

  return Object.keys(constraints).length > 0 ? constraints : undefined;
}

// ────────────────────────────────────────────────────────────────
// Estimates
// ────────────────────────────────────────────────────────────────

const ESTIMATE_PATTERNS = {
  files: /(\d+)\s*files?/i,
  loc: /(\d+)\s*(lines?|loc)/i,
};

/**
 * Extract file/LOC estimates from issue description.
 *
 * Returns undefined if no estimates found.
 */
export function extractEstimates(
  issue?: IssueData
): { filesTouchedEstimate?: number; expectedLoCChange?: number } {
  if (!issue || !issue.description) return {};

  const text = issue.description;
  const result: { filesTouchedEstimate?: number; expectedLoCChange?: number } = {};

  // Extract files estimate
  const filesMatch = text.match(ESTIMATE_PATTERNS.files);
  if (filesMatch) {
    result.filesTouchedEstimate = parseInt(filesMatch[1], 10);
  }

  // Extract LOC estimate
  const locMatch = text.match(ESTIMATE_PATTERNS.loc);
  if (locMatch) {
    result.expectedLoCChange = parseInt(locMatch[1], 10);
  }

  return result;
}

// ────────────────────────────────────────────────────────────────
// Domain Knowledge Detection
// ────────────────────────────────────────────────────────────────

const DOMAIN_KEYWORDS = [
  'payment',
  'payments',
  'auth',
  'authentication',
  'authorization',
  'k8s',
  'kubernetes',
  'docker',
  'terraform',
  'aws',
  'gcp',
  'azure',
  'database',
  'sql',
  'postgres',
  'redis',
  'graphql',
  'grpc',
  'security',
  'crypto',
  'encryption',
];

/**
 * Detect if task requires domain-specific knowledge.
 *
 * Returns the domain name if detected, true if generic domain knowledge needed,
 * false if no special knowledge required.
 */
export function detectDomainKnowledge(issue?: IssueData): string | boolean {
  if (!issue) return false;

  const text = `${issue.title || ''} ${issue.description || ''}`.toLowerCase();

  // Check for specific domains
  for (const domain of DOMAIN_KEYWORDS) {
    if (text.includes(domain)) {
      return domain;
    }
  }

  // Check for generic markers
  if (
    text.includes('specialized') ||
    text.includes('domain knowledge') ||
    text.includes('expert')
  ) {
    return true;
  }

  return false;
}

// ────────────────────────────────────────────────────────────────
// Main Analysis Function
// ────────────────────────────────────────────────────────────────

/**
 * Analyze task context from issue data and PR diff.
 *
 * This is the main entry point for task context analysis.
 */
export function analyzeTaskContext(input: TaskContextAnalysisInput): TaskContext {
  const { issue, prDiff, filesTouched, locTouched } = input;

  const taskType = inferTaskType(issue);
  const changeKind = inferChangeKind(prDiff);
  const complexity = estimateComplexity({ locTouched, filesTouched, issue, taskType });
  const constraints = extractConstraints(issue);
  const estimates = extractEstimates(issue);
  const requiresDomainKnowledge = detectDomainKnowledge(issue);

  return {
    taskType,
    changeKind,
    complexity,
    ...(constraints && { constraints }),
    ...estimates,
    ...(requiresDomainKnowledge !== false && { requiresDomainKnowledge }),
  };
}
