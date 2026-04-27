import { getCurrentOperatingMode, type OperatingMode } from './operating-mode.ts';
import { loadPromptTemplate } from './prompt-utils.ts';
import { resolvePromptResource } from './resource-retrieval.ts';

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

  const resolved = await resolvePromptResource({
    class: 'prompt',
    stage: 'initiative-planning',
    role: 'planner',
    operatingMode: mode,
    repoDir,
  });

  const templateName = PROMPT_BY_MODE[mode];
  planPromptSelectorDeps.log(`plan-decomposer: mode=${mode} template=${templateName}`);

  return {
    mode,
    templateName,
    templatePath: resolved.path,
    content: resolved.content,
  };
}
