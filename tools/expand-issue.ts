#!/usr/bin/env -S npx tsx
import { runTool, resolvePromptPath } from '../shared/lib/tool-runner.ts';
import { getIssue, updateIssue } from '../shared/lib/linear.ts';
import {
  validateTaskPacket,
  DEFAULT_VALIDATION_CONFIG,
  type ValidationConfig,
  type ValidationResult,
} from '../shared/lib/task-packet-validator.ts';
import { getValidationConfig } from '../shared/lib/config.ts';
import { confirm } from '../shared/lib/cli-prompt.ts';
import {
  parseIssueInput,
  formatIssueContext,
  expandIssueWithClaude,
  checkSubsystemDrift,
} from '../shared/lib/issue-expander.ts';
import { autoLabelIssue } from '../shared/lib/issue-labeler.ts';
import { gatherCodebaseContext } from '../shared/lib/codebase-context-gatherer.ts';
import { splitTaskPacket, isValidTaskPacket, writeTaskPacketArtifacts } from '../shared/lib/task-packet-utils.ts';
import { formatValidationIssues } from '../shared/lib/validation-formatter.ts';
import { loadPromptTemplate } from '../shared/lib/prompt-utils.ts';
import { errorMessage } from '../shared/lib/error-utils.ts';
import { logLinearUpdateError } from '../shared/lib/linear-update-error-log.ts';

runTool({
  name: 'expand-issue',
  description: 'Expand Linear issue into comprehensive task packet',
  options: {
    'no-update': { type: 'boolean', description: 'Skip updating the Linear issue (default: always update)' },
    'skip-validation': { type: 'boolean', description: 'Skip quality gate validation' },
    output: { type: 'string', description: 'Save expanded description to file' },
    'repo-path': { type: 'string', description: 'Path to target repository' },
  },
  positional: {
    name: 'issueId',
    description: 'Linear issue ID (e.g., LIN-123) or URL',
  },
  examples: [
    'npx tsx tools/expand-issue.ts LIN-123',
    'npx tsx tools/expand-issue.ts LIN-123 --no-update',
    'npx tsx tools/expand-issue.ts LIN-123 --output expanded-issue.md',
  ],
  additionalHelp: `Environment Variables:
  LINEAR_API_KEY   Required: Linear API key
  CLAUDE_CMD       Optional: Claude CLI command (default: 'claude')`,
  async run({ args, positional }) {
    const issueInput = positional[0];
    if (!issueInput) {
      throw new Error('Issue ID is required');
    }

    if (!process.env.LINEAR_API_KEY) {
      throw new Error('LINEAR_API_KEY not found in environment');
    }

    const shouldUpdate = !args['no-update'];
    const skipValidation = !!args['skip-validation'];
    const outputFile = args.output as string | null;
    const repoPath = (args['repo-path'] as string) || process.cwd();

    // Parse and fetch issue
    console.log('Fetching issue details...');
    const identifier = parseIssueInput(issueInput);
    const issue = await getIssue(identifier);

    if (!issue) {
      throw new Error(`Issue not found: ${identifier}`);
    }

    console.log(`Found: ${issue.identifier} - ${issue.title}`);
    console.log(`Project: ${issue.project?.name || 'None'}`);
    console.log(`State: ${issue.state?.name}\n`);

    // Load issue-writer prompt
    console.log('Loading issue-writer prompt...');
    const promptPath = resolvePromptPath(import.meta.url, 'issue-writer.md');
    const promptTemplate = await loadPromptTemplate(promptPath);

    // Format issue context
    const issueContext = formatIssueContext(issue);

    // Gather codebase context
    const codebaseContext = await gatherCodebaseContext({
      repoPath,
      issueTitle: issue.title,
      issueDescription: issue.description || '',
    });

    // Check for subsystem drift before expansion
    await checkSubsystemDrift(repoPath, issue.description || '');

    // Expand with Claude
    console.log('Expanding issue with Claude...\n');
    console.log('─'.repeat(80));
    const expandedDescription = await expandIssueWithClaude(
      promptTemplate,
      issueContext,
      codebaseContext
    );
    console.log('─'.repeat(80));
    console.log('\n');

    // Split into header and details
    const { header, details, fullContent } = splitTaskPacket(expandedDescription);
    console.log(`Split task packet: header (${header.length} chars), details (${details.length} chars)\n`);

    // Handle output (don't let file write failure block Linear update)
    if (outputFile) {
      try {
        const artifactPaths = await writeTaskPacketArtifacts(outputFile, {
          header,
          details,
          fullContent,
        });
        console.log(`✓ Header saved to: ${artifactPaths.header}`);
        console.log(`✓ Details saved to: ${artifactPaths.details}`);
        console.log(`✓ Full content saved to: ${artifactPaths.full}`);
      } catch (writeError) {
        const errorMsg = errorMessage(writeError);
        console.warn(`⚠️  Failed to write output files: ${errorMsg}`);
      }
    } else {
      console.log('Expanded Description (Header):\n');
      console.log(header);
      console.log('\n');
      console.log('(Full details available in details section)\n');
    }

    // Validate output before updating Linear (use full content for validation)
    if (!isValidTaskPacket(fullContent)) {
      throw new Error(
        `Claude output is not a valid task packet (missing expected section headers).\n` +
        `  First 200 chars: ${fullContent.substring(0, 200)}\n` +
        `  Skipping Linear update to avoid overwriting with bad content.`
      );
    }

    // Run quality gate validation (unless skipped) - validate full content
    let validationResult: ValidationResult | null = null;
    if (!skipValidation) {
      console.log('\nRunning quality gate validation...');

      const configValidation = getValidationConfig();
      const validationConfig: ValidationConfig = {
        ...DEFAULT_VALIDATION_CONFIG,
        ...configValidation,
        layer1: { ...DEFAULT_VALIDATION_CONFIG.layer1, ...configValidation.layer1 },
        layer2: { ...DEFAULT_VALIDATION_CONFIG.layer2, ...configValidation.layer2 },
      };

      try {
        validationResult = await validateTaskPacket(fullContent, repoPath, validationConfig);

        console.log(formatValidationIssues(validationResult.issues));

        if (!validationResult.passed) {
          console.error('\n❌ Validation FAILED');

          if (shouldUpdate) {
            const isInteractive = process.stdin.isTTY && !process.env.MILL_MODE;

            if (isInteractive) {
              // Ask user whether to proceed
              console.log('\nThe task packet has quality issues that may cause problems for autonomous agents.');
              const proceed = await confirm('Do you want to update Linear anyway?');

              if (!proceed) {
                throw new Error('Cancelled. Fix the issues and try again.');
              } else {
                console.log('⚠️  Proceeding with update despite validation failures...');
              }
            } else {
              // Non-interactive / mill mode: log warning and proceed
              console.warn('\n⚠️  Validation failed but running in non-interactive mode — proceeding with Linear update.');
            }
          } else {
            console.log('\nℹ Dry-run mode (--no-update). Remove --no-update to save to Linear.');
            console.log('  Or use --skip-validation to bypass quality gate.');
          }
        } else {
          console.log('\n✓ Validation PASSED');
        }
      } catch (validationError) {
        const errorMsg = errorMessage(validationError);
        console.warn(`\n⚠️  Validation failed with error: ${errorMsg}`);
        console.warn('   Proceeding without validation...');
      }
    } else {
      console.log('\n⚠️  Skipping validation (--skip-validation flag)');
    }

    // Update Linear if requested (with full content for backward compatibility)
    if (shouldUpdate) {
      try {
        console.log(`Updating Linear issue ${issue.identifier}...`);
        const result = await updateIssue(issue.id, { description: fullContent });

        if (result.success) {
          console.log(`✓ Successfully updated: ${result.issue.url}`);

          // Auto-label the issue based on expanded content
          console.log(`\nAuto-labeling issue ${issue.identifier}...`);
          try {
            await autoLabelIssue(issue.identifier);
          } catch (error) {
            const errorMsg = errorMessage(error);
            console.warn(`⚠️  Auto-labeling failed: ${errorMsg}`);
            console.warn('   Issue was updated but labels were not applied');
          }
        } else {
          throw new Error('Failed to update issue');
        }
      } catch (error) {
        let logPath: string | null = null;

        try {
          logPath = logLinearUpdateError(repoPath, issue.identifier, error, fullContent.length);
        } catch {
          // Logging should never block task packet expansion.
        }

        const errorMsg = errorMessage(error);
        if (logPath) {
          console.warn(`⚠️  Linear update failed for ${issue.identifier}: ${errorMsg} (details logged to ${logPath})`);
        } else {
          console.warn(`⚠️  Linear update failed for ${issue.identifier}: ${errorMsg}`);
        }
        console.warn('   Continuing with local task packet...');
      }
    } else {
      console.log('ℹ Dry-run mode (--no-update). Linear was not updated.');
    }
  },
});
