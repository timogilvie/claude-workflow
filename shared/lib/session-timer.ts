// Pausable timer for tracking workflow execution time.
// Separates active execution time from user wait/interaction time.

export interface SessionTimer {
  start(): void;
  pause(): void;
  resume(): void;
  elapsed(): number;
  pausedTime(): number;
  isPaused(): boolean;
}

/**
 * Create a pausable timer that tracks execution time separately from user wait time.
 *
 * @example
 * ```ts
 * const timer = createTimer();
 * timer.start();
 * // ... do work ...
 * timer.pause();   // user prompt
 * // ... user thinking ...
 * timer.resume();  // user responded
 * // ... more work ...
 * console.log(timer.elapsed());    // ms of active execution
 * console.log(timer.pausedTime()); // ms waiting for user
 * ```
 */
export function createTimer(): SessionTimer {
  let startTime = 0;
  let pauseStart = 0;
  let totalPausedMs = 0;
  let paused = false;
  let started = false;

  return {
    start() {
      startTime = performance.now();
      totalPausedMs = 0;
      pauseStart = 0;
      paused = false;
      started = true;
    },

    pause() {
      if (!started || paused) return;
      pauseStart = performance.now();
      paused = true;
    },

    resume() {
      if (!started || !paused) return;
      totalPausedMs += performance.now() - pauseStart;
      pauseStart = 0;
      paused = false;
    },

    elapsed() {
      if (!started) return 0;
      const now = performance.now();
      const total = now - startTime;
      const currentPause = paused ? now - pauseStart : 0;
      return Math.round(total - totalPausedMs - currentPause);
    },

    pausedTime() {
      if (!started) return 0;
      const currentPause = paused ? performance.now() - pauseStart : 0;
      return Math.round(totalPausedMs + currentPause);
    },

    isPaused() {
      return paused;
    },
  };
}
