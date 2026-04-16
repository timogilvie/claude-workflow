import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CURRENT_CONFIG_VERSION, loadWavemillConfig, type WavemillConfig } from './config.ts';

export const CANONICAL_CONFIG_TEMPLATE: WavemillConfig = {
  configVersion: '1.3.0',
  linear: {
    project: '',
  },
  mill: {
    session: '',
    maxParallel: 7,
    pollSeconds: 10,
    baseBranch: 'main',
    worktreeRoot: '../worktrees',
    agentCmd: 'claude',
    requireConfirm: true,
    planningMode: 'skip',
    maxRetries: 3,
    retryDelay: 2,
  },
  expand: {
    maxSelect: 3,
    maxDisplay: 9,
  },
  plan: {
    maxDisplay: 9,
    research: false,
    model: 'claude-opus-4-7',
    interactive: true,
  },
  eval: {
    aggregation: {
      repos: [],
      outputPath: '.wavemill/evals/aggregated-evals.jsonl',
    },
    evalsDir: '.wavemill/evals',
    judge: {
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
    },
    pricing: {
      'claude-opus-4-6': { inputCostPerMTok: 5, outputCostPerMTok: 25, cacheWriteCostPerMTok: 6.25, cacheReadCostPerMTok: 0.5 },
      'claude-opus-4-7': { inputCostPerMTok: 5, outputCostPerMTok: 25, cacheWriteCostPerMTok: 6.25, cacheReadCostPerMTok: 0.5 },
      'claude-sonnet-4-6': { inputCostPerMTok: 3, outputCostPerMTok: 15, cacheWriteCostPerMTok: 3.75, cacheReadCostPerMTok: 0.3 },
      'claude-sonnet-4-5-20250929': { inputCostPerMTok: 3, outputCostPerMTok: 15, cacheWriteCostPerMTok: 3.75, cacheReadCostPerMTok: 0.3 },
      'claude-haiku-4-5-20251001': { inputCostPerMTok: 0.8, outputCostPerMTok: 4, cacheWriteCostPerMTok: 1, cacheReadCostPerMTok: 0.08 },
      'gpt-5.3-codex': { inputCostPerMTok: 1.75, outputCostPerMTok: 14, cacheReadCostPerMTok: 0.44 },
      'gpt-5.4': { inputCostPerMTok: 2.5, outputCostPerMTok: 15, cacheReadCostPerMTok: 0.25 },
    },
    interventionPenalties: {
      reviewComment: 0.05,
      postPrCommit: 0.08,
      manualEdit: 0.1,
      testFix: 0.06,
      sessionRedirect: 0.12,
      selfReviewWarning: 0.05,
      selfReviewBlocker: 0.2,
    },
  },
  autoEval: true,
  hokusai: {
    dataSubmission: {
      enabled: false,
      consentVersion: '1.0',
      endpoint: 'https://api.hokusai.dev/v1/submit',
    },
  },
  challenge: {
    enabled: true,
    rate: 0.1,
    models: [
      'claude-sonnet-4-6',
      'claude-sonnet-4-5-20250929',
      'claude-opus-4-7',
      'claude-opus-4-6',
      'claude-haiku-4-5-20251001',
      'gpt-5.3-codex',
      'gpt-5.4',
    ],
    comparisonModel: 'claude-opus-4-7',
    autoMergeWinner: false,
  },
  review: {
    maxIterations: 3,
    enabled: true,
    metricsLog: '.wavemill/review-log.json',
    personas: ['general'],
  } as WavemillConfig['review'] & { metricsLog: string; personas: string[] },
  router: {
    enabled: true,
    defaultModel: 'claude-sonnet-4-6',
    minRecords: 20,
    minModels: 2,
    models: [],
    defaultAgent: 'claude',
    agentMap: {
      'claude-opus-4-7': 'claude',
      'claude-sonnet-4-6': 'claude',
      'claude-opus-4-6': 'claude',
      'claude-sonnet-4-5-20250929': 'claude',
      'claude-haiku-4-5-20251001': 'claude',
      'gpt-5.3-codex': 'codex',
      'gpt-5.4': 'codex',
    },
    mode: 'auto',
    llmModel: 'gpt-4o-mini',
    llmProvider: 'openai',
  },
  validation: {
    enabled: true,
    layer1: {
      enabled: true,
    },
    layer2: {
      enabled: true,
      model: 'claude-haiku-4-5-20251001',
      provider: 'claude-cli',
    },
    onFailure: 'conservative',
  },
  constraints: {
    enabled: true,
    cleanupAfterMerge: false,
  },
  ui: {
    visualVerification: true,
    designStandards: true,
    creativeDirection: false,
  },
  permissions: {
    autoApprovePatterns: [
      'find *',
      'ls *',
      'cat *',
      'head *',
      'tail *',
      'wc *',
      'git status*',
      'git log*',
      'git show*',
      'git diff*',
      'git branch --list*',
      'git branch -l*',
      'git worktree list*',
      'gh pr view*',
      'gh pr list*',
      'gh pr status*',
      'gh issue view*',
      'gh issue list*',
      'grep *',
      'rg *',
      'npm list*',
      'npm ls*',
    ],
    worktreeMode: {
      enabled: true,
      autoApproveReadOnly: true,
    },
  },
};

export interface PreparedConfigSync {
  configPath: string;
  backupPath: string;
  configExists: boolean;
  currentConfig: Record<string, unknown>;
  mergedConfig: WavemillConfig;
  additions: string[];
  alreadyCurrent: boolean;
}

export function deepMergeConfig(target: any, source: any): any {
  if (source === null || source === undefined) {
    return target;
  }

  if (Array.isArray(target)) {
    return Array.isArray(source) && source.length > 0 ? source : target;
  }

  if (typeof target === 'object' && target !== null) {
    const result = { ...target };

    for (const key in source) {
      if (!Object.prototype.hasOwnProperty.call(source, key)) {
        continue;
      }

      if (typeof source[key] === 'object' && !Array.isArray(source[key]) && source[key] !== null) {
        result[key] = deepMergeConfig(target[key] || {}, source[key]);
      } else if (source[key] !== undefined) {
        result[key] = source[key];
      }
    }

    return result;
  }

  return source !== undefined ? source : target;
}

export function identifyConfigAdditions(before: any, after: any, currentPath = ''): string[] {
  const additions: string[] = [];

  for (const key in after) {
    const nextPath = currentPath ? `${currentPath}.${key}` : key;
    if (!Object.prototype.hasOwnProperty.call(before, key)) {
      additions.push(nextPath);
    } else if (typeof after[key] === 'object' && !Array.isArray(after[key]) && after[key] !== null) {
      additions.push(...identifyConfigAdditions(before[key] || {}, after[key], nextPath));
    }
  }

  return additions;
}

export function prepareConfigSync(repoDir: string): PreparedConfigSync {
  const configPath = resolve(repoDir, '.wavemill-config.json');
  const backupPath = resolve(repoDir, '.wavemill-config.json.backup');
  const configExists = existsSync(configPath);

  let currentConfig: Record<string, unknown> = {};
  if (configExists) {
    currentConfig = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
  }

  const mergedConfig = deepMergeConfig(CANONICAL_CONFIG_TEMPLATE, currentConfig) as WavemillConfig;
  mergedConfig.configVersion = CURRENT_CONFIG_VERSION;

  const additions = configExists ? identifyConfigAdditions(currentConfig, mergedConfig) : [];
  const alreadyCurrent =
    configExists &&
    currentConfig.configVersion === CURRENT_CONFIG_VERSION &&
    additions.length === 0 &&
    JSON.stringify(loadWavemillConfig(repoDir)) === JSON.stringify(mergedConfig);

  return {
    configPath,
    backupPath,
    configExists,
    currentConfig,
    mergedConfig,
    additions,
    alreadyCurrent,
  };
}
