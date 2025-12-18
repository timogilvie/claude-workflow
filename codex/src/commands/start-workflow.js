#!/usr/bin/env node

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import readline from 'readline';
import { join, resolve } from 'path';
import { loadConfig } from '../config.js';
import { getBacklog } from '../../shared/lib/linear.js';
import { sanitizeBranchName } from '../../shared/lib/git.js';
import { initState } from '../workflow.js';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (prompt) => new Promise((resolvePrompt) => rl.question(prompt, resolvePrompt));

const slugify = (text) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

const ensureDir = (dir) => {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
};

const saveSelectedTask = (featureName, issue, projectName) => {
  const dir = resolve('features', featureName);
  ensureDir(dir);
  const path = join(dir, 'selected-task.json');
  const payload = {
    taskId: issue.id,
    title: issue.title,
    description: issue.description || '',
    labels: (issue.labels?.nodes || []).map((l) => l.name),
    state: issue.state?.name || '',
    projectName,
    workflowType: 'feature',
    featureName,
    contextPath: `features/${featureName}/selected-task.json`,
    selectedAt: new Date().toISOString(),
  };
  writeFileSync(path, JSON.stringify(payload, null, 2));
  return path;
};

const selectBacklogIssue = async (project) => {
  const issues = await getBacklog(project);
  if (!issues.length) {
    throw new Error(`No backlog issues found for project "${project}".`);
  }
  console.log(`Backlog items for "${project}":\n`);
  issues.forEach((issue, idx) => {
    const labels = (issue.labels?.nodes || []).map((l) => l.name).join(', ') || 'None';
    console.log(`${idx + 1}. ${issue.title}`);
    console.log(`   Labels: ${labels}`);
    console.log(`   State: ${issue.state?.name || 'Unknown'}`);
    console.log(`   Description: ${(issue.description || '').slice(0, 160) || 'No description'}\n`);
  });
  const input = await question('Select a task by number: ');
  const index = parseInt(input, 10) - 1;
  if (Number.isNaN(index) || index < 0 || index >= issues.length) {
    throw new Error('Invalid selection.');
  }
  return issues[index];
};

const main = async () => {
  try {
    const config = loadConfig();
    const project = config.linear?.defaultProject;
    if (!project) throw new Error('No defaultProject in config.');

    const issue = await selectBacklogIssue(project);
    const featureName = slugify(issue.title);

    const contextPath = saveSelectedTask(featureName, issue, project);
    const planPath = `features/${featureName}/plan.md`;

    const state = initState({ featureName, planPath, config });
    rl.close();

    console.log(`\n✓ Selected: ${issue.title}`);
    console.log(`Feature directory: features/${featureName}`);
    console.log(`Context saved: ${contextPath}`);
    console.log(`Branch (planned): ${state.branch}`);
    console.log(`Plan path: ${planPath}`);
    console.log('\nNext steps:');
    console.log(`- Generate PRD: node codex/src/commands/generate-doc.js prd ${featureName} --summary "<title + description>"`);
    console.log(`- Generate tasks: node codex/src/commands/generate-doc.js tasks ${featureName}`);
    console.log(`- When plan ready: node codex/src/commands/workflow.js complete ${featureName} --phase plan`);
    console.log(`- After implementation: node codex/src/commands/workflow.js complete ${featureName} --phase implement`);
    console.log(`- After validation: node codex/src/commands/workflow.js complete ${featureName} --phase validate`);
  } catch (err) {
    rl.close();
    console.error(`Error: ${err.message || err}`);
    process.exit(1);
  }
};

main();
