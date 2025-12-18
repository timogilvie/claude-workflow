#!/usr/bin/env node

import { loadConfig } from '../config.js';
import { getBacklog } from '../../shared/lib/linear.js';

const usage = () => {
  console.log(`Codex backlog fetcher

Usage:
  backlog [project-name]

Defaults to the Linear project in codex/config.json if not provided.`);
};

const main = async () => {
  const projectArg = process.argv[2];

  if (projectArg && ['-h', '--help'].includes(projectArg)) {
    usage();
    process.exit(0);
  }

  const config = loadConfig();
  const project = projectArg || config.linear?.defaultProject;

  if (!project) {
    throw new Error('No project specified and no defaultProject in config.');
  }

  try {
    const issues = await getBacklog(project);
    if (!issues.length) {
      console.log(`No backlog items found for project "${project}".`);
      return;
    }

    // Filter to show only parent issues (issues without a parent)
    const parentIssues = issues.filter(issue => !issue.parent);

    console.log(`Backlog items for "${project}" (state=Backlog):\n`);
    parentIssues.forEach((issue, idx) => {
      const labels = (issue.labels?.nodes || []).map((l) => l.name).join(', ') || 'None';
      console.log(`${idx + 1}. ${issue.title}`);
      console.log(`   Project: ${issue.project?.name || 'Unknown'}`);
      console.log(`   State: ${issue.state?.name || 'Unknown'}`);
      console.log(`   Labels: ${labels}`);
      console.log(`   Description: ${(issue.description || '').slice(0, 160) || 'No description'}`);

      // Display child issues if they exist
      if (issue.children?.nodes && issue.children.nodes.length > 0) {
        console.log(`\n   Sub-tasks (${issue.children.nodes.length}):`);
        issue.children.nodes.forEach((child, childIdx) => {
          const childLabels = (child.labels?.nodes || []).map((l) => l.name).join(', ') || 'None';
          console.log(`\n   ${idx + 1}.${childIdx + 1}. ${child.identifier}: ${child.title}`);
          console.log(`      State: ${child.state?.name || 'Unknown'}`);
          if (child.description) {
            const desc = child.description.length > 100
              ? child.description.substring(0, 100) + '...'
              : child.description;
            console.log(`      Description: ${desc}`);
          }
          console.log(`      Labels: ${childLabels}`);
        });
      }
      console.log('');
    });
  } catch (err) {
    console.error(`Error fetching backlog: ${err.message || err}`);
    process.exit(1);
  }
};

main();
