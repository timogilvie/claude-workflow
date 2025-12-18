#!/usr/bin/env node

import { generateDocFromTemplate } from '../generate/doc.js';

const mappings = {
  prd: {
    template: 'prd-prompt-template.md',
    output: (name) => `features/${name}/prd.md`,
    replacementKey: 'PROJECT_SUMMARY',
    description: 'Generate PRD from template (requires --summary)',
  },
  tasks: {
    template: 'tasks-prompt-template.md',
    output: (name) => `features/${name}/tasks.md`,
    replacementKey: null,
    description: 'Generate tasks prompt from template',
  },
  'bug-investigation': {
    template: 'bug-investigation-template.md',
    output: (name) => `bugs/${name}/investigation.md`,
    replacementKey: 'BUG_SUMMARY',
    description: 'Generate bug investigation plan (requires --summary)',
  },
  'bug-hypotheses': {
    template: 'bug-hypothesis-template.md',
    output: (name) => `bugs/${name}/hypotheses.md`,
    replacementKey: null,
    description: 'Generate bug hypotheses template',
  },
  'bug-tasks': {
    template: 'bug-tasks-template.md',
    output: (name) => `bugs/${name}/fix-tasks.md`,
    replacementKey: null,
    description: 'Generate bug fix tasks template',
  },
};

const usage = () => {
  console.log(`Generate docs from shared templates

Usage:
  generate-doc <type> <name> [--summary "text"] [--output path]

Types:
${Object.entries(mappings)
  .map(([key, value]) => `  - ${key}: ${value.description}`)
  .join('\n')}

Examples:
  generate-doc prd add-user-auth --summary "Add user auth: allow login with SSO"
  generate-doc tasks add-user-auth
  generate-doc bug-investigation fix-timeout --summary "Timeout when calling upstream service"`);
};

const parseFlag = (flag) => {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && process.argv[idx + 1]) {
    return process.argv[idx + 1];
  }
  return null;
};

const main = () => {
  const [,, type, name] = process.argv;
  if (!type || ['-h', '--help'].includes(type)) {
    usage();
    process.exit(0);
  }

  const entry = mappings[type];
  if (!entry) {
    console.error(`Unknown type "${type}".`);
    usage();
    process.exit(1);
  }

  if (!name) {
    console.error('Missing name.');
    usage();
    process.exit(1);
  }

  const summary = parseFlag('--summary');
  const outputOverride = parseFlag('--output');

  if (entry.replacementKey && !summary) {
    console.error(`Type "${type}" requires --summary text.`);
    process.exit(1);
  }

  const replacements = entry.replacementKey ? { [entry.replacementKey]: summary } : {};
  const outputPath = outputOverride || entry.output(name);

  try {
    const path = generateDocFromTemplate({
      template: entry.template,
      output: outputPath,
      replacements,
    });
    console.log(`✅ Generated ${type} document at ${path}`);
  } catch (err) {
    console.error(`Error generating document: ${err.message || err}`);
    process.exit(1);
  }
};

main();
