import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { DEEPSEEK_BASE_URL } from './deepseek-provider.ts';
import { encodeProjectDir, resolveProjectsDirs } from './workflow-cost.ts';

const SKIP_MESSAGE = 'DEEPSEEK_API_KEY not set; skipping smoke test';

export interface DeepSeekSmokeResult {
  exitCode: number;
  message: string;
}

function latestMtimeMs(root: string): number {
  if (!existsSync(root)) {
    return 0;
  }

  let latest = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const entryPath = join(root, entry.name);
    if (entry.isDirectory()) {
      latest = Math.max(latest, latestMtimeMs(entryPath));
      continue;
    }
    try {
      latest = Math.max(latest, statSync(entryPath).mtimeMs);
    } catch {
      continue;
    }
  }
  return latest;
}

function hasProviderTranscript(worktreePath: string, providerRoot: string): boolean {
  const encoded = encodeProjectDir(worktreePath);
  const transcriptDir = join(providerRoot, 'home', '.claude', 'projects', encoded);
  if (existsSync(transcriptDir)) {
    return readdirSync(transcriptDir).some((name) => name.endsWith('.jsonl'));
  }

  return resolveProjectsDirs(worktreePath).some((projectsDir) => projectsDir.startsWith(providerRoot) && existsSync(projectsDir));
}

export function runDeepSeekSmoke(repoDir = process.cwd()): DeepSeekSmokeResult {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) {
    return {
      exitCode: 2,
      message: SKIP_MESSAGE,
    };
  }

  const worktreePath = resolve(repoDir);
  const providerRoot = join(worktreePath, '.wavemill', 'runs', 'smoke-deepseek', 'providers', 'deepseek');
  const providerHome = join(providerRoot, 'home');
  const xdgConfigHome = join(providerRoot, 'xdg', 'config');
  const xdgDataHome = join(providerRoot, 'xdg', 'data');
  mkdirSync(providerHome, { recursive: true });
  mkdirSync(xdgConfigHome, { recursive: true });
  mkdirSync(xdgDataHome, { recursive: true });

  const realClaudeDir = join(homedir(), '.claude');
  const preRunClaudeMtime = latestMtimeMs(realClaudeDir);
  const prompt = process.env.DEEPSEEK_SMOKE_PROMPT || 'Reply with OK.';

  if (process.env.WAVEMILL_DEEPSEEK_SMOKE_STUB === '1') {
    return {
      exitCode: 0,
      message: 'OK',
    };
  }

  const result = spawnSync('claude', ['--model', 'deepseek-v4-flash', '--dangerously-skip-permissions', prompt], {
    cwd: worktreePath,
    encoding: 'utf-8',
    env: {
      ...process.env,
      HOME: providerHome,
      XDG_CONFIG_HOME: xdgConfigHome,
      XDG_DATA_HOME: xdgDataHome,
      ANTHROPIC_BASE_URL: DEEPSEEK_BASE_URL,
      ANTHROPIC_AUTH_TOKEN: apiKey,
      ANTHROPIC_API_KEY: apiKey,
      ANTHROPIC_MODEL: 'deepseek-v4-flash',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-v4-flash',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4-flash',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-flash',
      CLAUDE_CODE_SUBAGENT_MODEL: 'deepseek-v4-flash',
      CLAUDE_CODE_EFFORT_LEVEL: 'medium',
    },
  });

  if (result.status !== 0) {
    return {
      exitCode: result.status ?? 1,
      message: (result.stderr || result.stdout || 'DeepSeek smoke test failed').trim(),
    };
  }

  if (!hasProviderTranscript(worktreePath, providerRoot)) {
    return {
      exitCode: 1,
      message: 'DeepSeek smoke test did not produce a provider transcript',
    };
  }

  const postRunClaudeMtime = latestMtimeMs(realClaudeDir);
  if (postRunClaudeMtime > preRunClaudeMtime) {
    return {
      exitCode: 1,
      message: 'DeepSeek smoke test mutated the real ~/.claude directory',
    };
  }

  return {
    exitCode: 0,
    message: 'OK',
  };
}

export { SKIP_MESSAGE as DEEPSEEK_SMOKE_SKIP_MESSAGE };
