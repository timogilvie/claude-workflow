/**
 * Fatal tend-loop error. These indicate invalid state or programming bugs that
 * should stop the daemon instead of being retried forever.
 */
export class TendFatalError extends Error {
  readonly cause?: unknown;

  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message);
    this.name = 'TendFatalError';
    this.cause = options.cause;
  }
}
