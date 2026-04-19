import type { RegistryTaskType } from './model-registry.ts';

type LogLevel = 'error' | 'status' | 'info' | 'debug';

const LEVEL_NUM: Record<LogLevel, number> = {
  error: 0,
  status: 1,
  info: 2,
  debug: 3,
};

function levelNum(level: string | undefined): number {
  if (!level) {
    return LEVEL_NUM.info;
  }

  return LEVEL_NUM[level as LogLevel] ?? LEVEL_NUM.info;
}

function currentVerbosityNum(): number {
  const configuredLevel = process.env.DASHBOARD_VERBOSITY || process.env.WAVEMILL_LOG_LEVEL;
  return levelNum(configuredLevel);
}

export function routerLog(message: string, level: LogLevel = 'info'): void {
  if (levelNum(level) > currentVerbosityNum()) {
    return;
  }

  process.stderr.write(`[router] ${message}\n`);
}

export function roleForTaskType(taskType: RegistryTaskType | null | undefined): string {
  switch (taskType) {
    case 'coding':
      return 'coder';
    case 'planning':
      return 'planner';
    case 'review':
      return 'reviewer';
    case 'classify':
      return 'classifier';
    case 'routing':
    default:
      return 'router';
  }
}

export function fallbackLog(params: {
  taskType: RegistryTaskType | null | undefined;
  failedModel: string;
  nextModel: string | null;
  reason: string;
  resetAt?: string | null;
  exhaustedChain?: string[];
  level?: LogLevel;
}): void {
  const level = params.level ?? 'info';
  if (levelNum(level) > currentVerbosityNum()) {
    return;
  }

  const role = roleForTaskType(params.taskType);
  const resetAtSuffix = params.resetAt ? ` resetAt=${params.resetAt}` : '';
  const chainSuffix = params.exhaustedChain && params.exhaustedChain.length > 0
    ? ` after: ${params.exhaustedChain.join(' -> ')}`
    : '';

  if (params.nextModel) {
    process.stderr.write(
      `[${role}] ${params.failedModel} unavailable (${params.reason}); falling back to ${params.nextModel}${resetAtSuffix}\n`
    );
    return;
  }

  process.stderr.write(
    `[${role}] ${params.failedModel} unavailable (${params.reason}); no remaining fallback candidates${chainSuffix}${resetAtSuffix}\n`
  );
}
