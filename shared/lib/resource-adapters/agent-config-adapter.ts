import { canonicalJsonStringify, registerResource, toResourceRef, type ResourceRef } from '../resource-registry.ts';

export interface AgentConfigInput {
  phase: string;
  model: string;
  cliCmd: string;
  cliFlags?: string[];
  templateRefs?: ResourceRef[];
  repoDir?: string;
}

export function registerAgentConfig(input: AgentConfigInput): ResourceRef | null {
  const canonical = canonicalJsonStringify({
    phase: input.phase,
    model: input.model,
    cliCmd: input.cliCmd,
    cliFlags: [...(input.cliFlags || [])].sort(),
    templateRefs: (input.templateRefs || []).map((ref) => `${ref.id}@${ref.version}`).sort(),
  });

  return toResourceRef(registerResource({
    type: 'agent-config',
    name: `${input.phase}-${input.cliCmd}`,
    content: canonical,
    metadata: {
      phase: input.phase,
      model: input.model,
      cliCmd: input.cliCmd,
      cliFlags: [...(input.cliFlags || [])].sort(),
      phasePromptRefs: input.templateRefs,
    },
    dependencies: input.templateRefs,
  }, { repoDir: input.repoDir }));
}
