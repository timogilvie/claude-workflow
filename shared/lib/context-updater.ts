import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callClaude } from './llm-cli.ts';
import { extractKeyFiles, readContextSpec } from './context-tool.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Read the current source contents for the subsystem's key files.
 */
export function readSourceFiles(files: string[], repoDir: string, maxSize = 30000): string {
  const contents: string[] = [];

  for (const file of files) {
    const fullPath = join(repoDir, file);
    if (!existsSync(fullPath)) {
      contents.push(`// File not found: ${file}`);
      continue;
    }

    try {
      const content = readFileSync(fullPath, 'utf-8');
      contents.push(`// File: ${file}\n${content}\n`);
    } catch (error) {
      contents.push(`// Error reading ${file}: ${error}`);
    }
  }

  const combined = contents.join('\n\n');
  return combined.length > maxSize ? combined.substring(0, maxSize) + '\n\n// ... (truncated)' : combined;
}

/**
 * Collect recent git history touching the subsystem's key files.
 */
export function getRecentChanges(files: string[], repoDir: string): string {
  try {
    const fileList = files.map((file) => `'${file}'`).join(' ');
    const cmd = `git log --oneline --since="30 days ago" -- ${fileList} | head -10`;
    const output = execSync(cmd, { cwd: repoDir, encoding: 'utf-8' }).trim();
    return output || '*(No recent changes)*';
  } catch {
    return '*(Unable to fetch git history)*';
  }
}

/**
 * Generate an updated subsystem spec using the current spec, source, and git history.
 */
export async function generateUpdatedSpec(opts: {
  subsystemId: string;
  currentSpec: string;
  sourceFiles: string;
  recentChanges: string;
}): Promise<string> {
  const promptPath = join(__dirname, '../../tools/prompts/subsystem-manual-update-template.md');

  let prompt: string;
  if (existsSync(promptPath)) {
    const promptTemplate = readFileSync(promptPath, 'utf-8');
    const timestamp = new Date().toISOString();
    prompt = promptTemplate
      .replace('{SUBSYSTEM_ID}', opts.subsystemId)
      .replace('{CURRENT_SPEC}', opts.currentSpec)
      .replace('{SOURCE_FILES}', opts.sourceFiles)
      .replace('{RECENT_CHANGES}', opts.recentChanges)
      .replace(/{TIMESTAMP}/g, timestamp);
  } else {
    const timestamp = new Date().toISOString();
    prompt = `
You are updating a subsystem specification document.

**Subsystem ID:** ${opts.subsystemId}
**Task:** Generate an updated version of the subsystem spec based on current source files.

**Current Spec:**
\`\`\`markdown
${opts.currentSpec}
\`\`\`

**Current Source Files:**
\`\`\`
${opts.sourceFiles}
\`\`\`

**Recent Git Changes:**
${opts.recentChanges}

**Instructions:**
1. Preserve the exact structure and section headings from the current spec
2. Update the "Last updated" timestamp to: ${timestamp}
3. Review source files and update the spec to reflect current implementation
4. Update "Architectural Constraints" (DO/DON'T) based on patterns in source
5. Update "Known Failure Modes" if you see error handling patterns
6. Add recent changes to the "Recent Changes" section
7. Preserve any manual edits in the spec (look for non-templated content)
8. Keep the spec concise and machine-readable (prefer tables/lists over prose)

**Output only the updated markdown spec. No preamble, no explanation.**
`;
  }

  const claudeCmd = process.env.CLAUDE_CMD || 'claude';
  const result = await callClaude(prompt, {
    mode: 'stream',
    cliCmd: claudeCmd,
    cliFlags: [
      '--tools', '',
      '--append-system-prompt',
      'You have NO tools available. Output ONLY the updated subsystem spec markdown. No conversational text, no preamble, no XML tags. Start directly with the heading.',
    ],
  });

  return result.text;
}

/**
 * Print a unified diff of the current and proposed subsystem specs.
 */
export function showSpecDiff(current: string, updated: string): void {
  const currentPath = '/tmp/context-update-current.md';
  const updatedPath = '/tmp/context-update-updated.md';

  writeFileSync(currentPath, current, 'utf-8');
  writeFileSync(updatedPath, updated, 'utf-8');

  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('DIFF: Current vs. Updated Spec');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');

  try {
    execSync(`diff -u ${currentPath} ${updatedPath} || true`, { stdio: 'inherit' });
  } catch {
    // diff returns non-zero when files differ, ignore.
  }

  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');
}

/**
 * Prompt the user to confirm whether the generated update should be applied.
 */
export async function confirmUpdate(message: string): Promise<boolean> {
  console.log(message);
  process.stdout.write('Apply this update? [y/N] ');

  return new Promise((resolve) => {
    process.stdin.once('data', (data) => {
      const response = data.toString().trim().toLowerCase();
      resolve(response === 'y' || response === 'yes');
    });
  });
}

/**
 * Update a subsystem context spec end-to-end.
 */
export async function updateSubsystemContext(
  subsystemId: string,
  repoDir: string,
  options: { noConfirm: boolean },
): Promise<void> {
  console.log(`Updating subsystem: ${subsystemId}`);
  console.log(`Repository: ${repoDir}`);

  console.log('Reading current spec...');
  const { specPath, content: currentSpec } = readContextSpec(repoDir, subsystemId);

  const keyFiles = extractKeyFiles(currentSpec);
  console.log(`Found ${keyFiles.length} key file(s) in spec`);

  if (keyFiles.length === 0) {
    console.error('Error: No key files found in spec');
    process.exit(1);
  }

  console.log('Reading source files...');
  const sourceFiles = readSourceFiles(keyFiles, repoDir);

  console.log('Analyzing recent changes...');
  const recentChanges = getRecentChanges(keyFiles, repoDir);

  console.log('Generating updated spec (using LLM)...');
  const updatedSpec = await generateUpdatedSpec({
    subsystemId,
    currentSpec,
    sourceFiles,
    recentChanges,
  });

  if (!options.noConfirm) {
    showSpecDiff(currentSpec, updatedSpec);

    const approved = await confirmUpdate('Review the diff above.');
    if (!approved) {
      console.log('Update cancelled.');
      process.exit(0);
    }
  }

  console.log('Writing updated spec...');
  writeFileSync(specPath, updatedSpec, 'utf-8');

  console.log('✓ Subsystem spec updated successfully');
  console.log(`  ${specPath}`);
}
