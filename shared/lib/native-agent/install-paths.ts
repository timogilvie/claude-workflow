/**
 * Install-relative resolution for wavemill-owned assets under `tools/`.
 *
 * Mill drives consumer repositories that contain no `tools/` directory of
 * their own. Native launchers additionally import `../shared/lib/...`, so a
 * copy placed inside a consumer repo could not resolve its own imports even
 * if one were scaffolded there. The installation copy is the only one that
 * can ever execute.
 *
 * Anything under `tools/` is wavemill-owned and must be resolved from this
 * module — never with `join(repoDir, 'tools', ...)`. `repoDir` is the repo
 * being worked on, which is only coincidentally wavemill itself when running
 * wavemill's own test suite. That coincidence is why repo-relative launcher
 * paths passed CI while failing in every other repository.
 *
 * The shell equivalents are `agent_wavemill_tools_dir` and
 * `agent_native_launcher_path` in `shared/lib/agent-adapters.sh`.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type NativeLauncherPhase = 'planning' | 'coding' | 'review';

const LAUNCHER_FILENAMES: Record<NativeLauncherPhase, string> = {
  planning: 'launch-native-planning.ts',
  coding: 'launch-native-coding.ts',
  review: 'launch-native-review.ts',
};

/**
 * Absolute path to the wavemill installation's `tools/` directory.
 *
 * This module lives at `<install>/shared/lib/native-agent/`, so the tools
 * directory is three levels up.
 */
export function resolveWavemillToolsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'tools');
}

/**
 * Absolute path to the native launcher for a phase.
 *
 * @param phase - Native phase the launcher serves.
 * @returns Absolute path to the launcher inside the wavemill installation.
 */
export function resolveNativeLauncherPath(phase: NativeLauncherPhase): string {
  return join(resolveWavemillToolsDir(), LAUNCHER_FILENAMES[phase]);
}

/**
 * Absolute path to a shared prompt template in `tools/prompts/`.
 *
 * `tool-runner.ts` exposes a `resolvePromptPath(importMetaUrl, name)` for the
 * same purpose, but it derives `prompts/` from the *caller's* directory, so it
 * only works for callers that live in `tools/`. Callers under `shared/lib/`
 * must use this instead.
 *
 * @param promptName - File name within `tools/prompts/`, e.g. `issue-writer.md`.
 * @returns Absolute path to the prompt template inside the installation.
 */
export function resolveWavemillPromptPath(promptName: string): string {
  return join(resolveWavemillToolsDir(), 'prompts', promptName);
}
