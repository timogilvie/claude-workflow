import { createInterface } from 'node:readline/promises';

/**
 * Ask the user a yes/no question and return whether they confirmed it.
 *
 * @param message - Question text shown before the confirmation suffix.
 * @param options - Confirmation behavior options.
 * @param options.defaultYes - Whether pressing Enter should accept the prompt.
 * @returns Whether the user answered yes.
 */
export async function confirm(
  message: string,
  options: { defaultYes?: boolean } = {}
): Promise<boolean> {
  const { defaultYes = false } = options;
  const suffix = defaultYes ? '[Y/n]' : '[y/N]';
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await rl.question(`${message} ${suffix} `);
    const normalized = answer.trim().toLowerCase();

    if (normalized === '') {
      return defaultYes;
    }

    return normalized === 'y' || normalized === 'yes';
  } finally {
    rl.close();
  }
}

/**
 * Ask the user for free-form text input.
 *
 * @param question - Prompt text to display.
 * @returns The trimmed user response.
 */
export async function prompt(question: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await rl.question(question);
    return answer.trim();
  } finally {
    rl.close();
  }
}

/**
 * Pause execution until the user presses Enter.
 *
 * @param message - Optional message displayed while waiting.
 */
export async function pressEnterToContinue(
  message = 'Press Enter to continue...'
): Promise<void> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    await rl.question(message);
  } finally {
    rl.close();
  }
}
