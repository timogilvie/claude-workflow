import {
  buildDeepSeekDryRunPlan,
  runDeepSeekSmoke,
} from '../shared/lib/deepseek-smoke.ts';

const args = process.argv.slice(2);

// Handle --help
if (args.includes('--help') || args.includes('-h')) {
  console.log(`Usage: npx tsx tools/smoke-deepseek.ts [--live]

DeepSeek smoke test for Claude Code integration.

Options:
  (no args)  Dry-run mode (default): show command and env without running
  --live     Run live smoke test (requires DEEPSEEK_API_KEY)
  --help     Show this help message

Examples:
  npx tsx tools/smoke-deepseek.ts              # Dry-run (no API key needed)
  npx tsx tools/smoke-deepseek.ts --live       # Live test (requires API key)
`);
  process.exit(0);
}

// Handle unknown args
const validArgs = ['--live'];
const unknownArgs = args.filter((arg) => !validArgs.includes(arg));
if (unknownArgs.length > 0) {
  console.error(`Unknown arguments: ${unknownArgs.join(', ')}`);
  console.error('Run with --help for usage information.');
  process.exit(1);
}

const isLive = args.includes('--live');

if (!isLive) {
  // Dry-run mode (default)
  const plan = buildDeepSeekDryRunPlan(process.cwd());
  console.log('=== DeepSeek Smoke Test (Dry Run) ===\n');
  console.log('Command:');
  console.log('  ' + plan.command.join(' '));
  console.log('\nWorking directory:');
  console.log('  ' + plan.cwd);
  console.log('\nIsolated state directory:');
  console.log('  ' + plan.stateDir);
  console.log('\nEnvironment variables (keys only, no secrets):');
  for (const key of plan.envKeys) {
    console.log('  ' + key);
  }
  console.log('\nThis is a dry run. Use --live to run the actual smoke test.');
  process.exit(0);
}

// Live mode
const result = runDeepSeekSmoke(process.cwd());
if (result.exitCode !== 0) {
  if (result.message.includes('skipping')) {
    console.log(result.message);
  } else {
    console.error(result.message);
  }
  process.exit(result.exitCode);
}

console.log(result.message);
