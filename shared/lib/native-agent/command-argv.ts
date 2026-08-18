export type ParseCommandArgvResult =
  | { ok: true; argv: string[] }
  | { ok: false; reason: 'unsupported-shell-syntax'; detail: string };

/**
 * Parse a command string into exec argv using the POSIX shell's quoting rules
 * for plain words, while rejecting syntax that would require a real shell.
 */
export function parseCommandArgv(command: string): ParseCommandArgvResult {
  const argv: string[] = [];
  let current = '';
  let wordStarted = false;
  let state: 'unquoted' | 'single' | 'double' = 'unquoted';
  let pendingEscape = false;

  const flushWord = () => {
    if (wordStarted) {
      argv.push(current);
      current = '';
      wordStarted = false;
    }
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;

    if (state === 'single') {
      if (char === "'") {
        state = 'unquoted';
      } else {
        current += char;
      }
      continue;
    }

    if (state === 'double') {
      if (pendingEscape) {
        if (char === '"' || char === '\\' || char === '$' || char === '`') {
          current += char;
        } else {
          current += `\\${char}`;
        }
        pendingEscape = false;
        wordStarted = true;
        continue;
      }
      if (char === '\\') {
        pendingEscape = true;
        wordStarted = true;
        continue;
      }
      if (char === '"') {
        state = 'unquoted';
        continue;
      }
      if (char === '$' || char === '`') {
        return unsupported(char);
      }
      current += char;
      wordStarted = true;
      continue;
    }

    if (pendingEscape) {
      current += char;
      wordStarted = true;
      pendingEscape = false;
      continue;
    }

    if (char === ' ' || char === '\t') {
      flushWord();
      continue;
    }
    if (char === '\\') {
      pendingEscape = true;
      wordStarted = true;
      continue;
    }
    if (char === "'") {
      state = 'single';
      wordStarted = true;
      continue;
    }
    if (char === '"') {
      state = 'double';
      wordStarted = true;
      continue;
    }
    if (char === '\n' || char === '\r') {
      return unsupported('newline');
    }
    if (char === '$' || char === '`') {
      return unsupported(char);
    }
    if (char === '|' || char === '&' || char === ';' || char === '<' || char === '>') {
      return unsupported(readOperator(command, index));
    }
    if (isRedirectFdPrefix(command, index)) {
      return unsupported(readFdRedirect(command, index));
    }

    current += char;
    wordStarted = true;
  }

  if (state !== 'unquoted' || pendingEscape) {
    return unsupported(state === 'single' ? 'unterminated quote' : pendingEscape ? 'unterminated escape' : 'unterminated quote');
  }
  flushWord();
  if (argv.length === 0) {
    return unsupported('empty command');
  }
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0]!)) {
    return unsupported('leading environment assignment');
  }
  return { ok: true, argv };
}

function unsupported(detail: string): ParseCommandArgvResult {
  return { ok: false, reason: 'unsupported-shell-syntax', detail };
}

function readOperator(command: string, index: number): string {
  const two = command.slice(index, index + 2);
  const three = command.slice(index, index + 3);
  if (three === '<<<') {
    return three;
  }
  if (two === '&&' || two === '||' || two === '>>' || two === '<<' || two === '&>') {
    return two;
  }
  return command[index]!;
}

function isRedirectFdPrefix(command: string, index: number): boolean {
  return /[0-9]/.test(command[index] ?? '') && /[<>]/.test(command[index + 1] ?? '');
}

function readFdRedirect(command: string, index: number): string {
  let end = index;
  while (/[0-9]/.test(command[end] ?? '')) {
    end += 1;
  }
  if (command[end] === '>' && command[end + 1] === '&') {
    end += 2;
    while (/[0-9-]/.test(command[end] ?? '')) {
      end += 1;
    }
    return command.slice(index, end);
  }
  if (command[end] === '>' && command[end + 1] === '>') {
    return command.slice(index, end + 2);
  }
  return command.slice(index, end + 1);
}
