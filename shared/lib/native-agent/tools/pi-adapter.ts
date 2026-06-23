// ---------------------------------------------------------------------------
// Pi adapter edge — the only new production file that imports Pi/typebox types.
// Callers can import toPiAgentTool directly from this file; registry.ts itself
// does not re-export it, keeping Pi imports out of the registry seam.
// ---------------------------------------------------------------------------
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { TSchema } from 'typebox';
import type { ToolDescriptor } from './types.ts';

// Re-export Pi tool types through the adapter seam so callers (e.g. smoke
// harnesses) that build Pi tools can stay free of direct Pi vendor imports.
export type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';

/**
 * Convert a Wavemill ToolDescriptor into a Pi AgentTool.
 *
 * Pi/typebox types are confined to this file. The rest of the registry API
 * returns Wavemill-native descriptors and metadata only.
 */
export function toPiAgentTool(descriptor: ToolDescriptor): AgentTool<TSchema, unknown> {
  const { metadata, parameters, label, execute } = descriptor;

  return {
    name: metadata.name,
    description: metadata.description,
    parameters: parameters as TSchema,
    label: label ?? metadata.name,
    executionMode: metadata.executionMode,

    async execute(
      toolCallId: string,
      params: unknown,
      signal?: AbortSignal,
    ): Promise<AgentToolResult<unknown>> {
      const result = await execute(toolCallId, params, signal);
      return {
        content: result.content,
        details: result.details,
        ...(result.terminate !== undefined ? { terminate: result.terminate } : {}),
      };
    },
  } as unknown as AgentTool<TSchema, unknown>;
}
