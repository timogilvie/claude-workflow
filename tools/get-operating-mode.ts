#!/usr/bin/env node

import {
  getCurrentOperatingMode,
  getModelOperatingMode,
  hasAnyHealthyModel,
} from '../shared/lib/operating-mode.ts';

type Command = 'global' | 'model' | 'any-healthy';

function parseArgs(argv: string[]): { command: Command; modelId?: string; repoDir?: string } {
  const [commandArg, ...rest] = argv;

  if (commandArg !== 'global' && commandArg !== 'model' && commandArg !== 'any-healthy') {
    throw new Error('invalid command');
  }

  let modelId: string | undefined;
  let repoDir: string | undefined;

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '--repo-dir') {
      repoDir = rest[index + 1];
      index += 1;
      continue;
    }

    if (commandArg === 'model' && !modelId) {
      modelId = arg;
      continue;
    }

    throw new Error('invalid arguments');
  }

  if (commandArg === 'model' && !modelId) {
    throw new Error('model id required');
  }

  return { command: commandArg, modelId, repoDir };
}

function main(): number {
  try {
    const { command, modelId, repoDir } = parseArgs(process.argv.slice(2));

    switch (command) {
      case 'global':
        console.log(getCurrentOperatingMode(repoDir));
        return 0;
      case 'model':
        console.log(getModelOperatingMode(modelId!, repoDir));
        return 0;
      case 'any-healthy':
        return hasAnyHealthyModel(repoDir) ? 0 : 1;
    }
  } catch {
    if (process.argv[2] === 'any-healthy') {
      return 0;
    }

    console.log('normal');
    return 0;
  }
}

process.exit(main());
