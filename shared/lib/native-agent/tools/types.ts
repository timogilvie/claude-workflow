// ---------------------------------------------------------------------------
// Wavemill-native tool types — no Pi or typebox imports.
// ---------------------------------------------------------------------------

/** Agent workflow phase during which a tool is available. */
export type ToolPhase = 'planning' | 'coding' | 'review';

/** Whether a tool reads or mutates external state. */
export type ToolMutationClass = 'read-only' | 'mutation';

/** How tool calls within a single assistant turn are executed. */
export type ToolExecutionMode = 'parallel' | 'sequential';

/** What the registry does when output exceeds the cap. */
export type OutputCapStrategy = 'none' | 'truncate' | 'reject';

/** Output cap policy stored with the tool descriptor. No enforcement here. */
export interface OutputCapPolicy {
  strategy: OutputCapStrategy;
  /** Maximum bytes allowed in the tool result text. Only meaningful for truncate/reject. */
  maxBytes?: number;
  /** Maximum item count for structured results. Only meaningful for truncate/reject. */
  maxItems?: number;
}

/** Stable, provider-agnostic metadata for a registered tool. */
export interface ToolMetadata {
  name: string;
  description: string;
  class: ToolMutationClass;
  allowedPhases: readonly ToolPhase[];
  executionMode: ToolExecutionMode;
  outputCapPolicy: OutputCapPolicy;
}

// ---------------------------------------------------------------------------
// Tool result metadata (additive — backward-compatible with existing results)
// ---------------------------------------------------------------------------

/** Redaction status for a single tool result. */
export interface ToolResultRedactionMetadata {
  /** True if any secret was replaced in content or details. */
  applied: boolean;
  /** Total count of pattern-match replacements made in content text. */
  matchCount: number;
}

/** Output cap policy state at the time the tool result was produced. */
export interface ToolResultOutputCapMetadata {
  strategy: OutputCapStrategy;
  maxBytes?: number;
  maxItems?: number;
  /** True if the output was truncated by the cap policy. */
  truncated: boolean;
}

/** Provenance information for a tool result. */
export interface ToolResultProvenanceMetadata {
  toolName: string;
  mutationClass: ToolMutationClass;
  source: string;
}

/** Minimal result shape returned by a Wavemill tool executor. */
export interface WavemillToolResult<TDetails = unknown> {
  /** Text content returned to the model. */
  content: Array<{ type: 'text'; text: string }>;
  /** Structured details for logging or UI rendering. */
  details: TDetails;
  /** Hint to stop the agent loop after this tool batch. */
  terminate?: boolean;
  /**
   * Optional metadata attached by the pi-adapter layer.
   * Not propagated to Pi's AgentToolResult directly; stored in
   * details.__wavemill for transcript persistence.
   */
  metadata?: {
    outputCap?: ToolResultOutputCapMetadata;
    provenance?: ToolResultProvenanceMetadata;
    redaction?: ToolResultRedactionMetadata;
  };
}

/** Tool executor function — Wavemill-owned, compatible with Pi AgentTool.execute. */
export type ToolExecutor<TParameters = unknown, TDetails = unknown> = (
  toolCallId: string,
  params: TParameters,
  signal?: AbortSignal,
) => Promise<WavemillToolResult<TDetails>>;

/**
 * Full descriptor for a Wavemill tool.
 *
 * `parameters` is typed as `unknown` to keep Pi/typebox details out of this
 * interface. The pi-adapter edge casts it when constructing the Pi AgentTool.
 */
export interface ToolDescriptor<TParameters = unknown, TDetails = unknown> {
  metadata: ToolMetadata;
  /** JSON Schema or typebox schema for tool parameters (opaque at this seam). */
  parameters: unknown;
  /** Override the display label; defaults to metadata.name at the adapter edge. */
  label?: string;
  execute: ToolExecutor<TParameters, TDetails>;
}
