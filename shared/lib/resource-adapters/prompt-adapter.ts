import { basename } from 'node:path';
import { getLifecycleConfig } from '../config.ts';
import {
  getPointerEntry,
  shouldRouteToCanary,
  type PointerEntry,
} from '../resource-lifecycle.ts';
import {
  getResource,
  registerResource,
  toResourceRef,
  type ResourceRef,
  type ResourceVersion,
} from '../resource-registry.ts';

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

export function resolveActivePrompt(
  templateName: string,
  repoDir?: string,
  options?: { sessionId?: string },
): { ref: ResourceRef; resource: ResourceVersion; slot: 'stable' | 'canary'; pointerEntry: PointerEntry | null } | null {
  if (getLifecycleConfig(repoDir).enabled === false) {
    return null;
  }

  const pointerEntry = getPointerEntry('prompt', templateName, repoDir);
  if (!pointerEntry) {
    return null;
  }

  const useCanary = shouldRouteToCanary(pointerEntry, options?.sessionId);
  const target = useCanary ? pointerEntry.canary : pointerEntry.stable;
  const slot = useCanary ? 'canary' : 'stable';
  if (!target) {
    return null;
  }

  const resource = getResource(target.id, target.version, repoDir);
  if (!resource) {
    return null;
  }

  return {
    ref: { id: resource.id, version: resource.version },
    resource,
    slot,
    pointerEntry,
  };
}

export { extractTemplateName };
