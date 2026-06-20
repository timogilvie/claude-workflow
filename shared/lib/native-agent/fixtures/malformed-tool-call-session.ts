/**
 * Fixture: malformed tool call session.
 *
 * Single-turn session where the model emits a tool call with missing required
 * arguments. Pi-agent-core reports schema validation failure via isError: true
 * in tool_execution_end. The transcript records the error state without throwing.
 * All IDs/timestamps are deterministic.
 */

import type { AgentEvent } from '@earendil-works/pi-agent-core';

const T = 3_000_000_000;

const USAGE = {
  input: 900,
  output: 25,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 925,
  cost: { input: 0.0009, output: 0.00025, cacheRead: 0, cacheWrite: 0, total: 0.00115 },
};

// The model omits the required 'path' argument, producing an empty arguments object.
const assistantWithMalformedCall = {
  role: 'assistant' as const,
  content: [
    { type: 'toolCall' as const, id: 'call_bad_1', name: 'read_file', arguments: {} },
  ],
  api: 'hokusai-mock',
  provider: 'hokusai',
  model: 'hokusai-mini',
  usage: USAGE,
  stopReason: 'toolUse' as const,
  timestamp: T,
};

const malformedToolResult = {
  role: 'toolResult' as const,
  toolCallId: 'call_bad_1',
  toolName: 'read_file',
  content: [{ type: 'text' as const, text: "Tool argument validation failed: required property 'path' is missing" }],
  details: { error: 'validation_failed', missingFields: ['path'] },
  isError: true,
  timestamp: T + 30,
};

export const malformedToolCallSessionInput: AgentEvent[] = [
  { type: 'agent_start' },
  { type: 'turn_start' },
  { type: 'message_start', message: assistantWithMalformedCall },
  { type: 'message_end', message: assistantWithMalformedCall },
  {
    type: 'tool_execution_start',
    toolCallId: 'call_bad_1',
    toolName: 'read_file',
    args: {},
  },
  {
    type: 'tool_execution_end',
    toolCallId: 'call_bad_1',
    toolName: 'read_file',
    result: {
      content: [{ type: 'text', text: "Tool argument validation failed: required property 'path' is missing" }],
      details: { error: 'validation_failed', missingFields: ['path'] },
    },
    isError: true,
  },
  { type: 'turn_end', message: assistantWithMalformedCall, toolResults: [malformedToolResult] },
  { type: 'agent_end', messages: [assistantWithMalformedCall, malformedToolResult] },
];
