import { readFileSync } from 'node:fs';

type JsonSchemaObject = {
  $defs?: Record<string, JsonSchemaObject>;
  properties?: Record<string, unknown>;
};

function readJson(path: string): JsonSchemaObject {
  return JSON.parse(readFileSync(path, 'utf-8')) as JsonSchemaObject;
}

function interfaceBody(source: string, interfaceName: string): string {
  const match = new RegExp(`export\\s+interface\\s+${interfaceName}\\b`).exec(source);
  if (!match) {
    throw new Error(`Missing interface ${interfaceName}`);
  }
  const start = match.index;

  const open = source.indexOf('{', start);
  if (open < 0) {
    throw new Error(`Malformed interface ${interfaceName}`);
  }

  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (depth === 0) {
      return source.slice(open + 1, index);
    }
  }

  throw new Error(`Unclosed interface ${interfaceName}`);
}

function topLevelInterfaceKeys(source: string, interfaceName: string): string[] {
  const body = interfaceBody(source, interfaceName);
  const keys: string[] = [];
  let depth = 0;
  let line = '';

  for (const char of body) {
    if (char === '{' || char === '(' || char === '[') depth += 1;
    if (char === '}' || char === ')' || char === ']') depth -= 1;
    if (char === '\n') {
      if (depth === 0) {
        const match = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\??:/);
        if (match) keys.push(match[1]);
      }
      line = '';
    } else {
      line += char;
    }
  }

  const match = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\??:/);
  if (depth === 0 && match) keys.push(match[1]);
  return keys;
}

function assertSchemaKeys(input: {
  label: string;
  runtimeKeys: string[];
  schemaKeys: string[];
}): void {
  const runtime = new Set(input.runtimeKeys);
  const schema = new Set(input.schemaKeys);
  const missing = input.runtimeKeys.filter((key) => !schema.has(key));
  const stale = input.schemaKeys.filter((key) => !runtime.has(key));

  if (missing.length > 0 || stale.length > 0) {
    console.error(`Challenge intent schema drift detected in ${input.label}.`);
    if (missing.length > 0) {
      console.error(`Runtime fields missing from eval-schema.json: ${missing.join(', ')}`);
    }
    if (stale.length > 0) {
      console.error(`Schema fields not present in runtime interface: ${stale.join(', ')}`);
    }
    process.exitCode = 1;
  }
}

const source = readFileSync('shared/lib/challenge-mode.ts', 'utf-8');
const schema = readJson('shared/lib/eval-schema.json');
const defs = schema.$defs || {};

const runtimeIntent = defs.RuntimeChallengeExecutionIntent;
const runtimeSide = defs.ChallengeExecutionIntentSide;
if (!runtimeIntent?.properties || !runtimeSide?.properties) {
  throw new Error('Missing runtime challenge intent schema definitions');
}

assertSchemaKeys({
  label: 'ChallengeExecutionIntent',
  runtimeKeys: topLevelInterfaceKeys(source, 'ChallengeExecutionIntent'),
  schemaKeys: Object.keys(runtimeIntent.properties),
});

assertSchemaKeys({
  label: 'ChallengeExecutionIntentSide',
  runtimeKeys: topLevelInterfaceKeys(source, 'ChallengeExecutionIntentSide'),
  schemaKeys: Object.keys(runtimeSide.properties),
});

if (process.exitCode) {
  process.exit();
}

console.log('ChallengeExecutionIntent schema synchronized.');
