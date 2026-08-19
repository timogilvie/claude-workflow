import { resolve } from 'node:path';
import { checkNativeAgentLaunch } from './check-native-agent-launch.ts';
import { runNativePlanningCanary } from '../shared/lib/native-agent/planning-canary.ts';

interface CliOptions {
  model: string;
  repoDir: string;
  issue: string;
  out?: string;
  dryRun: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    model: 'qwen-3-coder',
    repoDir: process.cwd(),
    issue: 'native-planning-canary',
    dryRun: false,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--model') {
      options.model = argv[++index] ?? options.model;
    } else if (arg === '--repo-dir') {
      options.repoDir = argv[++index] ?? options.repoDir;
    } else if (arg === '--issue') {
      options.issue = argv[++index] ?? options.issue;
    } else if (arg === '--out') {
      options.out = argv[++index];
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log([
        'Usage: npx tsx tools/native-planning-canary.ts [--model qwen-3-coder] [--issue HOK-2779] [--dry-run] [--json]',
        '',
        'Runs gate agreement checks and, unless --dry-run is set, launches a native OpenRouter planning canary.',
      ].join('\n'));
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const evidence = await runNativePlanningCanary({
    modelId: options.model,
    repoDir: resolve(options.repoDir),
    issue: options.issue,
    out: options.out,
    dryRun: options.dryRun,
    preflight: checkNativeAgentLaunch,
  });
  if (options.json) {
    console.log(JSON.stringify(evidence, null, 2));
  } else {
    console.log(`${evidence.status}: ${evidence.summary}`);
  }
  if (evidence.status !== 'launch-succeeded' && !options.dryRun) {
    process.exitCode = 1;
  }
  if (options.dryRun && (!evidence.gates.agree || !evidence.gates.eligible)) {
    process.exitCode = 1;
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
