import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCurrentOperatingMode, type OperatingMode } from './operating-mode.ts';
import { loadPromptTemplate } from './prompt-utils.ts';

const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tools', 'prompts');

export const PROMPT_BY_MODE: Record<OperatingMode, string> = {
  normal: 'initiative-planner.md',
  constrained: 'initiative-planner-compressed.md',
  survival: 'initiative-planner-compressed.md',
};

export interface InitiativePromptSelection {
  mode: OperatingMode;
  templateName: string;
  templatePath: string;
  content: string;
}

export const planPromptSelectorDeps = {
  getCurrentOperatingMode,
  loadPromptTemplate,
  log: (message: string) => console.log(message),
  warn: (message: string) => console.warn(message),
};

function isOperatingMode(value: unknown): value is OperatingMode {
  return value === 'normal' || value === 'constrained' || value === 'survival';
}

export async function pickInitiativePrompt(repoDir: string): Promise<InitiativePromptSelection> {
  let mode: OperatingMode = 'normal';

  try {
    const candidateMode: unknown = planPromptSelectorDeps.getCurrentOperatingMode(repoDir);
    if (isOperatingMode(candidateMode)) {
      mode = candidateMode;
    } else {
      planPromptSelectorDeps.warn('plan-decomposer: operating-mode lookup returned unknown mode, defaulting to normal');
    }
  } catch {
    planPromptSelectorDeps.warn('plan-decomposer: operating-mode lookup failed, defaulting to normal');
  }

  const templateName = PROMPT_BY_MODE[mode];
  const templatePath = join(PROMPTS_DIR, templateName);
  const content = await planPromptSelectorDeps.loadPromptTemplate(templatePath, { dir: repoDir });

  planPromptSelectorDeps.log(`plan-decomposer: mode=${mode} template=${templateName}`);

  return {
    mode,
    templateName,
    templatePath,
    content,
  };
}
