#!/usr/bin/env ts-node
import { LinearClient } from '@linear/sdk';
import { readFileSync } from 'fs';
import dotenv from 'dotenv';

dotenv.config();

const linearClient = new LinearClient({
  apiKey: process.env.LINEAR_API_KEY!
});

async function main() {
  // Read the plan
  const plan = JSON.parse(readFileSync('/tmp/linear-decomposition-plan.json', 'utf-8'));
  const request = JSON.parse(readFileSync('/tmp/linear-decomposition-request.json', 'utf-8'));

  // Get the team
  const teams = await linearClient.teams();
  const team = teams.nodes[0]; // Use first team (Hokusai)

  console.log(`Using team: ${team.name} (${team.key})`);

  // Get the project
  const projects = await linearClient.projects({
    filter: { name: { eq: request.projectName } }
  });

  if (projects.nodes.length === 0) {
    throw new Error(`Project "${request.projectName}" not found`);
  }

  const project = projects.nodes[0];
  console.log(`Using project: ${project.name}`);

  // Find the parent issue
  const backlog = await linearClient.issues({
    filter: {
      team: { key: { eq: team.key } },
      project: { id: { eq: project.id } },
      state: { name: { eq: "Backlog" } },
      title: { contains: "Onboarding flow" }
    }
  });

  const parentIssue = backlog.nodes[0];
  if (!parentIssue) {
    throw new Error('Parent issue "Onboarding flow" not found in backlog');
  }

  console.log(`Found parent issue: ${parentIssue.identifier} - ${parentIssue.title}`);

  // Create milestone for this epic
  const milestoneInput = {
    name: `Onboarding Flow Implementation`,
    projectId: project.id
  };

  const milestone = await linearClient.projectMilestoneCreate(milestoneInput);
  const milestoneId = (await milestone.projectMilestone)?.id;
  console.log(`Created milestone: ${milestoneInput.name}`);

  // Create all sub-issues
  const createdIssues: string[] = [];

  for (let i = 0; i < plan.subIssues.length; i++) {
    const subIssue = plan.subIssues[i];

    // Build enhanced description
    const enhancedDescription = `
**Parent Epic:** ${parentIssue.identifier} - ${parentIssue.title}
**Issue ${i + 1} of ${plan.subIssues.length}**

---

${subIssue.description}

---

**Master Document:** ${plan.masterDocumentPath || 'N/A'}

**Relevant Files:**
${plan.relevantFiles.map((f: string) => `- \`${f}\``).join('\\n')}
`;

    const issueInput = {
      teamId: team.id,
      projectId: project.id,
      projectMilestoneId: milestoneId,
      parentId: parentIssue.id,
      title: subIssue.title,
      description: enhancedDescription,
      estimate: subIssue.estimate,
      priority: subIssue.priority || 0,
      stateId: (await team.states()).nodes.find((s: any) => s.name === 'Backlog')?.id
    };

    const result = await linearClient.issueCreate(issueInput);
    const issue = await result.issue;

    if (issue) {
      createdIssues.push(issue.id);
      console.log(`✓ Created: ${issue.identifier} - ${subIssue.title}`);
    }
  }

  // Create dependencies (blocks relationships)
  console.log('\\nCreating dependencies...');
  for (let i = 0; i < plan.subIssues.length; i++) {
    const subIssue = plan.subIssues[i];
    if (subIssue.dependencies && subIssue.dependencies.length > 0) {
      for (const depIndex of subIssue.dependencies) {
        // Issue i is blocked by issue depIndex
        await linearClient.issueRelationCreate({
          issueId: createdIssues[i],
          relatedIssueId: createdIssues[depIndex],
          type: 'blocks' // depIndex blocks i
        });
        console.log(`  Issue ${i + 1} blocked by issue ${depIndex + 1}`);
      }
    }
  }

  console.log('\\n✅ All issues created successfully!');
  console.log(`\\nView parent epic: ${parentIssue.url}`);
}

main().catch(console.error);
