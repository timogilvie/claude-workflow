/**
 * Fixture: blocked session.
 *
 * Two-turn session: first turn requests a path-escaping file read (blocked by
 * phase policy), second turn acknowledges the denial. All IDs/timestamps are
 * deterministic.
 */

import type { AgentEvent } from '@earendil-works/pi-agent-core';

const T = 2_000_000_000;

const USAGE_TURN_1 = {
  input: 1200,
  output: 40,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 1240,
  cost: { input: 0.001, output: 0.0004, cacheRead: 0, cacheWrite: 0, total: 0.0014 },
};

const USAGE_TURN_2 = {
  input: 1300,
  output: 35,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 1335,
  cost: { input: 0.0013, output: 0.00035, cacheRead: 0, cacheWrite: 0, total: 0.00165 },
};

function makeBlockedToolResult(
  toolCallId: string,
  toolName: string,
  text: string,
  timestamp: number,
) {
  return {
    role: 'toolResult' as const,
    toolCallId,
    toolName,
    content: [{ type: 'text' as const, text }],
    details: { blocked: true },
    isError: true,
    timestamp,
  };
}

const assistantTurn1 = {
  role: 'assistant' as const,
  content: [
    { type: 'toolCall' as const, id: 'call_blocked_1', name: 'read_file', arguments: { path: '../secrets.env' } },
  ],
  api: 'hokusai-mock',
  provider: 'hokusai',
  model: 'hokusai-mini',
  usage: USAGE_TURN_1,
  stopReason: 'toolUse' as const,
  timestamp: T,
};

const blockedToolResult = makeBlockedToolResult(
  'call_blocked_1',
  'read_file',
  "path_denied: '../secrets.env' resolves outside the worktree",
  T + 50,
);

const assistantTurn2 = {
  role: 'assistant' as const,
  content: [
    { type: 'text' as const, text: "The file '../secrets.env' read was denied by phase policy." },
  ],
  api: 'hokusai-mock',
  provider: 'hokusai',
  model: 'hokusai-mini',
  usage: USAGE_TURN_2,
  stopReason: 'stop' as const,
  timestamp: T + 150,
};

export const blockedSessionInput: AgentEvent[] = [
  { type: 'agent_start' },
  { type: 'turn_start' },
  { type: 'message_start', message: assistantTurn1 },
  { type: 'message_end', message: assistantTurn1 },
  {
    type: 'tool_execution_start',
    toolCallId: 'call_blocked_1',
    toolName: 'read_file',
    args: { path: '../secrets.env' },
  },
  {
    type: 'tool_execution_end',
    toolCallId: 'call_blocked_1',
    toolName: 'read_file',
    result: {
      content: [{ type: 'text', text: "path_denied: '../secrets.env' resolves outside the worktree" }],
      details: { blocked: true },
    },
    isError: true,
  },
  { type: 'turn_end', message: assistantTurn1, toolResults: [blockedToolResult] },
  { type: 'turn_start' },
  { type: 'message_start', message: assistantTurn2 },
  { type: 'message_end', message: assistantTurn2 },
  { type: 'turn_end', message: assistantTurn2, toolResults: [] },
  { type: 'agent_end', messages: [assistantTurn1, blockedToolResult, assistantTurn2] },
];

const phaseDeniedAssistantTurn1 = {
  role: 'assistant' as const,
  content: [
    { type: 'toolCall' as const, id: 'call_blocked_2', name: 'patch_file', arguments: { path: 'notes.md' } },
  ],
  api: 'hokusai-mock',
  provider: 'hokusai',
  model: 'hokusai-mini',
  usage: USAGE_TURN_1,
  stopReason: 'toolUse' as const,
  timestamp: T + 500,
};

const phaseDeniedToolResult = makeBlockedToolResult(
  'call_blocked_2',
  'patch_file',
  'phase_denied: tool "patch_file" is not allowed in planning',
  T + 550,
);

const phaseDeniedAssistantTurn2 = {
  role: 'assistant' as const,
  content: [
    { type: 'text' as const, text: 'The patch request was denied during the planning phase.' },
  ],
  api: 'hokusai-mock',
  provider: 'hokusai',
  model: 'hokusai-mini',
  usage: USAGE_TURN_2,
  stopReason: 'stop' as const,
  timestamp: T + 650,
};

export const phaseDeniedSessionInput: AgentEvent[] = [
  { type: 'agent_start' },
  { type: 'turn_start' },
  { type: 'message_start', message: phaseDeniedAssistantTurn1 },
  { type: 'message_end', message: phaseDeniedAssistantTurn1 },
  {
    type: 'tool_execution_start',
    toolCallId: 'call_blocked_2',
    toolName: 'patch_file',
    args: { path: 'notes.md' },
  },
  {
    type: 'tool_execution_end',
    toolCallId: 'call_blocked_2',
    toolName: 'patch_file',
    result: {
      content: [{ type: 'text', text: 'phase_denied: tool "patch_file" is not allowed in planning' }],
      details: { blocked: true },
    },
    isError: true,
  },
  { type: 'turn_end', message: phaseDeniedAssistantTurn1, toolResults: [phaseDeniedToolResult] },
  { type: 'turn_start' },
  { type: 'message_start', message: phaseDeniedAssistantTurn2 },
  { type: 'message_end', message: phaseDeniedAssistantTurn2 },
  { type: 'turn_end', message: phaseDeniedAssistantTurn2, toolResults: [] },
  { type: 'agent_end', messages: [phaseDeniedAssistantTurn1, phaseDeniedToolResult, phaseDeniedAssistantTurn2] },
];
