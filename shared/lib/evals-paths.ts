import { resolve } from 'node:path';
import { loadWavemillConfig } from './config.ts';
import { resolveFromMainRepo } from './git-utils.ts';

const DEFAULT_EVALS_DIR = '.wavemill/evals';

export interface ResolvedEvalsDir {
  /** Absolute path to the evals directory. */
  dir: string;
  /** True when the path came from .wavemill-config.json. */
  fromConfig: boolean;
}

/**
 * Resolve the evals directory with worktree awareness.
 *
 * Resolution order:
 * 1. Explicit `dir` override
 * 2. `config.eval.evalsDir` from `.wavemill-config.json`
 * 3. Default: `.wavemill/evals`
 */
export function resolveEvalsDir(
  dir?: string,
  repoDir?: string,
): ResolvedEvalsDir {
  if (dir) {
    return { dir: resolve(dir), fromConfig: false };
  }

  const config = loadWavemillConfig(repoDir);
  if (config.eval?.evalsDir) {
    return {
      dir: resolveFromMainRepo(config.eval.evalsDir, repoDir),
      fromConfig: true,
    };
  }

  return {
    dir: resolveFromMainRepo(DEFAULT_EVALS_DIR, repoDir),
    fromConfig: false,
  };
}

export function resolveRouteArtifactArchiveDir(
  issueId: string | undefined,
  repoDir?: string,
): string | undefined {
  if (!issueId) {
    return undefined;
  }
  return resolve(resolveEvalsDir(undefined, repoDir).dir, 'artifacts', issueId);
}
