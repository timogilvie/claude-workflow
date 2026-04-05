#!/usr/bin/env -S npx tsx
/**
 * Validate Constraints CLI Tool
 *
 * Usage:
 *   npx tsx tools/validate-constraints.ts <issue-id>
 *   npx tsx tools/validate-constraints.ts HOK-123
 *   npx tsx tools/validate-constraints.ts --issue-id HOK-123
 *
 * Options:
 *   --issue-id <id>    Issue ID to validate constraints for
 *   --no-parallel      Disable parallel rule execution
 *   --help            Show help message
 */

import { runTool } from '../shared/lib/tool-runner.ts';
import { validateConstraints, formatValidationResult } from '../shared/lib/constraint-validator.ts';
import { constraintRulesExist } from '../shared/lib/constraint-storage.ts';

runTool({
  name: 'validate-constraints',
  description: 'Validate constraint rules for a specific Linear issue',
  options: {
    'issue-id': {
      type: 'string',
      description: 'Issue ID to validate constraints for'
    },
    'no-parallel': {
      type: 'boolean',
      description: 'Disable parallel rule execution'
    },
  },
  positional: {
    name: 'issue-id',
    description: 'Issue ID (e.g., HOK-123)',
    required: false, // Can use --issue-id instead
  },
  examples: [
    '# Validate constraints for HOK-123',
    'npx tsx tools/validate-constraints.ts HOK-123',
    '',
    '# Validate with sequential execution',
    'npx tsx tools/validate-constraints.ts HOK-123 --no-parallel',
    '',
    '# Use --issue-id flag',
    'npx tsx tools/validate-constraints.ts --issue-id HOK-123',
  ],
  additionalHelp: `Description:
  Executes constraint validation rules for a specific issue.
  Rules must be generated first using generate-constraint-rules.ts.

  Constraint rules are stored in: constraints/<issue-id>/

Exit Codes:
  0 - All constraints passed (or only manual review required)
  1 - One or more constraints failed`,
  async run({ args, positional }) {
    // Get issue ID from positional arg or --issue-id flag
    const issueId = positional[0] || args['issue-id'];
    const parallel = !args['no-parallel'];

    if (!issueId) {
      throw new Error('Issue ID is required\nProvide as argument or use --issue-id flag\nRun with --help for usage information');
    }

    // Check if constraints exist
    if (!constraintRulesExist(issueId)) {
      throw new Error(`No constraint rules found for issue ${issueId}\n   Expected location: constraints/${issueId}/\n\nDid you generate the rules? Run:\n   npx tsx tools/generate-constraint-rules.ts ${issueId}`);
    }

    // Validate constraints
    console.log(`\n🔍 Validating constraints for ${issueId}...\n`);

    const result = await validateConstraints(issueId, process.cwd(), { parallel });

    // Format and print result
    const formatted = formatValidationResult(result);
    console.log(formatted);

    // Exit with appropriate code
    if (!result.passed) {
      throw new Error('One or more constraints failed');
    }

    // If manual review required but auto-checks passed, exit 0 (success)
    return;
  },
});
