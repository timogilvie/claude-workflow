import { isSafePattern } from '../permission-patterns.ts';

export type CommandClass = 'safe' | 'dangerous';

export interface CommandClassification {
  commandClass: CommandClass;
  normalizedCommand: string;
  rejectionReason?: 'empty-command' | 'dangerous-command-pattern';
}

function normalizeCommand(command: string | readonly string[]): string {
  if (typeof command === 'string') {
    return command.trim();
  }
  return command.join(' ').trim();
}

/**
 * Classify a command using `permission-patterns.ts` as the single safety dialect.
 */
export function classifyCommand(command: string | readonly string[]): CommandClassification {
  const normalizedCommand = normalizeCommand(command);
  if (normalizedCommand.length === 0) {
    return {
      commandClass: 'dangerous',
      normalizedCommand,
      rejectionReason: 'empty-command',
    };
  }

  if (!isSafePattern(normalizedCommand)) {
    return {
      commandClass: 'dangerous',
      normalizedCommand,
      rejectionReason: 'dangerous-command-pattern',
    };
  }

  return {
    commandClass: 'safe',
    normalizedCommand,
  };
}
