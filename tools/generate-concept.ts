#!/usr/bin/env -S npx tsx
import { runTool } from '../shared/lib/tool-runner.ts';
import { resolveRepoDir } from '../shared/lib/context-tool.ts';
import { generateConceptPage } from '../shared/lib/concept-page-generator.ts';
import { toKebabCase } from '../shared/lib/string-utils.ts';

runTool({
  name: 'generate-concept',
  description: 'Generate a concept page via LLM',
  options: {
    name: { type: 'string', description: 'Human-readable concept name (optional)' },
    subsystems: { type: 'string', description: 'Comma-separated subsystem IDs to include as context' },
    'no-project-context': { type: 'boolean', description: 'Skip including project-context.md' },
    force: { type: 'boolean', description: 'Overwrite existing concept page' },
  },
  positional: {
    name: 'conceptId [repoDir]',
    description: 'Concept ID (kebab-case) and optional repository directory',
    multiple: true,
  },
  examples: [
    'npx tsx tools/generate-concept.ts progressive-disclosure',
    'npx tsx tools/generate-concept.ts task-packet-format --subsystems linear-api,eval-system',
    'npx tsx tools/generate-concept.ts model-routing --name "Model Routing Strategy" --force',
  ],
  async run({ args, positional }) {
    const conceptIdRaw = positional[0];
    if (!conceptIdRaw) {
      throw new Error('Concept ID is required');
    }

    // Convert to kebab-case if needed
    const conceptId = toKebabCase(conceptIdRaw);
    if (conceptId !== conceptIdRaw) {
      console.log(`Note: Converted concept ID to kebab-case: ${conceptId}`);
    }

    const repoDir = resolveRepoDir(positional[1]);
    const subsystemIds = args.subsystems
      ? args.subsystems.split(',').map((s: string) => s.trim())
      : [];

    const result = await generateConceptPage({
      conceptId,
      conceptName: args.name as string | undefined,
      repoDir,
      subsystemIds,
      includeProjectContext: !args['no-project-context'],
      force: args.force as boolean,
    });

    console.log('');
    console.log('Next steps:');
    console.log(`1. Review and edit: ${result.conceptPath}`);
    console.log('2. Commit the concept page to version control');
    console.log(`3. Reference it from subsystem specs using: [Concept Name](concepts/${conceptId}.md)`);
  },
});
