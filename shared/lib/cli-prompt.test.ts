import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliPromptModule = resolve(__dirname, 'cli-prompt.ts');

function runPromptScript(script: string, input: string) {
  const result = spawnSync(
    'node',
    ['--input-type=module', '--eval', script],
    {
      cwd: resolve(__dirname, '..', '..'),
      encoding: 'utf-8',
      input,
      timeout: 10_000,
    }
  );

  if (result.error) {
    throw result.error;
  }

  return result;
}

describe('cli-prompt', () => {
  it('confirm defaults to no when the user presses Enter', () => {
    const script = `
      import { confirm } from ${JSON.stringify(cliPromptModule)};
      const result = await confirm('Apply changes?');
      console.log(JSON.stringify({ result }));
    `;
    const result = runPromptScript(script, '\n');

    assert.equal(result.status, 0);
    assert.match(result.stdout, /Apply changes\? \[y\/N\]/);
    assert.match(result.stdout, /"result":false/);
  });

  it('confirm defaults to yes when configured', () => {
    const script = `
      import { confirm } from ${JSON.stringify(cliPromptModule)};
      const result = await confirm('Apply changes?', { defaultYes: true });
      console.log(JSON.stringify({ result }));
    `;
    const result = runPromptScript(script, '\n');

    assert.equal(result.status, 0);
    assert.match(result.stdout, /Apply changes\? \[Y\/n\]/);
    assert.match(result.stdout, /"result":true/);
  });

  it('prompt returns trimmed text input', () => {
    const script = `
      import { prompt } from ${JSON.stringify(cliPromptModule)};
      const result = await prompt('Select a project: ');
      console.log(JSON.stringify({ result }));
    `;
    const result = runPromptScript(script, '  project-alpha  \n');

    assert.equal(result.status, 0);
    assert.match(result.stdout, /Select a project:/);
    assert.match(result.stdout, /"result":"project-alpha"/);
  });

  it('pressEnterToContinue resolves after a newline', () => {
    const script = `
      import { pressEnterToContinue } from ${JSON.stringify(cliPromptModule)};
      await pressEnterToContinue('Continue now...');
      console.log('done');
    `;
    const result = runPromptScript(script, '\n');

    assert.equal(result.status, 0);
    assert.match(result.stdout, /Continue now\.\.\./);
    assert.match(result.stdout, /done/);
  });
});
