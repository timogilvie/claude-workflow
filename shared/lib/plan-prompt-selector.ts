import { getCurrentOperatingMode, type OperatingMode } from './operating-mode.ts';
import { loadPromptResource } from './resource-retrieval.ts';

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
  loadPromptResource,
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
  const prompt = await planPromptSelectorDeps.loadPromptResource({
    kind: 'prompt',
    role: 'initiative-planner',
    operatingMode: mode,
    repoDir,
  });

  planPromptSelectorDeps.log(`plan-decomposer: mode=${mode} template=${templateName}`);

  return {
    mode,
    templateName,
    templatePath: prompt.path,
    content: prompt.content!,
  };
}
