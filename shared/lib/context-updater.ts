import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callHeadlessLLM } from './headless-llm.ts';
import { confirm } from './cli-prompt.ts';
import { extractKeyFiles, readContextSpec } from './context-tool.ts';
import { execFileCommand, execShellCommand } from './shell-utils.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Read and concatenate source files referenced by a subsystem spec.
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
 * Get a short recent git history summary for subsystem files.
 */
export function getRecentChanges(files: string[], repoDir: string): string {
  if (files.length === 0) return '*(No recent changes)*';

  try {
    // Pass each path as its own argv element after `--` so paths with spaces,
    // parentheses, quotes, brackets, or glob characters remain literal Git
    // pathspecs. Truncate to 10 lines in TypeScript instead of piping to
    // `head -10`, which would require a shell.
    const args = ['log', '--oneline', '--since=30 days ago', '--', ...files];
    const output = execFileCommand('git', args, { cwd: repoDir, encoding: 'utf-8' });
    const lines = String(output).split('\n').filter(line => line.trim().length > 0).slice(0, 10);
    return lines.length > 0 ? lines.join('\n') : '*(No recent changes)*';
  } catch {
    return '*(Unable to fetch git history)*';
  }
}

/**
 * Generate an updated subsystem spec with the configured LLM prompt.
 */
export async function generateUpdatedSpec(opts: {
  subsystemId: string;
  currentSpec: string;
  sourceFiles: string;
  recentChanges: string;
}): Promise<string> {
  const promptPath = join(dirname(dirname(__dirname)), 'tools', 'prompts', 'subsystem-manual-update-template.md');

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

  const result = await callHeadlessLLM(prompt, {
    mode: 'stream',
    taskType: 'classify',
    noTools: true,
    systemInstruction:
      'You have NO tools available. Output ONLY the updated subsystem spec markdown. No conversational text, no preamble, no XML tags. Start directly with the heading.',
  });

  return result.text;
}

/**
 * Show a unified diff between the current and generated subsystem specs.
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
    // Uses fixed /tmp paths and a shell `|| true` construct, so the shell-based
    // helper is appropriate here. No dynamic subsystem paths are interpolated.
    execShellCommand(`diff -u ${currentPath} ${updatedPath} || true`, { stdio: 'inherit' });
  } catch {
    // diff returns non-zero when files differ, ignore
  }

  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');
}

/**
 * Prompt the user to confirm a context update.
 *
 * @deprecated Use confirm() from cli-prompt.ts directly
 */
export async function confirmAction(message: string): Promise<boolean> {
  console.log(message);
  return confirm('Apply this update?');
}

/**
 * Update a subsystem spec from current source files and recent repo history.
 */
export async function updateSubsystemSpec(opts: {
  subsystemId: string;
  repoDir: string;
  noConfirm: boolean;
}): Promise<void> {
  const { subsystemId, repoDir, noConfirm } = opts;

  console.log(`Updating subsystem: ${subsystemId}`);
  console.log(`Repository: ${repoDir}`);

  console.log('Reading current spec...');
  const { specPath, content: currentSpec } = readContextSpec(repoDir, subsystemId);

  const keyFiles = extractKeyFiles(currentSpec);
  console.log(`Found ${keyFiles.length} key file(s) in spec`);

  if (keyFiles.length === 0) {
    throw new Error('No key files found in spec');
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

  if (!noConfirm) {
    showSpecDiff(currentSpec, updatedSpec);

    const approved = await confirmAction('Review the diff above.');
    if (!approved) {
      console.log('Update cancelled.');
      return;
    }
  }

  console.log('Writing updated spec...');
  writeFileSync(specPath, updatedSpec, 'utf-8');

  console.log('✓ Subsystem spec updated successfully');
  console.log(`  ${specPath}`);
}
