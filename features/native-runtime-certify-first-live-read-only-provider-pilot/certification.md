# Native Read-Only Pilot Certification

Date: 2026-06-24
Issue: HOK-2308
Status: blocker

## Pilot target attempted

- Provider: OpenAI
- Model: `gpt-4o`
- API surface: Responses (`v1/responses`)
- Intended native provider metadata: `nativeProvider=openai`, `piTransportKind=openai-responses`
- Key env var: `OPENAI_API_KEY`
- Repo default path used by smoke: synthesized `nativeAgent.providers.openai.models[0] = gpt-4o`

## Outcome

Per REQ-F1, when no live run is possible no model is certified. No model is registered as `nativeCapability.readOnlyNative: 'certified'` in `shared/lib/model-registry.ts` as part of this change. The fail-closed default remains intact: uncertified and unregistered models are still refused for native read-only routing.

## What was implemented

- Tightened the live smoke so it fails when the provider does not complete a turn, does not execute the required read-only tool call, or returns zero usage needed for cost capture (`shared/lib/native-agent/smoke.ts`).
- Added a unit test covering the new fail-closed semantics on the smoke path (`shared/lib/native-agent/smoke.test.ts`).
- Left `shared/lib/model-registry.ts` unchanged with respect to certification: no model carries `readOnlyNative: 'certified'` by default.

## Live smoke attempt

Command:

```bash
npx tsx tools/smoke-native-agent.ts --provider openai --phase planning --live --json
```

Observed result on 2026-06-24:

- CLI exited non-zero after the smoke contract fix.
- Error: `Native agent live smoke failed: provider did not complete any turns.`
- Transcript: `/var/folders/0v/2l0qx62n3tgf2p_32p6_0_ww0000gn/T/native-smoke-live-smoke-live-openai-1782336938311.jsonl`

Transcript summary:

- `session_started`
- `turn_started`
- `assistant_message` with `stopReason: "error"`
- zero input tokens, zero output tokens, zero tool calls
- `turn_ended` with `stopReason: "error"`
- `session_ended`

This is the blocker condition: the provider/runtime path did not produce a successful read-only tool-using turn or billable usage, so cost capture cannot be certified from the live run.

## Router gate verification

- Uncertified and unregistered models are refused via existing `evaluateNativeReadOnlyRouting` checks (`shared/lib/model-registry.test.ts`).
- Provider-side gating in `resolveNativeAgentProviders` continues to reject uncertified models in task mode (`shared/lib/native-agent/providers.test.ts`).
- Certification mode remains diagnostic-only and non-routable.
- No model is admitted by the read-only routing gate from the seeded default registry. The gate is fully fail-closed for native read-only routing in this repo today.

## Cost and compat verification

- Compat fixtures already cover every read-only tool on `openai-responses`, including fixtures for the attempted pilot:
  - `read_file`
  - `list_files`
  - `search_text`
  - `git_status`
  - `git_diff`
- Native-session cost scanner coverage continues to price an authored `pi-priced-model` session, proving the scanner consumes native session JSONLs and attributes positive cost; no live `gpt-4o` cost line was certifiable because the provider returned zero usage.

## Completion command

Once the OpenAI runtime/provider path produces a successful read-only tool-using turn with positive usage, re-run:

```bash
npx tsx tools/smoke-native-agent.ts --provider openai --phase planning --live --json
```

If the smoke succeeds with non-zero usage and at least one read-only tool call, certification can proceed by adding the chosen model to `DEFAULT_MODEL_REGISTRY` in `shared/lib/model-registry.ts` with `nativeCapability.readOnlyNative: 'certified'` and matching the provider/transport (OpenAI Responses → `nativeProvider: 'openai'`, `piTransportKind: 'openai-responses'`).

## Verification commands

```bash
node --test shared/lib/model-registry.test.ts shared/lib/native-agent/providers.test.ts shared/lib/native-agent/smoke.test.ts
npx tsx shared/lib/workflow-cost.test.ts
npm run lint
```

All passed on 2026-06-24.

## Conclusion

The HOK-2308 implementation hardens the live smoke contract and confirms the registry/router stay fail-closed, but live provider certification for `gpt-4o` is blocked: the OpenAI runtime/provider response path returned an immediate error turn with zero usage and no tool call. Per REQ-F1, no model is certified by this change. Epic 4 planning can use this blocker artifact to plan provider remediation; the live certification itself still requires a successful provider round-trip captured by the completion command above.
