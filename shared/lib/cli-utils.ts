/**
 * Check whether the current process can safely prompt for input.
 */
export function isInteractive(): boolean {
  return process.stdin.isTTY === true;
}
