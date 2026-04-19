export interface HeartbeatOptions {
  label: string;
  intervalMs?: number;
  stream?: NodeJS.WriteStream;
  initialMessage?: string;
}

const DEFAULT_INTERVAL_MS = 15_000;

function formatTimestamp(date: Date): string {
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

function formatTick(elapsedSeconds: number, stream: NodeJS.WriteStream): string {
  const message = `⏳ Still working... (${elapsedSeconds}s elapsed)`;
  if (stream.isTTY === true) {
    return `\r${message}  `;
  }

  return `${formatTimestamp(new Date())} ${message}\n`;
}

export function startHeartbeat(options: HeartbeatOptions): () => void {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  if (intervalMs <= 0) {
    throw new RangeError(
      `Heartbeat interval for ${options.label} must be greater than 0ms; received ${intervalMs}`
    );
  }

  const stream = options.stream ?? process.stderr;
  const startedAt = Date.now();

  if (options.initialMessage) {
    stream.write(`${options.initialMessage}\n`);
  }

  const interval = setInterval(() => {
    const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
    stream.write(formatTick(elapsedSeconds, stream));
  }, intervalMs);

  let stopped = false;

  return () => {
    if (stopped) {
      return;
    }

    stopped = true;
    clearInterval(interval);

    if (stream.isTTY === true) {
      stream.write('\n');
    }
  };
}
