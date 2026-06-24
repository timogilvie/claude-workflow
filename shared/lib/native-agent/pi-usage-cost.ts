import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readJsonlFile } from '../jsonl-utils.ts';
import type {
  SessionAdapter,
  SessionModelUsage,
  SessionScanOptions,
  SessionUsageResult,
} from '../session-adapters.ts';
import { mapPiUsageToSessionModelUsage } from './messages.ts';

export const piUsageToSessionModelUsage = mapPiUsageToSessionModelUsage;

interface NativeSessionStartedRecord {
  type: 'session_started';
  model?: string;
  worktreePath?: string;
  gitBranch?: string;
}

interface NativeAssistantMessageRecord {
  type: 'assistant_message';
  model?: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
}

type NativeTranscriptRecord =
  | NativeSessionStartedRecord
  | NativeAssistantMessageRecord
  | Record<string, unknown>;

export class NativeSessionAdapter implements SessionAdapter {
  scan(opts: SessionScanOptions): SessionUsageResult | null {
    const sessionsRoot = this.discoverSessionsRoot(opts.worktreePath);
    if (!existsSync(sessionsRoot)) {
      return null;
    }

    const models: Record<string, SessionModelUsage> = {};
    let sessionCount = 0;
    let turnCount = 0;

    for (const filePath of this.walkJsonlFiles(sessionsRoot)) {
      const result = this.parseSessionFile(filePath, opts);
      if (!result) {
        continue;
      }

      for (const [modelId, usage] of Object.entries(result.models)) {
        if (!models[modelId]) {
          models[modelId] = {
            inputTokens: 0,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            outputTokens: 0,
          };
        }

        models[modelId].inputTokens += usage.inputTokens;
        models[modelId].cacheCreationTokens += usage.cacheCreationTokens;
        models[modelId].cacheReadTokens += usage.cacheReadTokens;
        models[modelId].outputTokens += usage.outputTokens;
      }

      sessionCount++;
      turnCount += result.turnCount;
    }

    if (turnCount === 0) {
      return null;
    }

    return { models, sessionCount, turnCount };
  }

  discoverSessionsRoot(worktreePath: string): string {
    return join(resolve(worktreePath), '.wavemill', 'sessions');
  }

  private walkJsonlFiles(dir: string): string[] {
    const files: string[] = [];

    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          files.push(...this.walkJsonlFiles(fullPath));
          continue;
        }
        if (entry.name.endsWith('.jsonl')) {
          files.push(fullPath);
        }
      }
    } catch {
      return files;
    }

    return files;
  }

  private parseSessionFile(
    filePath: string,
    opts: SessionScanOptions,
  ): { models: Record<string, SessionModelUsage>; turnCount: number } | null {
    const records = readJsonlFile<NativeTranscriptRecord>(filePath);
    if (records.length === 0) {
      return null;
    }

    let sessionStarted: NativeSessionStartedRecord | null = null;
    const models: Record<string, SessionModelUsage> = {};
    let turnCount = 0;

    for (const record of records) {
      if (record.type === 'session_started' && sessionStarted === null) {
        sessionStarted = record;
        continue;
      }

      if (record.type !== 'assistant_message' || !record.usage) {
        continue;
      }

      const usage = piUsageToSessionModelUsage(record.usage);
      const modelId = record.model || sessionStarted?.model || 'unknown';
      if (!models[modelId]) {
        models[modelId] = {
          inputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          outputTokens: 0,
        };
      }

      models[modelId].inputTokens += usage.inputTokens;
      models[modelId].cacheCreationTokens += usage.cacheCreationTokens;
      models[modelId].cacheReadTokens += usage.cacheReadTokens;
      models[modelId].outputTokens += usage.outputTokens;
      turnCount++;
    }

    if (!this.matchesSession(sessionStarted, opts) || turnCount === 0) {
      return null;
    }

    return { models, turnCount };
  }

  private matchesSession(
    sessionStarted: NativeSessionStartedRecord | null,
    opts: SessionScanOptions,
  ): boolean {
    if (!sessionStarted) {
      return false;
    }

    if (sessionStarted.gitBranch !== undefined) {
      return sessionStarted.gitBranch === opts.branchName;
    }

    if (sessionStarted.worktreePath !== undefined) {
      return resolve(sessionStarted.worktreePath) === resolve(opts.worktreePath);
    }

    return false;
  }
}
