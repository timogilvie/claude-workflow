# Seam Artifacts

Seam artifacts are the small files agents and the orchestrator use to hand phase-boundary state across process boundaries. Data-carrying seams are JSON. Touch-file seams stay touch-files when existence is the whole signal.

| Artifact | Filename | Kind | Writer | Schema |
| --- | --- | --- | --- | --- |
| coding-complete | `.coding-complete` | JSON | agent | `shared/schemas/coding-complete.schema.json` |
| blocked-completion | `.coding-blocked-completion.json` | JSON | agent | `shared/schemas/blocked-completion.schema.json` |
| planning-rejected | `.planning-rejected.json` | JSON | orchestrator | `shared/schemas/planning-rejected.schema.json` |
| stage-result | `.{stage}-result.json` | JSON | orchestrator | `shared/schemas/stage-result.schema.json` |
| plan-approved | `.plan-approved` | touch | agent or user | none |
| workflow-aborted | `.workflow-aborted` | touch | agent or user | none |
| migration-detected | `.migration-detected` | touch | agent | none |

The shared registry and validator live in `shared/lib/seam-artifacts.ts`. The shell path calls the same code through `tools/seam-artifact-cli.ts`.

## Timing Rule

Every agent-written seam artifact is validated with the shared validator (1) at write time when the writer is a native tool call, and (2) by the orchestrator on first observation of the file, before any state transition is derived from it. Orchestrator-written seam artifacts are validated at write time in TypeScript writers or by focused shell tests. Touch-file seams have no content contract; existence is the signal.

A validation failure is never silent: it produces the unified error list, an attention state on the task, and retry guidance to the agent. Existence-only checks may still be used as cheap pre-filters, but never as the sole basis for a transition on a JSON-kind seam.

## Errors

All seam validators return errors shaped as `{ code, path, message }`, where `path` is a JSONPath-like string such as `$.confidence`.

Codes: `MALFORMED_JSON`, `MISSING_REQUIRED_FIELD`, `INVALID_FIELD_TYPE`, `INVALID_ENUM_VALUE`, `INVALID_STAGE`, `INVALID_VALUE`, `NO_VERIFICATION_EVIDENCE`, `ARTIFACT_NOT_FOUND`.

## CLI

```bash
node --import tsx tools/seam-artifact-cli.ts validate coding-complete features/demo/.coding-complete --canonicalize
node --import tsx tools/seam-artifact-cli.ts describe blocked-completion
node --import tsx tools/seam-artifact-cli.ts list --json
```

The reader still accepts legacy key/value `.coding-complete`, fenced JSON, and flat YAML for recovery, then canonicalizes to JSON. Prompts and writers should only produce the JSON contract.
