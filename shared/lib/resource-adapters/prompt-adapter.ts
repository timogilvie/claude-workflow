import { basename } from 'node:path';
import { registerResource, toResourceRef, type ResourceRef } from '../resource-registry.ts';

function extractTemplateName(templatePath: string): string {
  return basename(templatePath).replace(/\.(md|txt)$/, '');
}

export function registerPromptTemplate(
  templatePath: string,
  templateContent: string,
  repoDir?: string,
): ResourceRef | null {
  return toResourceRef(registerResource({
    type: 'prompt',
    name: extractTemplateName(templatePath),
    content: templateContent,
    uri: templatePath,
    metadata: {
      path: templatePath,
    },
  }, { repoDir }));
}
