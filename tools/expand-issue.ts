#!/usr/bin/env -S npx tsx
// @ts-nocheck

/**
 * Expand Linear Issue Tool
 *
 * Takes a Linear issue ID or URL, fetches the current issue details,
 * uses your local Claude CLI with the issue-writer.md prompt to expand it
 * into a comprehensive task packet, and optionally updates the Linear issue.
 *
 * Usage:
 *   npx tsx tools/expand-issue.ts LIN-123
 *   npx tsx tools/expand-issue.ts LIN-123 --update
 *   npx tsx tools/expand-issue.ts https://linear.app/team/issue/LIN-123
 */

import dotenv from 'dotenv';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LINEAR_ENDPOINT = 'https://api.linear.app/graphql';
const LINEAR_API_KEY = process.env.LINEAR_API_KEY;
const CLAUDE_CMD = process.env.CLAUDE_CMD || 'claude';

if (!LINEAR_API_KEY) {
  console.error('Error: LINEAR_API_KEY not found in environment');
  process.exit(1);
}

// Linear API helpers
async function linearRequest(query: string, variables?: any) {
  const res = await fetch(LINEAR_ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': LINEAR_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });

  const data = await res.json();
  if (data.errors) {
    throw new Error(`Linear API error: ${JSON.stringify(data.errors)}`);
  }
  return data.data;
}

async function getIssue(identifier: string) {
  const data = await linearRequest(`
    query($identifier: String!) {
      issue(id: $identifier) {
        id
        identifier
        title
        description
        state { name }
        labels { nodes { name } }
        project { id name }
        priority
        estimate
        assignee { name email }
        creator { name email }
        team { id name key }
        parent {
          identifier
          title
        }
        children {
          nodes {
            identifier
            title
            state { name }
          }
        }
        url
      }
    }
  `, { identifier });

  return data.issue;
}

async function updateIssue(issueId: string, description: string) {
  const data = await linearRequest(`
    mutation($issueId: String!, $description: String!) {
      issueUpdate(
        id: $issueId
        input: { description: $description }
      ) {
        success
        issue {
          id
          identifier
          url
        }
      }
    }
  `, { issueId, description });

  return data.issueUpdate;
}

// Claude CLI helper - uses your local Claude subscription
async function expandWithClaude(prompt: string, issueContext: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const fullPrompt = `${prompt}\n\n---\n\n${issueContext}`;

    const claude = spawn(CLAUDE_CMD, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    claude.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    claude.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    claude.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Claude CLI exited with code ${code}: ${stderr}`));
      } else {
        resolve(stdout.trim());
      }
    });

    claude.on('error', (error) => {
      reject(new Error(`Failed to spawn Claude CLI: ${error.message}`));
    });

    // Send prompt to Claude via stdin
    claude.stdin.write(fullPrompt);
    claude.stdin.end();
  });
}

// Extract issue identifier from various input formats
function parseIssueInput(input: string): string {
  // Handle full Linear URLs
  const urlMatch = input.match(/linear\.app\/[^/]+\/issue\/([A-Z]+-\d+)/);
  if (urlMatch) return urlMatch[1];

  // Handle direct identifier
  const idMatch = input.match(/^([A-Z]+-\d+)$/);
  if (idMatch) return idMatch[1];

  throw new Error(`Invalid issue identifier: ${input}. Expected format: LIN-123 or Linear URL`);
}

// Format issue context for Claude
function formatIssueContext(issue: any): string {
  let context = `# Issue Details\n\n`;
  context += `**Issue ID**: ${issue.identifier}\n`;
  context += `**Title**: ${issue.title}\n`;
  context += `**URL**: ${issue.url}\n`;
  context += `**State**: ${issue.state?.name || 'Unknown'}\n`;
  context += `**Project**: ${issue.project?.name || 'None'}\n`;
  context += `**Team**: ${issue.team?.name || 'Unknown'} (${issue.team?.key})\n`;

  if (issue.priority) {
    const priorities = ['No priority', 'Urgent', 'High', 'Normal', 'Low'];
    context += `**Priority**: ${priorities[issue.priority] || issue.priority}\n`;
  }

  if (issue.estimate) {
    context += `**Estimate**: ${issue.estimate} points\n`;
  }

  if (issue.assignee) {
    context += `**Assignee**: ${issue.assignee.name}\n`;
  }

  if (issue.labels?.nodes.length > 0) {
    context += `**Labels**: ${issue.labels.nodes.map((l: any) => l.name).join(', ')}\n`;
  }

  if (issue.parent) {
    context += `**Parent Issue**: ${issue.parent.identifier} - ${issue.parent.title}\n`;
  }

  if (issue.children?.nodes.length > 0) {
    context += `\n**Sub-tasks** (${issue.children.nodes.length}):\n`;
    issue.children.nodes.forEach((child: any) => {
      context += `- ${child.identifier}: ${child.title} (${child.state?.name})\n`;
    });
  }

  context += `\n## Current Description\n\n`;
  context += issue.description || '*(No description provided)*';

  return context;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`
Expand Linear Issue Tool

Usage:
  npx tsx tools/expand-issue.ts <issue-id> [options]

Arguments:
  <issue-id>     Linear issue identifier (e.g., LIN-123) or full Linear URL

Options:
  --update       Update the Linear issue with the expanded description
  --dry-run      Show what would be updated without making changes (default)
  --output FILE  Save expanded description to file instead of stdout
  --help, -h     Show this help message

Examples:
  # Preview expanded issue (dry-run)
  npx tsx tools/expand-issue.ts LIN-123

  # Update Linear issue with expanded description
  npx tsx tools/expand-issue.ts LIN-123 --update

  # Save to file without updating Linear
  npx tsx tools/expand-issue.ts LIN-123 --output expanded-issue.md

  # Use Linear URL
  npx tsx tools/expand-issue.ts https://linear.app/myteam/issue/LIN-123 --update

Environment Variables:
  LINEAR_API_KEY   Required: Linear API key
  CLAUDE_CMD       Optional: Claude CLI command (default: 'claude')
    `);
    process.exit(0);
  }

  const issueInput = args[0];
  const shouldUpdate = args.includes('--update');
  const outputFileIndex = args.indexOf('--output');
  const outputFile = outputFileIndex >= 0 ? args[outputFileIndex + 1] : null;

  try {
    // Parse and fetch issue
    console.log('Fetching issue details...');
    const identifier = parseIssueInput(issueInput);
    const issue = await getIssue(identifier);

    if (!issue) {
      console.error(`Issue not found: ${identifier}`);
      process.exit(1);
    }

    console.log(`Found: ${issue.identifier} - ${issue.title}`);
    console.log(`Project: ${issue.project?.name || 'None'}`);
    console.log(`State: ${issue.state?.name}\n`);

    // Load issue-writer prompt
    console.log('Loading issue-writer prompt...');
    const promptPath = path.join(__dirname, '../prompts/issue-writer.md');
    const promptTemplate = await fs.readFile(promptPath, 'utf-8');

    // Format issue context
    const issueContext = formatIssueContext(issue);

    // Expand with Claude
    console.log('Expanding issue with Claude...\n');
    console.log('─'.repeat(80));
    const expandedDescription = await expandWithClaude(promptTemplate, issueContext);
    console.log('─'.repeat(80));
    console.log('\n');

    // Handle output
    if (outputFile) {
      await fs.writeFile(outputFile, expandedDescription, 'utf-8');
      console.log(`✓ Expanded description saved to: ${outputFile}`);
    } else {
      console.log('Expanded Description:\n');
      console.log(expandedDescription);
      console.log('\n');
    }

    // Update Linear if requested
    if (shouldUpdate) {
      console.log(`Updating Linear issue ${issue.identifier}...`);
      const result = await updateIssue(issue.id, expandedDescription);

      if (result.success) {
        console.log(`✓ Successfully updated: ${result.issue.url}`);
      } else {
        console.error('Failed to update issue');
        process.exit(1);
      }
    } else {
      console.log('ℹ Dry-run mode (use --update to save to Linear)');
    }

  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();
