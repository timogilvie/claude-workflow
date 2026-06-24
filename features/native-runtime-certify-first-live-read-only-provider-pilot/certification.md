# Native Read-Only Pilot Certification

Date: 2026-06-24
Issue: HOK-2308
Status: blocker

## Pilot target

- Provider: OpenAI
- Model: `gpt-4o`
- API surface: Responses (`v1/responses`)
- Native provider metadata: `nativeProvider=openai`, `piTransportKind=openai-responses`, `readOnlyNative=certified`
- Key env var: `OPENAI_API_KEY`
- Repo default path used by smoke: synthesized `nativeAgent.providers.openai.models[0] = gpt-4o`

## What was implemented

- Seeded `gpt-4o` into the default model registry as the single certified native read-only pilot.
- Preserved fail-closed routing for uncertified and unregistered models.
- Tightened live smoke so it fails when the provider does not complete a turn, does not execute the required read-only tool call, or returns zero usage needed for cost capture.
- Verified native-session cost ingestion against `gpt-4o` session data.

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

This is a blocker for certification because the provider/runtime path did not produce a successful read-only tool-using turn or billable usage, so cost capture cannot be certified from the live run.

## Router gate verification

- Certified pilot allowed: `evaluateNativeReadOnlyRouting({ modelId: 'gpt-4o', phase: 'planning' })` is routable in tests.
- Uncertified model refused: existing registry/provider gate tests still reject uncertified or unregistered models.
- Certification mode remains diagnostic-only and non-routable.

## Cost and compat verification

- Compat fixtures already cover every read-only tool on `openai-responses`, including `gpt-4o` fixtures for:
  - `read_file`
  - `list_files`
  - `search_text`
  - `git_status`
  - `git_diff`
- Native-session cost scanner coverage was updated to price `gpt-4o` native session usage successfully.
- Because the live provider returned zero usage, no live cost figure could be certified from the provider run itself.

## Verification commands

```bash
node --test shared/lib/model-registry.test.ts shared/lib/native-agent/providers.test.ts shared/lib/native-agent/smoke.test.ts
npx tsx shared/lib/workflow-cost.test.ts
npm run lint
```

All passed on 2026-06-24.

## Conclusion

`gpt-4o` is now the checked-in native read-only pilot candidate and is admitted by the router gate exactly as intended, but live provider certification is blocked by the OpenAI runtime/provider response path returning an immediate error turn with zero usage and no tool call. Epic 4 planning can proceed with this blocker artifact, but the live certification itself still requires a successful provider round-trip.
