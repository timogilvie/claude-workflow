import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeCodeConventions, type ConventionAnalysis } from './context-analyzer.ts';
import { analyzeRepoContext } from './repo-context-analyzer.ts';
import { detectSubsystems } from './subsystem-detector.ts';
import { writeSubsystemSpecs } from './subsystem-spec-generator.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface FillProjectContextTemplateOptions {
  template: string;
  repoContext: ReturnType<typeof analyzeRepoContext>;
  conventions: ConventionAnalysis;
  timestamp: string;
}

/**
 * Fill the project-context template with detected repository metadata and placeholders.
 */
export function fillProjectContextTemplate(opts: FillProjectContextTemplateOptions): string {
  let template = opts.template;
  const { repoContext, conventions, timestamp } = opts;

  template = template.replace('{TIMESTAMP}', timestamp);

  template = template.replace(
    '{ARCHITECTURE_OVERVIEW}',
    'TODO: Add high-level architecture description here.'
  );
  template = template.replace(
    '{ARCHITECTURE_DECISIONS}',
    'TODO: Document key architectural decisions'
  );
  template = template.replace(
    '{INTEGRATION_POINTS}',
    'TODO: Describe system boundaries and external integrations'
  );
  template = template.replace(
    '{DATA_FLOW}',
    'TODO: Describe how data flows through the system'
  );

  const languages = repoContext.languages
    ? Object.entries(repoContext.languages)
        .map(([lang, pct]) => `- ${lang}: ${pct}%`)
        .join('\n')
    : `- ${repoContext.primaryLanguage}`;

  const frameworks = repoContext.frameworks
    ? repoContext.frameworks.map((framework) => `- ${framework}`).join('\n')
    : '- None detected';

  template = template.replace('{LANGUAGES}', languages);
  template = template.replace('{FRAMEWORKS}', frameworks);
  template = template.replace('{BUILD_SYSTEM}', repoContext.buildSystem || 'Not detected');
  template = template.replace('{PACKAGE_MANAGER}', repoContext.packageManager || 'Not detected');
  template = template.replace(
    '{TEST_FRAMEWORK}',
    repoContext.testFrameworks?.join(', ') || 'Not detected'
  );
  template = template.replace('{CI_PROVIDER}', repoContext.ciProvider || 'Not detected');

  const dirStructure = conventions.structure.topLevelDirs.join('\n');
  template = template.replace('{DIRECTORY_STRUCTURE}', dirStructure || '(empty)');

  const sourceDir = conventions.structure.sourceDir || 'src';
  const testDir = conventions.structure.testDir || 'tests';

  template = template.replace(
    '{MODULE_BOUNDARIES}',
    `- Source code: \`${sourceDir}/\`\n- Tests: \`${testDir}/\`\n- Config: Root directory`
  );

  template = template.replace(
    '{NAMING_CONVENTIONS}',
    'TODO: Document file naming conventions (e.g., PascalCase for components, camelCase for utilities)'
  );

  const { patterns } = conventions;

  if (patterns.stateManagement) {
    template = template.replace(
      '{STATE_MANAGEMENT_PATTERN}',
      `Using **${patterns.stateManagement}** for state management.`
    );
    template = template.replace('{STATE_PATTERN_DETAILS}', patterns.stateManagement);
    template = template.replace(
      '{STATE_LOCATION}',
      'TODO: Document where state lives (e.g., `src/store/`, `src/context/`)'
    );
    template = template.replace(
      '{STATE_HOWTO}',
      'TODO: Document how to add new state (e.g., create new slice, add to store)'
    );
  } else {
    template = template.replace('{STATE_MANAGEMENT_PATTERN}', '');
    template = template.replace('{STATE_PATTERN_DETAILS}', 'Not detected - TODO: Document if applicable');
    template = template.replace('{STATE_LOCATION}', '');
    template = template.replace('{STATE_HOWTO}', '');
  }

  if (patterns.apiClient) {
    template = template.replace(
      '{API_INTEGRATION_PATTERN}',
      `Using **${patterns.apiClient}** for API calls.`
    );
    template = template.replace('{HTTP_CLIENT}', patterns.apiClient);
    template = template.replace(
      '{ERROR_HANDLING}',
      patterns.errorHandling || 'TODO: Document error handling approach'
    );
    template = template.replace(
      '{AUTH_FLOW}',
      'TODO: Document authentication flow (e.g., JWT, OAuth, session cookies)'
    );
  } else {
    template = template.replace('{API_INTEGRATION_PATTERN}', '');
    template = template.replace('{HTTP_CLIENT}', 'Not detected - TODO: Document if applicable');
    template = template.replace('{ERROR_HANDLING}', '');
    template = template.replace('{AUTH_FLOW}', '');
  }

  const testFramework = repoContext.testFrameworks?.[0] || 'Not detected';
  template = template.replace(
    '{TESTING_PATTERN}',
    `Using **${testFramework}** for testing.`
  );
  template = template.replace('{TEST_FRAMEWORK_DETAILS}', testFramework);

  const testPatternsList = patterns.testPatterns?.length
    ? patterns.testPatterns.map((pattern) => `- ${pattern}`).join('\n')
    : '- TODO: Document test patterns';

  template = template.replace('{TEST_LOCATIONS}', testPatternsList);
  template = template.replace(
    '{MOCKING}',
    'TODO: Document mocking patterns (e.g., jest.mock, MSW for API mocking)'
  );

  if (patterns.styling) {
    template = template.replace(
      '{STYLING_PATTERN}',
      `Using **${patterns.styling}** for styling.`
    );
    template = template.replace('{CSS_APPROACH}', patterns.styling);
    template = template.replace(
      '{COMPONENT_PATTERNS}',
      'TODO: Document component patterns (e.g., atomic design, feature-based)'
    );
    template = template.replace(
      '{RESPONSIVE}',
      'TODO: Document responsive design approach (e.g., mobile-first, breakpoints)'
    );
  } else {
    template = template.replace('{STYLING_PATTERN}', '');
    template = template.replace('{CSS_APPROACH}', 'Not detected - TODO: Document if applicable');
    template = template.replace('{COMPONENT_PATTERNS}', '');
    template = template.replace('{RESPONSIVE}', '');
  }

  template = template.replace(
    '{ENV_VARS}',
    'TODO: Document required environment variables and their purpose'
  );
  template = template.replace(
    '{CONFIG_FILES}',
    conventions.structure.configFiles.map((file) => `- \`${file}\``).join('\n') || '- None'
  );
  template = template.replace(
    '{SECRETS}',
    'TODO: Document how secrets are managed (e.g., .env files, secret manager)'
  );

  template = template.replace(
    '{GETTING_STARTED}',
    'TODO: Document setup steps (e.g., `npm install`, environment setup)'
  );
  template = template.replace(
    '{RUN_LOCALLY}',
    'TODO: Document how to run locally (e.g., `npm run dev`, `make run`)'
  );
  template = template.replace(
    '{RUN_TESTS}',
    'TODO: Document how to run tests (e.g., `npm test`, `make test`)'
  );
  template = template.replace(
    '{BUILD_PROD}',
    'TODO: Document production build process (e.g., `npm run build`)'
  );

  if (conventions.gotchas.length > 0) {
    const gotchasList = conventions.gotchas.map((gotcha) => `- ${gotcha}`).join('\n');
    template = template.replace('{GOTCHAS}', gotchasList);
  } else {
    template = template.replace('{GOTCHAS}', 'None documented yet.');
  }

  return template;
}

/**
 * Generate `.wavemill/project-context.md` and subsystem docs for a repository.
 */
export async function generateProjectContext(opts: { repoDir: string; force: boolean }): Promise<void> {
  const { repoDir, force } = opts;

  console.log(`Analyzing repository: ${repoDir}`);

  const wavemillDir = join(repoDir, '.wavemill');
  if (!existsSync(wavemillDir)) {
    console.log('Creating .wavemill directory...');
    mkdirSync(wavemillDir, { recursive: true });
  }

  const contextPath = join(wavemillDir, 'project-context.md');
  if (existsSync(contextPath) && !force) {
    console.error('Error: project-context.md already exists');
    console.error('Use --force to overwrite');
    process.exit(1);
  }

  console.log('Analyzing repository structure...');
  const repoContext = analyzeRepoContext(repoDir);

  console.log('Detecting code patterns and conventions...');
  const conventions = analyzeCodeConventions(repoDir);

  const templatePath = join(dirname(dirname(__dirname)), 'tools', 'prompts', 'project-context-template.md');
  const template = readFileSync(templatePath, 'utf-8');
  const timestamp = new Date().toISOString();
  const filledTemplate = fillProjectContextTemplate({
    template,
    repoContext,
    conventions,
    timestamp,
  });

  writeFileSync(contextPath, filledTemplate, 'utf-8');

  console.log(`\n✓ Successfully created: ${contextPath}`);

  console.log('\nDetecting subsystems...');
  const subsystems = detectSubsystems(repoDir, {
    minFiles: 3,
    useGitAnalysis: true,
    maxSubsystems: 20,
  });

  if (subsystems.length > 0) {
    console.log(`Found ${subsystems.length} subsystem(s):`);
    subsystems.forEach((subsystem) =>
      console.log(
        `  - ${subsystem.name} (${subsystem.keyFiles.length} files, confidence: ${(subsystem.confidence * 100).toFixed(0)}%)`
      )
    );

    const contextDir = join(wavemillDir, 'context');
    if (!existsSync(contextDir)) {
      mkdirSync(contextDir, { recursive: true });
    }

    console.log('\nGenerating subsystem specifications...');
    writeSubsystemSpecs(subsystems, contextDir, {
      repoDir,
      includeGitHistory: true,
    });

    console.log(`✓ Created ${subsystems.length} subsystem spec(s) in ${contextDir}`);

    const subsystemLinks = subsystems
      .map((subsystem) => `- [${subsystem.name}](context/${subsystem.id}.md) - ${subsystem.description}`)
      .join('\n');

    const subsystemSection = `\n\n## Subsystem Documentation\n\nFor detailed documentation on specific subsystems, see \`.wavemill/context/\`:\n\n${subsystemLinks}\n\n---`;

    const updatedContext = readFileSync(contextPath, 'utf-8').replace(
      /## Recent Work/,
      subsystemSection + '\n## Recent Work'
    );
    writeFileSync(contextPath, updatedContext, 'utf-8');

    console.log('✓ Updated project-context.md with subsystem references');
  } else {
    console.log('No subsystems detected (repo may be too small or unstructured)');
  }

  console.log('\nNext steps:');
  console.log('1. Review and fill in TODO sections in project-context.md');
  console.log('2. Review subsystem specs in .wavemill/context/ and add domain-specific details');
  console.log('3. Document architecture decisions and patterns');
  console.log('4. The "Recent Work" section will be auto-updated after each PR merge');
  console.log('\nTo use this context in issue expansion:');
  console.log('  npx tsx tools/expand-issue.ts <issue-id>');
}
