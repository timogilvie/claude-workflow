export type ReviewLogFormat = 'text' | 'json';
export type ReviewProgressLevel = 'info' | 'warn' | 'error';

export interface ReviewProgressEvent {
  event: string;
  message: string;
  level?: ReviewProgressLevel;
  elapsedMs?: number;
  attempt?: number;
  maxAttempts?: number;
  reviewer?: string;
  provider?: string;
  model?: string;
  details?: Record<string, unknown>;
}

export interface ReviewProgressReporter {
  emit(event: ReviewProgressEvent): Promise<void>;
}

interface CreateReviewProgressReporterOptions {
  format?: ReviewLogFormat;
  stream?: NodeJS.WriteStream;
}

class NoopReviewProgressReporter implements ReviewProgressReporter {
  async emit(): Promise<void> {}
}

class StderrReviewProgressReporter implements ReviewProgressReporter {
  private pending: Promise<void> = Promise.resolve();
  private readonly format: ReviewLogFormat;
  private readonly stream: NodeJS.WriteStream;

  constructor(format: ReviewLogFormat, stream: NodeJS.WriteStream) {
    this.format = format;
    this.stream = stream;
  }

  emit(event: ReviewProgressEvent): Promise<void> {
    const normalized = {
      timestamp: new Date().toISOString(),
      level: event.level ?? 'info',
      ...event,
    };
    const line = this.format === 'json'
      ? `${JSON.stringify(normalized)}\n`
      : `${formatTextEvent(normalized)}\n`;

    this.pending = this.pending.then(
      () =>
        new Promise<void>((resolve, reject) => {
          this.stream.write(line, (error) => (error ? reject(error) : resolve()));
        })
    );

    return this.pending;
  }
}

function formatElapsed(elapsedMs?: number): string {
  if (elapsedMs === undefined) {
    return '';
  }

  if (elapsedMs < 1000) {
    return `${elapsedMs}ms`;
  }

  return `${(elapsedMs / 1000).toFixed(1)}s`;
}

function formatTextEvent(event: Required<Pick<ReviewProgressEvent, 'message'>> & {
  timestamp: string;
  level: ReviewProgressLevel;
  event: string;
  elapsedMs?: number;
  attempt?: number;
  maxAttempts?: number;
  reviewer?: string;
  provider?: string;
  model?: string;
  details?: Record<string, unknown>;
}): string {
  const parts = ['[review]'];

  if (event.level === 'warn') {
    parts.push('WARN');
  } else if (event.level === 'error') {
    parts.push('ERROR');
  }

  parts.push(event.message);

  const metadata: string[] = [];

  if (event.reviewer) {
    metadata.push(`reviewer=${event.reviewer}`);
  }
  if (event.attempt !== undefined) {
    metadata.push(
      event.maxAttempts !== undefined
        ? `attempt=${event.attempt}/${event.maxAttempts}`
        : `attempt=${event.attempt}`
    );
  }
  if (event.provider) {
    metadata.push(`provider=${event.provider}`);
  }
  if (event.model) {
    metadata.push(`model=${event.model}`);
  }
  if (event.elapsedMs !== undefined) {
    metadata.push(`elapsed=${formatElapsed(event.elapsedMs)}`);
  }

  if (metadata.length > 0) {
    parts.push(`(${metadata.join(', ')})`);
  }

  return parts.join(' ');
}

export function createReviewProgressReporter(
  options: CreateReviewProgressReporterOptions = {}
): ReviewProgressReporter {
  const format = options.format ?? 'text';
  const stream = options.stream ?? process.stderr;
  return new StderrReviewProgressReporter(format, stream);
}

export function createNoopReviewProgressReporter(): ReviewProgressReporter {
  return new NoopReviewProgressReporter();
}
