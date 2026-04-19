import type { LLMCallOptions } from './llm-cli.ts';
import { callClaude } from './llm-cli.ts';
import type { OperatingMode } from './operating-mode.ts';

const SURVIVAL_MAX_FILES = 5;
const CONSTRAINED_MAX_FILES = 10;
const LARGE_PACKET_LINE_THRESHOLD = 400;

function escapeJsonString(value: string): string {
  return JSON.stringify(value);
}

function extractKeyFilesSection(fullContent: string): string {
  const headingMatch = fullContent.match(/^#{2,3}\s+Key Files\s*$/im);
  if (!headingMatch || headingMatch.index === undefined) {
    return '';
  }

  const sectionStart = headingMatch.index + headingMatch[0].length;
  const remaining = fullContent.slice(sectionStart);
  const nextHeadingMatch = remaining.match(/^#{2,3}\s+/m);

  return nextHeadingMatch && nextHeadingMatch.index !== undefined
    ? remaining.slice(0, nextHeadingMatch.index)
    : remaining;
}

function countListedFiles(fullContent: string): number {
  const keyFilesSection = extractKeyFilesSection(fullContent);
  if (!keyFilesSection) {
    return 0;
  }

  return keyFilesSection
    .split('\n')
    .filter(line => /^\s*[-*]\s+`?[^`\n]+`?\s*$/.test(line.trim()))
    .length;
}

function countLines(fullContent: string): number {
  if (fullContent.length === 0) {
    return 0;
  }

  return fullContent.split('\n').length;
}

function buildSplitPrompt(fullContent: string, mode: OperatingMode): string {
  const maxFiles = mode === 'survival' ? SURVIVAL_MAX_FILES : CONSTRAINED_MAX_FILES;
  const modeName = mode.toUpperCase();

  return [
    'You are splitting a large task packet into smaller independent sub-packets for degraded mode execution.',
    `Mode: ${modeName} (at most ${maxFiles} files per sub-packet)`,
    '',
    'Rules:',
    '- Preserve all requirements cumulatively across sub-packets.',
    '- Prefer one-file patches when possible.',
    '- Forbid speculative refactors or cleanup not required for the issue.',
    '- Prefer splitting by feature area or concrete file grouping, not abstract phases.',
    '- Each sub-packet must be independently executable whenever possible.',
    '- Each sub-packet must be complete markdown with: objective, key files, implementation approach, and success criteria.',
    '- Keep each sub-packet narrowly scoped and ready for weaker models to execute.',
    '',
    'Return ONLY valid JSON in this shape:',
    '[{"title":"short title","content":"full markdown packet"}]',
    '',
    'Original packet:',
    escapeJsonString(fullContent),
  ].join('\n');
}

function parseSplitResponse(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed.startsWith('[')) {
    throw new Error('split response is not a JSON array');
  }

  const parsed = JSON.parse(trimmed) as Array<{ content?: unknown }>;
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('split response did not contain any packets');
  }

  const packets = parsed
    .map(item => typeof item?.content === 'string' ? item.content.trim() : '')
    .filter(Boolean);

  if (packets.length === 0) {
    throw new Error('split response packets were empty');
  }

  return packets;
}

export const scopeShrinkerDeps = {
  callClaude,
};

export type { OperatingMode } from './operating-mode.ts';

export function buildScopeConstraintContext(mode: OperatingMode): string {
  if (mode === 'normal') {
    return '';
  }

  const maxFiles = mode === 'survival' ? SURVIVAL_MAX_FILES : CONSTRAINED_MAX_FILES;
  const prefersOneFilePatches = mode === 'survival'
    ? '- Prefer one-file patches whenever possible; only touch additional files when strictly required.\n'
    : '';
  const deferralGuidance = mode === 'survival'
    ? '- Mark deferred work explicitly in Scope Out or follow-up notes instead of partially implementing it.\n'
    : '- If the issue naturally breaks into multiple packets or PRs, choose the smallest independently shippable slice first.\n';

  return [
    '## Degraded Mode Scope Constraints',
    '',
    `Operating mode is \`${mode}\`. Scope the task packet for weaker models and limited quota.`,
    '',
    '- Narrow the task to the smallest complete implementation that satisfies the issue.',
    `- Keep the primary implementation to ${maxFiles} files or fewer unless the issue is impossible to complete otherwise.`,
    prefersOneFilePatches,
    '- Forbid speculative refactors, opportunistic cleanup, or incidental renames.',
    '- Do not bundle follow-on enhancements into the same packet.',
    deferralGuidance,
    '- If work must be phased, make the first phase independently valuable and explicitly defer later phases.',
    '',
  ].join('\n');
}

export function shouldSplitPacket(fullContent: string, mode: OperatingMode): boolean {
  if (mode === 'normal') {
    return false;
  }

  const fileCount = countListedFiles(fullContent);
  const lineCount = countLines(fullContent);

  if (mode === 'survival') {
    return fileCount > SURVIVAL_MAX_FILES || lineCount > LARGE_PACKET_LINE_THRESHOLD;
  }

  return fileCount > CONSTRAINED_MAX_FILES || lineCount > LARGE_PACKET_LINE_THRESHOLD;
}

export async function splitPacketIntoSubPackets(
  fullContent: string,
  mode: OperatingMode,
  options: { claudeCmd?: string; repoDir?: string } = {}
): Promise<string[]> {
  if (mode === 'normal') {
    return [fullContent];
  }

  const prompt = buildSplitPrompt(fullContent, mode);
  const callOptions: Omit<LLMCallOptions, 'provider'> = {
    mode: 'stream',
    cliCmd: options.claudeCmd || process.env.CLAUDE_CMD || 'claude',
    repoDir: options.repoDir,
    cwd: options.repoDir,
    taskType: 'planning',
    cliFlags: [
      '--tools',
      '',
      '--append-system-prompt',
      'Return only raw JSON. Do not include markdown fences, commentary, or explanations.',
    ],
  };

  try {
    const result = await scopeShrinkerDeps.callClaude(prompt, callOptions);
    const packets = parseSplitResponse(result.text);
    return packets.length > 0 ? packets : [fullContent];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`⚠️  Task packet auto-split failed: ${message}`);
    return [fullContent];
  }
}
