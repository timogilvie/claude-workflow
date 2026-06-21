/**
 * Fixture: successful planning session.
 *
 * Two-turn session: first turn emits a read_file tool call, second turn emits
 * a final text answer. All timestamps and IDs are deterministic.
 */

import type { AgentEvent } from '@earendil-works/pi-agent-core';

const T = 1_000_000_000;

const USAGE_TURN_1 = {
  input: 1200,
  output: 40,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 1240,
  cost: { input: 0.001, output: 0.0004, cacheRead: 0, cacheWrite: 0, total: 0.0014 },
};

const USAGE_TURN_2 = {
  input: 1500,
  output: 60,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 1560,
  cost: { input: 0.0015, output: 0.0006, cacheRead: 0, cacheWrite: 0, total: 0.0021 },
};

const assistantTurn1 = {
  role: 'assistant' as const,
  content: [
    { type: 'toolCall' as const, id: 'call_1', name: 'read_file', arguments: { path: 'notes.md' } },
  ],
  api: 'hokusai-mock',
  provider: 'hokusai',
  model: 'hokusai-mini',
  usage: USAGE_TURN_1,
  stopReason: 'toolUse' as const,
  timestamp: T,
};

const toolResult1 = {
  role: 'toolResult' as const,
  toolCallId: 'call_1',
  toolName: 'read_file',
  content: [{ type: 'text' as const, text: 'File content here.' }],
  details: { path: '/workspace/notes.md', bytes: 18 },
  isError: false,
  timestamp: T + 100,
};

const assistantTurn2 = {
  role: 'assistant' as const,
  content: [{ type: 'text' as const, text: 'Planning complete. Read notes.md successfully.' }],
  api: 'hokusai-mock',
  provider: 'hokusai',
  model: 'hokusai-mini',
  usage: USAGE_TURN_2,
  stopReason: 'stop' as const,
  timestamp: T + 200,
};

export const successSessionInput: AgentEvent[] = [
  { type: 'agent_start' },
  { type: 'turn_start' },
  { type: 'message_start', message: assistantTurn1 },
  { type: 'message_end', message: assistantTurn1 },
  { type: 'tool_execution_start', toolCallId: 'call_1', toolName: 'read_file', args: { path: 'notes.md' } },
  {
    type: 'tool_execution_end',
    toolCallId: 'call_1',
    toolName: 'read_file',
    result: { content: [{ type: 'text', text: 'File content here.' }], details: { path: '/workspace/notes.md', bytes: 18 } },
    isError: false,
  },
  { type: 'turn_end', message: assistantTurn1, toolResults: [toolResult1] },
  { type: 'turn_start' },
  { type: 'message_start', message: assistantTurn2 },
  { type: 'message_end', message: assistantTurn2 },
  { type: 'turn_end', message: assistantTurn2, toolResults: [] },
  { type: 'agent_end', messages: [assistantTurn1, toolResult1, assistantTurn2] },
];
