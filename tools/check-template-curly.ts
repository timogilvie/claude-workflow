import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkTemplateCurly, formatTemplateCurly } from '../shared/lib/template-curly-checker.ts';

const __filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = join(dirname(__filename), '..');

if (process.argv[1] === __filename) {
  const result = checkTemplateCurly(process.argv[2] ?? defaultRepoRoot);
  const message = formatTemplateCurly(result);
  if (!result.ok) {
    console.error(message);
    process.exit(1);
  }
  console.log(message);
}
