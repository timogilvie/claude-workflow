#!/usr/bin/env node

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import readline from 'readline';
import { join, resolve } from 'path';
import { loadConfig } from '../config.js';
import { getBacklog } from '../../shared/lib/linear.js';
import { toKebabCase } from '../../shared/lib/string-utils.js';
import { initState } from '../workflow.js';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (prompt) => new Promise((resolvePrompt) => rl.question(prompt, resolvePrompt));

const ensureDir = (dir) => {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
};

const saveSelectedTask = (epicName, issue, projectName) => {
  const dir = resolve('epics', epicName);
  ensureDir(dir);
  const path = join(dir, 'selected-task.json');
  const payload = {
    taskId: issue.id,
    title: issue.title,
    description: issue.description || '',
    labels: (issue.labels?.nodes || []).map((l) => l.name),
    state: issue.state?.name || '',
    projectName,
    workflowType: 'plan',
    featureName: epicName,
    contextPath: `epics/${epicName}/selected-task.json`,
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
  const input = await question('Select an epic by number: ');
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
    const epicName = toKebabCase(issue.title, 60);

    const contextPath = saveSelectedTask(epicName, issue, project);
    const planPath = `epics/${epicName}/decomposition-plan.json`;

    const state = initState({ featureName: epicName, planPath, config });
    rl.close();

    console.log(`\n✓ Selected: ${issue.title}`);
    console.log(`Epic directory: epics/${epicName}`);
    console.log(`Context saved: ${contextPath}`);
    console.log(`Branch (planned): ${state.branch}`);
    console.log(`Decomposition plan path: ${planPath}`);
    console.log('\nNext steps:');
    console.log(`- Run plan decomposition: wavemill plan`);
    console.log(`- Save plan to ${planPath} and mark plan complete: node codex/src/commands/workflow.js complete ${epicName} --phase plan`);
    console.log(`- Implement sub-issues per plan; complete implement/validate phases via workflow CLI.`);
  } catch (err) {
    rl.close();
    console.error(`Error: ${err.message || err}`);
    process.exit(1);
  }
};

main();
