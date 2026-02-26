#!/usr/bin/env -S npx tsx
/**
 * Constraint Parser
 *
 * Parses "Implementation Constraints" section from task packet markdown
 * and extracts structured constraint objects.
 *
 * Classifies constraints as:
 * - "auto-validatable": Can be checked automatically (file patterns, code patterns)
 * - "manual-review": Require human verification (subjective style, complex logic)
 */

export interface Constraint {
  id: string;
  category: 'file' | 'code-style' | 'testing' | 'security' | 'performance' | 'compatibility' | 'other';
  type: 'auto-validatable' | 'manual-review';
  description: string;
  pattern?: string;
  severity: 'error' | 'warning';
}

export interface ConstraintParseResult {
  constraints: Constraint[];
  warnings: string[];
}

/**
 * Parse constraints from task packet markdown
 */
export function parseConstraints(markdown: string): ConstraintParseResult {
  const constraints: Constraint[] = [];
  const warnings: string[] = [];

  // Find "Implementation Constraints" section
  // Match everything from the heading until the next heading (# at start of line) or end of document
  const constraintsSectionMatch = markdown.match(
    /#{1,3}\s*(?:\d+\.\s*)?Implementation Constraints[^\n]*\n([\s\S]*?)(?=\n#|\n---\n|$)/i
  );

  if (!constraintsSectionMatch) {
    warnings.push('No "Implementation Constraints" section found');
    return { constraints, warnings };
  }

  const constraintsText = constraintsSectionMatch[1];

  // Parse by category (Code style, Testing, Security, etc.)
  const categoryPattern = /^[\s-]*([^:]+):\s*(.+)$/gm;
  let match;
  let constraintId = 1;

  while ((match = categoryPattern.exec(constraintsText)) !== null) {
    const categoryRaw = match[1].trim().toLowerCase();
    const description = match[2].trim();

    // Skip empty or placeholder constraints
    if (!description ||
        description === '...' ||
        description === 'N/A' ||
        description === 'TBD' ||
        description === 'TODO' ||
        description.trim() === '') {
      continue;
    }

    const category = mapCategory(categoryRaw);
    const type = classifyConstraint(description);
    const pattern = extractPattern(description);
    const severity = determineSeverity(categoryRaw, description);

    constraints.push({
      id: `CONSTRAINT-${constraintId++}`,
      category,
      type,
      description,
      pattern,
      severity,
    });
  }

  if (constraints.length === 0) {
    warnings.push('No parseable constraints found in section');
  }

  return { constraints, warnings };
}

/**
 * Map category string to standard category
 */
function mapCategory(categoryRaw: string): Constraint['category'] {
  if (categoryRaw.includes('code') || categoryRaw.includes('style')) {
    return 'code-style';
  }
  if (categoryRaw.includes('test')) {
    return 'testing';
  }
  if (categoryRaw.includes('security') || categoryRaw.includes('auth')) {
    return 'security';
  }
  if (categoryRaw.includes('performance') || categoryRaw.includes('perf')) {
    return 'performance';
  }
  if (categoryRaw.includes('compatibility') || categoryRaw.includes('backward')) {
    return 'compatibility';
  }
  if (categoryRaw.includes('file')) {
    return 'file';
  }
  return 'other';
}

/**
 * Classify constraint as auto-validatable or manual-review
 */
function classifyConstraint(description: string): 'auto-validatable' | 'manual-review' {
  const autoPatterns = [
    /don't modify|must not modify|do not change/i,
    /must use|should use|use only/i,
    /must include|should include|must have/i,
    /no .+ allowed|cannot use|must not use/i,
    /file .+ must/i,
    /match pattern/i,
  ];

  // Check if description matches auto-validatable patterns
  for (const pattern of autoPatterns) {
    if (pattern.test(description)) {
      return 'auto-validatable';
    }
  }

  // Subjective constraints require manual review
  const manualPatterns = [
    /follow|adhere to|consistent with/i,
    /maintainable|readable|clean/i,
    /appropriate|reasonable|sensible/i,
  ];

  for (const pattern of manualPatterns) {
    if (pattern.test(description)) {
      return 'manual-review';
    }
  }

  // Default to manual review for ambiguous cases
  return 'manual-review';
}

/**
 * Extract file or code pattern from constraint description
 */
function extractPattern(description: string): string | undefined {
  // File path patterns
  const fileMatch = description.match(/["'`]([^"'`]+\.(ts|js|json|md|tsx|jsx))["'`]/);
  if (fileMatch) {
    return fileMatch[1];
  }

  // Glob patterns
  const globMatch = description.match(/["'`]([^"'`]*\*[^"'`]*)["'`]/);
  if (globMatch) {
    return globMatch[1];
  }

  // Code patterns (e.g., "use async/await")
  const codeMatch = description.match(/use\s+["'`]?([a-zA-Z0-9_\/\-\.]+)["'`]?/i);
  if (codeMatch && codeMatch[1].length < 50) {
    return codeMatch[1];
  }

  return undefined;
}

/**
 * Determine severity based on category and description
 */
function determineSeverity(categoryRaw: string, description: string): 'error' | 'warning' {
  // Security constraints are always errors
  if (categoryRaw.includes('security')) {
    return 'error';
  }

  // "Must" and "required" indicate errors
  if (/must|required|do not|cannot/i.test(description)) {
    return 'error';
  }

  // "Should" and "prefer" indicate warnings
  if (/should|prefer|avoid|consider/i.test(description)) {
    return 'warning';
  }

  // Default to error for safety
  return 'error';
}
