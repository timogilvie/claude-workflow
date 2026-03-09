import { getIssue } from './linear.js';

const PROCESS_TIMEOUT_MS = 30_000;

export interface IssueToolOptions {
  json?: boolean;
}

export function installIssueProcessTimeout(): void {
  setTimeout(() => {
    console.error(`Process timeout: issue fetch exceeded ${PROCESS_TIMEOUT_MS / 1000}s`);
    process.exit(1);
  }, PROCESS_TIMEOUT_MS).unref();
}

export function formatIssueForDisplay(issue: any): string {
  const lines = [
    '',
    `${issue.identifier}: ${issue.title}`,
    `State: ${issue.state?.name || 'Unknown'}`,
    `Priority: ${issue.priority || 'None'}`,
    `Assignee: ${issue.assignee?.name || 'Unassigned'}`,
    `Project: ${issue.project?.name || 'None'}`,
    `Labels: ${issue.labels?.nodes?.map((label: { name: string }) => label.name).join(', ') || 'None'}`,
  ];

  if (issue.parent) {
    lines.push(`Parent: ${issue.parent.identifier} - ${issue.parent.title}`);
  }

  lines.push('', `Description:\n${issue.description || 'No description'}`);

  if (issue.children?.nodes?.length > 0) {
    lines.push('', `Sub-tasks (${issue.children.nodes.length}):`);
    issue.children.nodes.forEach((child: any, index: number) => {
      lines.push(`  ${index + 1}. ${child.identifier}: ${child.title} [${child.state?.name}]`);
      if (child.description) {
        const desc = child.description.length > 150
          ? `${child.description.substring(0, 150)}...`
          : child.description;
        lines.push(`     ${desc}`);
      }
    });
  }

  if (issue.comments?.nodes?.length > 0) {
    lines.push('', `Comments (${issue.comments.nodes.length}):`);
    issue.comments.nodes.forEach((comment: any) => {
      lines.push(`  [${comment.user?.name || 'Unknown'}] ${comment.body}`);
    });
  }

  return `${lines.join('\n')}\n`;
}

export async function printIssue(identifier: string, options: IssueToolOptions = {}): Promise<void> {
  const issue = await getIssue(identifier);

  if (options.json) {
    console.log(JSON.stringify(issue, null, 2));
    return;
  }

  process.stdout.write(formatIssueForDisplay(issue));
}
