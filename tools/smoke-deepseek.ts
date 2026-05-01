import { DEEPSEEK_SMOKE_SKIP_MESSAGE, runDeepSeekSmoke } from '../shared/lib/deepseek-smoke.ts';

const result = runDeepSeekSmoke(process.cwd());
if (result.exitCode === 2) {
  console.log(DEEPSEEK_SMOKE_SKIP_MESSAGE);
  process.exit(2);
}

if (result.exitCode !== 0) {
  console.error(result.message);
  process.exit(result.exitCode);
}

console.log(result.message);
