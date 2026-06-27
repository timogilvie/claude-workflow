import type { ApplyPatchDetails } from './apply-patch-tool.ts';
import type {
  CodingMutationDetails,
  CreateMarkerDetails,
  WriteArtifactDetails,
} from './mutation-tools.ts';
import { normalizePatchPath } from '../patch-contract.ts';

export interface IntendedFileTracker {
  record(paths: readonly string[]): void;
  isIntended(path: string): boolean;
  list(): string[];
  recordCommit(): number;
  readonly commitCount: number;
}

interface AfterToolCallContext {
  toolCall: { name: string };
  result: { details: unknown };
}

export function createIntendedFileTracker(): IntendedFileTracker {
  const intended = new Set<string>();
  let commits = 0;

  return {
    record(paths) {
      for (const candidate of paths) {
        const normalized = normalizeTrackedPath(candidate);
        if (normalized) {
          intended.add(normalized);
        }
      }
    },
    isIntended(candidate) {
      const normalized = normalizeTrackedPath(candidate);
      return normalized !== null && intended.has(normalized);
    },
    list() {
      return [...intended].sort((left, right) => left.localeCompare(right));
    },
    recordCommit() {
      commits += 1;
      return commits;
    },
    get commitCount() {
      return commits;
    },
  };
}

export async function intendedFilesAfterToolCall(
  context: AfterToolCallContext,
  tracker: IntendedFileTracker,
): Promise<void> {
  if (context.toolCall.name === 'apply_patch') {
    const details = context.result.details as ApplyPatchDetails | undefined;
    if (details?.ok) {
      tracker.record(details.changedFiles);
    }
    return;
  }

  if (context.toolCall.name === 'write_artifact' || context.toolCall.name === 'create_marker') {
    const details = context.result.details as
      | WriteArtifactDetails
      | CreateMarkerDetails
      | CodingMutationDetails
      | undefined;
    if (details?.ok && 'resolvedPath' in details) {
      tracker.record([details.resolvedPath]);
    }
  }
}

function normalizeTrackedPath(candidate: string): string | null {
  if (typeof candidate !== 'string') {
    return null;
  }
  return normalizePatchPath(candidate.replace(/\\/g, '/'));
}
