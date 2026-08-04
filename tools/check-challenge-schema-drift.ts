import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const contractPath = join(repoRoot, 'shared/lib/challenge-execution-contract.ts');
const schemaPath = join(repoRoot, 'shared/lib/eval-schema.json');
const builderPath = join(repoRoot, 'shared/lib/eval-record-builder.ts');

function exportedInterfaceBody(source: string, name: string): string {
  const marker = `export interface ${name}`;
  const start = source.indexOf(marker);
  if (start === -1) {
    throw new Error(`Missing exported interface ${name}`);
  }
  const open = source.indexOf('{', start);
  if (open === -1) {
    throw new Error(`Malformed exported interface ${name}`);
  }

  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  throw new Error(`Unclosed exported interface ${name}`);
}

function propertyNamesFromInterface(source: string, name: string): string[] {
  const body = exportedInterfaceBody(source, name)
    .replace(/\/\*\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  const names = new Set<string>();
  const matcher = /^\s*([A-Za-z_$][\w$]*)\??\s*:/gm;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(body))) {
    names.add(match[1]);
  }
  return [...names].sort();
}

function fail(messages: string[]): never {
  for (const message of messages) {
    console.error(`challenge-schema-drift: ${message}`);
  }
  process.exit(1);
}

const contractSource = readFileSync(contractPath, 'utf-8');
const builderSource = readFileSync(builderPath, 'utf-8');
const schema = JSON.parse(readFileSync(schemaPath, 'utf-8'));
const challengeSchema = schema.$defs?.ChallengeExecutionIntent;
const sideSchema = schema.$defs?.ChallengeSideIntent;
const errors: string[] = [];

if (!challengeSchema || typeof challengeSchema !== 'object') {
  errors.push('eval-schema.json is missing $defs.ChallengeExecutionIntent');
} else {
  const tsProperties = propertyNamesFromInterface(contractSource, 'ChallengeExecutionIntent');
  const schemaProperties = Object.keys(challengeSchema.properties ?? {}).sort();
  const missing = tsProperties.filter((name) => !schemaProperties.includes(name));
  if (missing.length > 0) {
    errors.push(`ChallengeExecutionIntent properties missing from schema: ${missing.join(', ')}`);
  }
  if (challengeSchema.additionalProperties !== false) {
    errors.push('ChallengeExecutionIntent must keep additionalProperties: false');
  }
}

if (!sideSchema || sideSchema.additionalProperties !== false) {
  errors.push('ChallengeSideIntent must exist and keep additionalProperties: false');
}

const projectionProperties = propertyNamesFromInterface(contractSource, 'ChallengeExecutionIntentProjection');
for (const required of ['pairId', 'challengeStage', 'primary', 'challenger']) {
  if (!projectionProperties.includes(required)) {
    errors.push(`ChallengeExecutionIntentProjection is missing ${required}`);
  }
}

if (!builderSource.includes('projectChallengeIntentForPersistence(input.intent)')) {
  errors.push('eval-record-builder.ts must project challenge intent before assigning record.challengeIntent');
}

if (/record\.challengeIntent\s*=\s*input\.intent\b/.test(builderSource)) {
  errors.push('eval-record-builder.ts directly assigns input.intent to record.challengeIntent');
}

if (errors.length > 0) {
  fail(errors);
}

console.log('challenge-schema-drift: ok');
