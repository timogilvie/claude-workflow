// ---------------------------------------------------------------------------
// Pi adapter edge — the only new production file that imports Pi/typebox types.
// Callers can import toPiAgentTool directly from this file; registry.ts itself
// does not re-export it, keeping Pi imports out of the registry seam.
// ---------------------------------------------------------------------------
import { isDeepStrictEqual } from 'node:util';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { TSchema } from 'typebox';
import type { ToolDescriptor } from './types.ts';
import { redactString, redactPayload } from './redaction.ts';

/**
 * Convert a Wavemill ToolDescriptor into a Pi AgentTool.
 *
 * Pi/typebox types are confined to this file. The rest of the registry API
 * returns Wavemill-native descriptors and metadata only.
 *
 * The adapter applies secret redaction to tool result content and details
 * before handing the result to Pi. Provenance, output-cap, and redaction
 * metadata are stored under `details.__wavemill` for transcript persistence.
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

      // ------------------------------------------------------------------
      // Redact content text blocks
      // ------------------------------------------------------------------
      let contentMatchCount = 0;
      const redactedContent = result.content.map((block) => {
        if (block.type !== 'text') return block;
        const { text, matchCount } = redactString(block.text);
        contentMatchCount += matchCount;
        return { type: 'text' as const, text };
      });

      // ------------------------------------------------------------------
      // Redact details (key-based + pattern-based)
      // ------------------------------------------------------------------
      const originalDetails = result.details;
      const redactedDetails = originalDetails !== undefined && originalDetails !== null
        ? redactPayload(originalDetails)
        : originalDetails;
      const detailsChanged = !isDeepStrictEqual(redactedDetails, originalDetails);

      // ------------------------------------------------------------------
      // Wavemill metadata
      // ------------------------------------------------------------------
      const wavemillMeta = {
        provenance: {
          toolName: metadata.name,
          mutationClass: metadata.class,
          source: 'native-agent' as const,
        },
        outputCap: {
          strategy: metadata.outputCapPolicy.strategy,
          ...(metadata.outputCapPolicy.maxBytes !== undefined
            ? { maxBytes: metadata.outputCapPolicy.maxBytes }
            : {}),
          ...(metadata.outputCapPolicy.maxItems !== undefined
            ? { maxItems: metadata.outputCapPolicy.maxItems }
            : {}),
          truncated:
            typeof redactedDetails === 'object' &&
            redactedDetails !== null &&
            'truncated' in (redactedDetails as object) &&
            (redactedDetails as Record<string, unknown>).truncated === true,
        },
        redaction: {
          applied: contentMatchCount > 0 || detailsChanged,
          matchCount: contentMatchCount,
        },
      };

      // Attach __wavemill to details only when details is a plain object.
      // For undefined/null/primitive/array details we skip metadata injection
      // to preserve existing tool contracts.
      let finalDetails: unknown = redactedDetails;
      if (
        typeof redactedDetails === 'object' &&
        redactedDetails !== null &&
        !Array.isArray(redactedDetails)
      ) {
        finalDetails = {
          ...(redactedDetails as Record<string, unknown>),
          __wavemill: wavemillMeta,
        };
      }

      return {
        content: redactedContent,
        details: finalDetails,
        ...(result.terminate !== undefined ? { terminate: result.terminate } : {}),
      };
    },
  } as unknown as AgentTool<TSchema, unknown>;
}
