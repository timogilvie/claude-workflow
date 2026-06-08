import { execShellCommand } from './shell-utils.ts';

export interface ResolveDefaultBaseRefDeps {
  execShellCommand: typeof execShellCommand;
}

const defaultDeps: ResolveDefaultBaseRefDeps = {
  execShellCommand,
};

function normalizeRef(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.replace(/^refs\/remotes\/origin\//, '');
}

export function resolveDefaultBaseRef(
  repoDir: string,
  deps: ResolveDefaultBaseRefDeps = defaultDeps,
): string | null {
  try {
    const headRef = normalizeRef(String(
      deps.execShellCommand('git symbolic-ref refs/remotes/origin/HEAD', {
        cwd: repoDir,
        encoding: 'utf-8',
      }),
    ));
    if (headRef) {
      return headRef;
    }
  } catch (error) {
    if (!/not found|not a git repository|command not found|enoent/i.test(String(error))) {
      // Ignore resolver probe failures and continue to the next fallback.
    }
  }

  try {
    const configured = normalizeRef(String(
      deps.execShellCommand('git config --get init.defaultBranch', {
        cwd: repoDir,
        encoding: 'utf-8',
      }),
    ));
    if (configured) {
      return configured;
    }
  } catch (error) {
    if (/command not found|enoent/i.test(String(error))) {
      return null;
    }
  }

  return 'main';
}
