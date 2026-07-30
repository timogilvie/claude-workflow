import { join } from 'node:path';
import { mutateJsonState } from './state-mutex.ts';

export type WorkflowTerminalOutcome = 'done' | 'failed' | 'aborted';

export interface MarkWorkflowTerminalInput {
  repoDir: string;
  issueId: string;
  outcome: WorkflowTerminalOutcome;
  prNumber?: number | string | null;
  reason?: string;
  source?: string;
  details?: Record<string, unknown>;
  now?: () => Date;
}

interface WorkflowState {
  tasks?: Record<string, Record<string, unknown>>;
  terminalTransitions?: Record<string, Record<string, unknown>>;
  updated?: string;
  [key: string]: unknown;
}

export async function markWorkflowTerminal(input: MarkWorkflowTerminalInput): Promise<WorkflowState> {
  const statePath = join(input.repoDir, '.wavemill', 'workflow-state.json');
  const now = (input.now ?? (() => new Date()))().toISOString();

  return mutateJsonState<WorkflowState>(
    statePath,
    (state) => {
      const tasks = state.tasks ?? {};
      const existingTask = tasks[input.issueId] ?? {};
      const terminal = {
        outcome: input.outcome,
        pr: input.prNumber ?? existingTask.pr ?? null,
        reason: input.reason ?? null,
        source: input.source ?? 'terminal-reconciliation',
        details: input.details ?? {},
        updatedAt: now,
      };

      return {
        ...state,
        tasks: {
          ...tasks,
          [input.issueId]: {
            ...existingTask,
            status: input.outcome,
            phase: input.outcome === 'aborted' ? 'aborted' : 'done',
            terminal,
            updated: now,
          },
        },
        terminalTransitions: {
          ...(state.terminalTransitions ?? {}),
          [input.issueId]: terminal,
        },
        updated: now,
      };
    },
    { createIfMissing: true, initial: { tasks: {} } },
  );
}

export function getWorkflowStatePath(repoDir: string): string {
  return join(repoDir, '.wavemill', 'workflow-state.json');
}
