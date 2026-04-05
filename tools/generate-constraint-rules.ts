#!/usr/bin/env -S npx tsx
import { runTool } from '../shared/lib/tool-runner.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseConstraints } from '../shared/lib/constraint-parser.ts';
import { generateRules } from '../shared/lib/rule-generator.ts';
import { saveConstraintRules, constraintRulesExist } from '../shared/lib/constraint-storage.ts';
import { toKebabCase } from '../shared/lib/string-utils.ts';
import { errorMessage } from '../shared/lib/error-utils.ts';

async function generateConstraintRules(issueId: string, taskPacketPath: string | null, force: boolean) {
  if (!issueId) {
    throw new Error('Issue ID is required');
  }

  // Check if rules already exist
  if (constraintRulesExist(issueId) && !force) {
    throw new Error(
      `Constraint rules already exist for ${issueId}\n` +
      `   Location: constraints/${issueId}/\n` +
      `Use --force to overwrite existing rules`
    );
  }

  // Determine task packet path
  if (!taskPacketPath) {
    // Try to find task packet in standard locations
    const possiblePaths = [
      `features/${issueId.toLowerCase()}/selected-task.json`,
      `features/${toKebabCase(issueId)}/selected-task.json`,
      `features/${issueId}/task-packet.md`,
      `bugs/${issueId}/selected-task.json`,
    ];

    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        const content = fs.readFileSync(p, 'utf-8');
        try {
          const json = JSON.parse(content);
          if (json.description) {
            taskPacketPath = p;
            console.log(`📄 Found task packet: ${taskPacketPath}`);
            break;
          }
        } catch {
          // Not JSON, might be markdown
          if (p.endsWith('.md')) {
            taskPacketPath = p;
            console.log(`📄 Found task packet: ${taskPacketPath}`);
            break;
          }
        }
      }
    }

    if (!taskPacketPath) {
      const searched = possiblePaths.map(p => `     - ${p}`).join('\n');
      throw new Error(
        `Could not find task packet for ${issueId}\n` +
        `   Searched locations:\n${searched}\n` +
        `\nSpecify path explicitly with --file option`
      );
    }
  }

  // Read task packet
  let taskPacketContent: string;
  try {
    const content = fs.readFileSync(taskPacketPath, 'utf-8');

    // If JSON, extract description field
    try {
      const json = JSON.parse(content);
      taskPacketContent = json.description || content;
    } catch {
      // Not JSON, use as-is
      taskPacketContent = content;
    }
  } catch (error) {
    throw new Error(`Error reading task packet: ${errorMessage(error)}`);
  }

  // Parse constraints
  console.log(`\n🔍 Parsing constraints from task packet...`);
  const parseResult = parseConstraints(taskPacketContent);

  if (parseResult.warnings.length > 0) {
    console.log(`\n⚠️  Warnings:`);
    parseResult.warnings.forEach(w => console.log(`   - ${w}`));
  }

  if (parseResult.constraints.length === 0) {
    throw new Error(
      `No constraints found in task packet\n` +
      `   Make sure the task packet includes an "Implementation Constraints" section`
    );
  }

  console.log(`\n✓ Found ${parseResult.constraints.length} constraints:`);
  parseResult.constraints.forEach(c => {
    console.log(`   - ${c.id}: ${c.description.substring(0, 60)}${c.description.length > 60 ? '...' : ''}`);
  });

  // Generate rules
  console.log(`\n⚙️  Generating constraint rules...`);
  const ruleGenResult = generateRules(parseResult.constraints, issueId, taskPacketContent);

  console.log(`\n✓ Generated ${ruleGenResult.rules.length} auto-validatable rules`);
  if (ruleGenResult.manualReviewConstraints.length > 0) {
    console.log(`✓ ${ruleGenResult.manualReviewConstraints.length} constraints require manual review`);
  }

  // Save rules
  console.log(`\n💾 Saving rules to constraints/${issueId}/...`);
  const savedPath = saveConstraintRules(issueId, ruleGenResult);

  console.log(`\n✅ Constraint rules generated successfully!`);
  console.log(`\n📁 Location: ${savedPath}/`);
  console.log(`   - ${ruleGenResult.rules.length} executable rules in rules/`);
  console.log(`   - metadata.json`);
  if (ruleGenResult.manualReviewConstraints.length > 0) {
    console.log(`   - manual-review.md (${ruleGenResult.manualReviewConstraints.length} constraints)`);
  }

  console.log(`\n🔍 To validate constraints, run:`);
  console.log(`   npx tsx tools/validate-constraints.ts ${issueId}\n`);
}

runTool({
  name: 'generate-constraint-rules',
  description: 'Generate executable constraint validation rules',
  options: {
    'issue-id': { type: 'string', description: 'Issue ID for the constraints' },
    file: { type: 'string', description: 'Path to task packet or plan markdown file' },
    'task-packet': { type: 'string', description: 'Alias for --file' },
    force: { type: 'boolean', description: 'Overwrite existing constraint rules' },
  },
  positional: {
    name: 'issueId',
    description: 'Issue ID (e.g., HOK-123)',
  },
  examples: [
    'npx tsx tools/generate-constraint-rules.ts HOK-123',
    'npx tsx tools/generate-constraint-rules.ts HOK-123 --file features/my-feature/plan.md',
    'npx tsx tools/generate-constraint-rules.ts HOK-123 --force',
  ],
  additionalHelp: `Parses "Implementation Constraints" section from task packets or plans
and generates executable validation rules. Rules are saved to version
control in constraints/<issue-id>/ directory.

Auto-validatable constraints become Node.js scripts that check the code.
Manual-review constraints are documented in manual-review.md.

Rules are generated at plan creation time and validated before PR creation.`,
  async run({ args, positional }) {
    const issueId = positional[0] || (args['issue-id'] as string);
    const taskPacketPath = (args.file as string) || (args['task-packet'] as string) || null;
    const force = !!args.force;
    await generateConstraintRules(issueId, taskPacketPath, force);
  },
});
