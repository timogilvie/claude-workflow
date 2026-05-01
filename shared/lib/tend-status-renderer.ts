export interface StatusRenderer {
  write(line: string): void;
  finalize(): void;
}

export function createStatusRenderer(stream: NodeJS.WriteStream): StatusRenderer {
  let lastLine: string | null = null;
  let finalized = false;
  const isTTY = stream.isTTY ?? false;

  return {
    write(line: string): void {
      if (!isTTY) {
        stream.write(`${line}\n`);
        return;
      }
      if (lastLine === null) {
        // First write: just the line, no trailing newline
        stream.write(line);
      } else if (line === lastLine) {
        // Same content: rewrite in place
        stream.write(`\r\x1b[K${line}`);
      } else {
        // Changed: commit previous to scrollback, write new
        stream.write(`\n${line}`);
      }
      lastLine = line;
    },
    finalize(): void {
      if (finalized) return;
      finalized = true;
      stream.write('\n');
    },
  };
}
