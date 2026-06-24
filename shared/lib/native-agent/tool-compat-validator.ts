import {
  deriveReadOnlyNativeCapability,
  getEffectiveRegistry,
  type ModelRegistry,
  type NativeProviderName,
  type PiTransportKind,
} from '../model-registry.ts';
import type { NativeRoutingPhase } from './read-only-routing.ts';
import type { ToolMetadata, ToolPhase } from './tools/types.ts';

export type ToolCompatCapabilityName =
  | 'function_calling'
  | 'parallel_tool_calls'
  | 'read_only_native'
  | 'duplicate_tool_name';

export interface ToolCompatDiagnostic {
  model: string;
  provider: string;
  transport: string;
  tool: string;
  unsupportedCapability: ToolCompatCapabilityName;
  message: string;
  /** Phase in which the incompatibility was detected. Omitted when not provided by the caller. */
  phase?: string;
}

export type ToolCompatResult =
  | { ok: true }
  | { ok: false; diagnostics: ToolCompatDiagnostic[] };

export interface ToolCompatInput {
  model: string;
  provider: NativeProviderName;
  transport: PiTransportKind | string;
  tools: readonly Pick<ToolMetadata, 'name' | 'description' | 'executionMode'>[];
  registry?: ModelRegistry;
  allowPartial?: boolean;
  /** When provided, the phase is included in read_only_native diagnostic messages. */
  phase?: NativeRoutingPhase | ToolPhase;
}

interface TransportCapabilitySurface {
  function_calling: boolean;
  parallel_tool_calls: boolean;
}

const TRANSPORT_CAPABILITIES: Record<PiTransportKind, TransportCapabilitySurface> = {
  'openai-completions': {
    function_calling: true,
    parallel_tool_calls: true,
  },
  'openai-responses': {
    function_calling: true,
    parallel_tool_calls: true,
  },
};

/**
 * Typed fail-fast error for unsupported tool/provider combinations.
 */
export class ToolCompatError extends Error {
  readonly diagnostics: ToolCompatDiagnostic[];

  constructor(diagnostics: ToolCompatDiagnostic[]) {
    super(formatDiagnosticsMessage(diagnostics));
    this.name = 'ToolCompatError';
    this.diagnostics = diagnostics;
  }
}

/**
 * Validate tool compatibility for a model/provider/transport combination.
 *
 * Returns structured diagnostics instead of throwing, except for unknown
 * transport identifiers which are treated as configuration errors.
 */
export function validateToolCompat(input: ToolCompatInput): ToolCompatResult {
  if (input.tools.length === 0) {
    return { ok: true };
  }

  const surface = getTransportCapabilities(input.transport);
  const registry = input.registry ?? getEffectiveRegistry();
  const modelCapabilities = registry.models[input.model];
  const diagnostics: ToolCompatDiagnostic[] = [];
  const seenToolNames = new Set<string>();
  const capability = deriveReadOnlyNativeCapability({
    nativeProvider: input.provider,
    piTransportKind: input.transport,
    compatFlags: modelCapabilities?.nativeCapability?.compatFlags,
  });

  for (const tool of input.tools) {
    if (seenToolNames.has(tool.name)) {
      diagnostics.push({
        model: input.model,
        provider: input.provider,
        transport: input.transport,
        tool: tool.name,
        unsupportedCapability: 'duplicate_tool_name',
        message: `Duplicate tool "${tool.name}" is configured for model "${input.model}" on ${input.provider}/${input.transport}.`,
      });
      continue;
    }

    seenToolNames.add(tool.name);

    if (!surface.function_calling) {
      diagnostics.push({
        model: input.model,
        provider: input.provider,
        transport: input.transport,
        tool: tool.name,
        unsupportedCapability: 'function_calling',
        message: `Tool "${tool.name}" requires function calling, but transport "${input.transport}" does not support it for model "${input.model}".`,
      });
      continue;
    }

    if (tool.executionMode === 'parallel' && !surface.parallel_tool_calls) {
      diagnostics.push({
        model: input.model,
        provider: input.provider,
        transport: input.transport,
        tool: tool.name,
        unsupportedCapability: 'parallel_tool_calls',
        message: `Tool "${tool.name}" is configured for parallel execution, but transport "${input.transport}" does not support parallel tool calls for model "${input.model}".`,
      });
      continue;
    }

    if (!modelCapabilities?.nativeCapability) {
      const phaseClause = input.phase ? ` during phase "${input.phase}"` : '';
      diagnostics.push({
        model: input.model,
        provider: input.provider,
        transport: input.transport,
        tool: tool.name,
        unsupportedCapability: 'read_only_native',
        message: `Tool "${tool.name}" is not supported because model "${input.model}" is not registered in the capability registry with native read-only metadata${phaseClause}.`,
        ...(input.phase !== undefined ? { phase: input.phase } : {}),
      });
      continue;
    }

    if (capability.capability === 'unsupported') {
      const phaseClause = input.phase ? ` during phase "${input.phase}"` : '';
      diagnostics.push({
        model: input.model,
        provider: input.provider,
        transport: input.transport,
        tool: tool.name,
        unsupportedCapability: 'read_only_native',
        message: `Tool "${tool.name}" is not supported for model "${input.model}" on ${input.provider}/${input.transport}${phaseClause}: ${capability.limitations.join('; ')}.`,
        ...(input.phase !== undefined ? { phase: input.phase } : {}),
      });
      continue;
    }

    if (capability.capability === 'partial' && input.allowPartial !== true) {
      const phaseClause = input.phase ? ` during phase "${input.phase}"` : '';
      diagnostics.push({
        model: input.model,
        provider: input.provider,
        transport: input.transport,
        tool: tool.name,
        unsupportedCapability: 'read_only_native',
        message: `Tool "${tool.name}" requires certified native read-only support for model "${input.model}" on ${input.provider}/${input.transport}${phaseClause}: ${capability.limitations.join('; ')}.`,
        ...(input.phase !== undefined ? { phase: input.phase } : {}),
      });
    }
  }

  return diagnostics.length === 0 ? { ok: true } : { ok: false, diagnostics };
}

/**
 * Throw a typed error when compatibility validation fails.
 */
export function assertToolCompat(input: ToolCompatInput): void {
  const result = validateToolCompat(input);
  if (!result.ok) {
    throw new ToolCompatError(result.diagnostics);
  }
}

function getTransportCapabilities(
  transport: ToolCompatInput['transport'],
): TransportCapabilitySurface {
  const capabilities = TRANSPORT_CAPABILITIES[transport as PiTransportKind];
  if (!capabilities) {
    throw new Error(`Unknown provider transport "${transport}"`);
  }
  return capabilities;
}

function formatDiagnosticsMessage(diagnostics: readonly ToolCompatDiagnostic[]): string {
  const lines = ['Unsupported tool/provider combination(s):'];
  for (const diagnostic of diagnostics) {
    lines.push(
      `- model=${diagnostic.model} provider=${diagnostic.provider} transport=${diagnostic.transport} tool=${diagnostic.tool} capability=${diagnostic.unsupportedCapability}: ${diagnostic.message}`,
    );
  }
  return lines.join('\n');
}
