import { basename } from 'node:path';
import { registerResource, toResourceRef, type ResourceRef } from '../resource-registry.ts';

function extractTemplateName(templatePath: string): string {
  return basename(templatePath).replace(/\.(md|txt)$/, '');
}

export interface PromptRegistrationOptions {
  name?: string;
  metadata?: Record<string, unknown>;
}

export function registerPromptTemplate(
  templatePath: string,
  templateContent: string,
  repoDir?: string,
  options: PromptRegistrationOptions = {},
): ResourceRef | null {
  return toResourceRef(registerResource({
    type: 'prompt',
    name: options.name || extractTemplateName(templatePath),
    content: templateContent,
    uri: templatePath,
    metadata: {
      path: templatePath,
      ...options.metadata,
    },
  }, { repoDir }));
}
