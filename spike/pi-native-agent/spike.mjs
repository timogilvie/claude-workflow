// Throwaway spike for docs/native-agent-runtime-plan.md "Pi source spike findings".
//
// Goal: prove in CODE (not on paper) that pi-agent-core can be embedded as
// Wavemill's native runtime while Wavemill keeps ownership of tool execution,
// phase policy, and the transcript. It exercises three kill criteria:
//
//   (a) Phase policy runs BEFORE tool execution and a denial is fed back to the
//       model  ->  AgentLoopConfig.beforeToolCall({ block, reason })
//   (b) A custom "Hokusai" provider is registered with NO core fork
//       ->  registerApiProvider({ api, stream, streamSimple }) + Model.api
//   (c) Provider usage maps cleanly onto a Wavemill SessionModelUsage shape
//       ->  pi `Usage{input,output,cacheRead,cacheWrite}`
//
// The provider is a deterministic mock (no network): turn 1 emits two tool
// calls (one allowed read, one path-escaping read), turn 2 emits a final answer.
// Wavemill owns the read_file executor and the planning-phase policy.

import { registerApiProvider, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { agentLoop } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { readFileSync } from "node:fs";
import { resolve, relative, isAbsolute, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKTREE = resolve(HERE, "sandbox"); // pretend per-task worktree root

// ---------------------------------------------------------------------------
// (b) Custom provider: a deterministic mock "Hokusai" model, registered through
// the same public path a real custom/self-hosted model would use. No fork.
// ---------------------------------------------------------------------------
function mkUsage(input, output) {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function hokusaiStreamSimple(model, context, _options) {
  const stream = createAssistantMessageEventStream();
  const sawToolResults = context.messages.some((m) => m.role === "toolResult");
  const now = Date.now();

  const message = !sawToolResults
    ? {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call_1", name: "read_file", arguments: { path: "notes.md" } },
          { type: "toolCall", id: "call_2", name: "read_file", arguments: { path: "../secrets.env" } },
        ],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: mkUsage(1200, 40),
        stopReason: "toolUse",
        timestamp: now,
      }
    : {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Planning complete. Read notes.md; the ../secrets.env read was denied by phase policy.",
          },
        ],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: mkUsage(1500, 60),
        stopReason: "stop",
        timestamp: now,
      };

  stream.push({ type: "start", partial: message });
  stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
  return stream;
}

registerApiProvider({ api: "hokusai-mock", stream: hokusaiStreamSimple, streamSimple: hokusaiStreamSimple });

const hokusaiModel = {
  id: "hokusai-mini",
  name: "Hokusai Mini (mock)",
  api: "hokusai-mock", // <- resolved via getApiProvider() in streamSimple dispatch
  provider: "hokusai",
  baseUrl: "http://localhost:0/mock",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 8192,
};

// ---------------------------------------------------------------------------
// Wavemill-owned read-only tool. The EXECUTOR is Wavemill code, not Pi's.
// ---------------------------------------------------------------------------
const readFileTool = {
  name: "read_file",
  label: "Read File",
  description: "Read a UTF-8 text file from the worktree.",
  parameters: Type.Object({ path: Type.String() }),
  execute: async (_toolCallId, params) => {
    const abs = resolve(WORKTREE, params.path);
    const text = readFileSync(abs, "utf8");
    return { content: [{ type: "text", text }], details: { path: abs, bytes: text.length } };
  },
};

// ---------------------------------------------------------------------------
// (a) Planning-phase policy. Evaluates only Wavemill-controlled state (the
// phase + the worktree boundary), runs BEFORE execute, and blocks with a reason
// that the loop feeds back to the model as an error tool result.
// ---------------------------------------------------------------------------
const policyDecisions = [];
async function planningPhasePolicy({ toolCall, args }) {
  // Read-only phase: only read_file is exposed.
  if (toolCall.name !== "read_file") {
    const d = { call: toolCall.name, decision: "deny", reason: `phase_denied: '${toolCall.name}' not allowed in planning` };
    policyDecisions.push(d);
    return { block: true, reason: d.reason };
  }
  const abs = resolve(WORKTREE, args.path);
  const rel = relative(WORKTREE, abs);
  const escapesWorktree = rel.startsWith("..") || isAbsolute(rel);
  if (escapesWorktree) {
    const d = { call: `read_file(${args.path})`, decision: "deny", reason: `path_denied: '${args.path}' resolves outside the worktree` };
    policyDecisions.push(d);
    return { block: true, reason: d.reason };
  }
  policyDecisions.push({ call: `read_file(${args.path})`, decision: "allow" });
  return undefined; // allow
}

// ---------------------------------------------------------------------------
// Drive the loop. Wavemill supplies convertToLlm (its messages are already
// provider-shaped here), the phase policy, and the tool registry.
// ---------------------------------------------------------------------------
const config = {
  model: hokusaiModel,
  convertToLlm: (messages) => messages, // pass-through: all are base LLM messages
  beforeToolCall: planningPhasePolicy,
  toolExecution: "sequential",
};

const context = {
  systemPrompt: "You are a read-only planning agent.",
  messages: [],
  tools: [readFileTool],
};
const prompts = [{ role: "user", content: "Plan the change: read notes.md and the secrets file.", timestamp: Date.now() }];

// Derive a Wavemill-style NativeAgentEvent transcript from Pi's AgentEvent stream.
const nativeEvents = [];
const toolResults = [];
const usageTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };

function mapToNative(ev) {
  switch (ev.type) {
    case "agent_start": return { type: "session_started" };
    case "turn_start": return { type: "turn_started" };
    case "message_end":
      if (ev.message.role === "assistant") {
        const u = ev.message.usage;
        if (u) {
          usageTotals.inputTokens += u.input;
          usageTotals.outputTokens += u.output;
          usageTotals.cacheReadTokens += u.cacheRead;
          usageTotals.cacheCreationTokens += u.cacheWrite;
        }
        return { type: "assistant_message", stopReason: ev.message.stopReason };
      }
      return null;
    case "tool_execution_start": return { type: "tool_started", call: ev.toolName, args: ev.args };
    case "tool_execution_end": {
      const reason = ev.result?.content?.[0]?.text;
      toolResults.push({ call: ev.toolName, isError: ev.isError, text: reason });
      return { type: "tool_result", call: ev.toolName, isError: ev.isError };
    }
    case "agent_end": return { type: "phase_completed" };
    default: return null;
  }
}

const stream = agentLoop(prompts, context, config);
for await (const ev of stream) {
  const native = mapToNative(ev);
  if (native) nativeEvents.push(native);
}
await stream.result();

writeFileSync(resolve(HERE, "native-session.jsonl"), nativeEvents.map((e) => JSON.stringify(e)).join("\n") + "\n");

// ---------------------------------------------------------------------------
// Assertions / report
// ---------------------------------------------------------------------------
const blocked = toolResults.find((t) => t.isError);
const allowed = toolResults.find((t) => !t.isError);
const customProviderDispatched = nativeEvents.some((e) => e.type === "assistant_message");

const checks = [
  {
    id: "(b) custom provider, no core fork",
    pass: customProviderDispatched,
    detail: `registerApiProvider({api:"hokusai-mock"}) dispatched via streamSimple -> getApiProvider()`,
  },
  {
    id: "(a) policy blocks BEFORE exec, reason fed back",
    pass: Boolean(blocked) && Boolean(allowed) && /path_denied/.test(blocked?.text || ""),
    detail: blocked ? `blocked: ${blocked.text}` : "no blocked tool result found",
  },
  {
    id: "(c) usage -> SessionModelUsage shape",
    pass: usageTotals.inputTokens === 2700 && usageTotals.outputTokens === 100,
    detail: JSON.stringify(usageTotals),
  },
];

console.log("\n=== Pi native-runtime embed spike ===\n");
console.log("Phase-policy decisions (pre-exec):");
for (const d of policyDecisions) console.log(`  - ${d.call}: ${d.decision}${d.reason ? `  (${d.reason})` : ""}`);
console.log("\nTool results fed back to model:");
for (const t of toolResults) console.log(`  - ${t.call}: ${t.isError ? "ERROR" : "ok"}${t.isError ? `  -> ${t.text}` : ""}`);
console.log(`\nDerived NativeAgentEvent transcript: ${nativeEvents.length} events -> native-session.jsonl`);
console.log("\nKill-criteria checks:");
let allPass = true;
for (const c of checks) {
  allPass = allPass && c.pass;
  console.log(`  [${c.pass ? "PASS" : "FAIL"}] ${c.id}\n         ${c.detail}`);
}
console.log(`\n${allPass ? "ALL PASS — Pi clears (a)(b)(c) in code." : "FAILURES PRESENT"}\n`);
process.exit(allPass ? 0 : 1);
