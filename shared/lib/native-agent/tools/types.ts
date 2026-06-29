// ---------------------------------------------------------------------------
// Wavemill-native tool types — no Pi or typebox imports.
// ---------------------------------------------------------------------------

import type { ToolTrustMetadata } from '../provenance.ts';

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
// Tool result metadata (attached additively; optional on all consumers)
// ---------------------------------------------------------------------------

/** Output cap status derived from tool policy and actual details. */
export interface ToolOutputCapMetadata {
  capped: boolean;
  strategy?: OutputCapStrategy;
  limit?: number;
  limitKind?: 'bytes' | 'items' | 'lines';
  originalLength?: number;
  retainedLength?: number;
}

/** Stable provenance fingerprint for a tool invocation. */
export interface ToolProvenanceMetadata {
  tool: string;
  /** First 16 hex chars of SHA-256 over stable-JSON-encoded args. */
  argsFingerprint: string;
}

/** Redaction status for a tool result (content + details). */
export interface ToolRedactionMetadata {
  redacted: boolean;
  matchCount: number;
  categories: string[];
}

/** Aggregate tool result metadata embedded in details.__wavemill and transcript events. */
export interface ToolResultMetadata {
  outputCap?: ToolOutputCapMetadata;
  provenance?: ToolProvenanceMetadata;
  redaction?: ToolRedactionMetadata;
  trust?: ToolTrustMetadata;
}

/** Minimal result shape returned by a Wavemill tool executor. */
export interface WavemillToolResult<TDetails = unknown> {
  /** Text content returned to the model. */
  content: Array<{ type: 'text'; text: string }>;
  /** Structured details for logging or UI rendering. */
  details: TDetails;
  /** Hint to stop the agent loop after this tool batch. */
  terminate?: boolean;
  /** Optional enrichment metadata — attached by the loop, not by executors. */
  metadata?: ToolResultMetadata;
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
