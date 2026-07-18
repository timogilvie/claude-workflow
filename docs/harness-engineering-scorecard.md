# Harness Engineering Scorecard

This scorecard maps wavemill against the major practices from the Learn Harness Engineering wiki:

- https://walkinglabs.github.io/learn-harness-engineering/en/
- https://walkinglabs.github.io/learn-harness-engineering/en/lectures/lecture-02-what-a-harness-actually-is/
- https://walkinglabs.github.io/learn-harness-engineering/en/lectures/lecture-03-why-the-repository-must-become-the-system-of-record/
- https://walkinglabs.github.io/learn-harness-engineering/en/lectures/lecture-04-why-one-giant-instruction-file-fails/
- https://walkinglabs.github.io/learn-harness-engineering/en/lectures/lecture-05-why-long-running-tasks-lose-continuity/
- https://walkinglabs.github.io/learn-harness-engineering/en/lectures/lecture-06-why-initialization-needs-its-own-phase/
- https://walkinglabs.github.io/learn-harness-engineering/en/lectures/lecture-07-why-agents-overreach-and-under-finish/
- https://walkinglabs.github.io/learn-harness-engineering/en/lectures/lecture-08-why-feature-lists-are-harness-primitives/
- https://walkinglabs.github.io/learn-harness-engineering/en/lectures/lecture-09-why-agents-declare-victory-too-early/
- https://walkinglabs.github.io/learn-harness-engineering/en/lectures/lecture-10-why-end-to-end-testing-changes-results/
- https://walkinglabs.github.io/learn-harness-engineering/en/lectures/lecture-11-why-observability-belongs-inside-the-harness/
- https://walkinglabs.github.io/learn-harness-engineering/en/lectures/lecture-12-why-every-session-must-leave-a-clean-state/

## Rating Rubric

| Score | Meaning |
| --- | --- |
| 0 | Not doing anything |
| 1 | Ad hoc/manual practice exists, but no durable repo artifact |
| 2 | Documented convention exists, but agents can bypass it easily |
| 3 | Structured repo artifact exists and is used in normal workflows |
| 4 | Mechanically enforced by tooling or CI in important paths |
| 5 | Fully automated best practice with feedback loops, metrics, and continuous improvement |

## Major Practice Categories

1. Instruction architecture: short routing-oriented entry docs, topic docs loaded on demand, explicit hard constraints.
2. Repo as system of record: project knowledge, architecture decisions, current state, and verification standards live in versioned repo artifacts.
3. Environment and initialization: reproducible setup, locked dependencies, startup readiness, first passing test, and known operating commands.
4. Task boundaries and feature primitives: WIP limits, atomic feature items, executable completion evidence, machine-readable task state.
5. Cross-session continuity: progress, decisions, verification results, and next actions survive session resets.
6. Verification and termination gates: layered static, unit, integration, E2E, ready, and release checks define "done."
7. Observability: runtime signals, process artifacts, logs, traces, manifests, rubrics, and actionable failure details.
8. Feedback and learning loops: evaluations, intervention tracking, challenge comparisons, routing improvements, and benchmark datasets.
9. Clean-state and entropy control: build/test cleanliness, stale artifact cleanup, worktree cleanup, branch cleanup, quality tracking, and periodic maintenance.
10. Safety, permissions, and isolation: least-privilege tool access, worktree isolation, protected branches, state locks, and high-risk policies.
11. Architecture invariant enforcement: constraints promoted from docs/reviews into automated tests, lint, ready checks, or CI.

## Current Wavemill Scorecard

| Category | Score | Evidence | Gap |
| --- | ---: | --- | --- |
| Instruction architecture | 3 | `CLAUDE.md`, `README.md`, docs by mode, prompt location registry, task-packet progressive disclosure. | Entry file is long and Claude-specific; no concise `AGENTS.md` router for Codex and other agents; some instructions are still documentation rather than executable routing. |
| Repo as system of record | 3 | `.wavemill/project-context.md`, `.wavemill/context/*.md`, docs, task packets, eval records, registry. | The root project context still has TODO sections and stale auto-detected fields; knowledge freshness is warned about, not strongly gated. |
| Environment and initialization | 4 | `package-lock.json`, Node engine, `npm test`, CI, startup progress table, dependency reuse, config schema, lifecycle startup tests. | No devcontainer or single `make setup/check`; adopting repos can still have uneven bootstrap quality. |
| Task boundaries and feature primitives | 3 | `features/<slug>/`, task packets, plans, stage artifacts, queue/dependency planning, conflict checks. | No central feature-list primitive with behavior + verification + state and pass-state gating; WIP is enforced operationally per task, but not as a generic machine-readable feature state machine. |
| Cross-session continuity | 4 | `.wavemill/workflow-state.json`, stage result files, hook status files, feature artifacts, route artifacts, state mutexes, recent work log. | Handoffs are strong for mill-managed phases but not yet normalized into a concise per-task handoff/decision artifact for every session. |
| Verification and termination gates | 4 | `npm test`, CI, lifecycle tests, ready stage, migration checks, verification modes, review mode, blocked-completion guardrails. | Full product-level E2E/user-path validation is not yet a universal completion requirement; error messages are not consistently agent-oriented. |
| Observability | 4 | Hook status protocol, dashboard, logs, manifests, prompt registry, eval records, ready-watchdog logs, challenge records. | No standard OpenTelemetry-style trace/span model for every run; sprint contracts and evaluator rubrics are partially present through eval/review but not first-class for each task. |
| Feedback and learning loops | 5 | Auto eval, challenge mode, router learning, rubric provenance, Hokusai benchmark artifacts, prompt/resource registry, aggregated evals. | Keep improving data quality and coverage; this is already the strongest area. |
| Clean-state and entropy control | 3 | Worktree/task cleanup, branch cleanup tests, ready watchdog, project-context compaction warning, background job cleanup tests. | No active module quality document, recurring cleanup loop, or score-driven entropy reduction workflow. |
| Safety, permissions, and isolation | 4 | Worktrees, permission auto-approve patterns, read-only command policy, state locks, integration branch policy, high-risk handling. | Integration mode is disabled in this repo config; protected branch policies are documented but external to the repo. |
| Architecture invariant enforcement | 3 | Migration safety checks, forbidden DDL fixtures, lifecycle path filters, config schema, shell/unit/lifecycle CI. | Many architectural rules in docs are not yet promoted into automated checks with repair guidance. |

Average score: 3.6 / 5.

## Largest Gaps

### P0: Add a first-class feature-list/state primitive

Why it matters: The wiki treats the feature list as the scheduler, verifier, handoff, and progress tracker's shared primitive. Wavemill has feature folders and stage artifacts, but lacks a single machine-readable contract that says: behavior, verification command, state, evidence, dependencies.

Natural roadmap fit:

- Extend task packets or create `features/<slug>/feature-state.json`.
- Add allowed states: `not_started`, `active`, `blocked`, `passing`.
- Require verification evidence before transition to `passing`.
- Have review/ready/eval consume the same file.
- Add a lifecycle test proving a task cannot advance without evidence.

Target score impact: task boundaries 3 -> 5, cross-session continuity 4 -> 5.

### P0: Create a concise `AGENTS.md` entry router

Why it matters: The wiki recommends an entry file that routes agents to topic docs instead of acting as an encyclopedia. Wavemill's `CLAUDE.md` is valuable but too broad for the "short landing page" role, and it excludes Codex-native discovery conventions.

Natural roadmap fit:

- Add root `AGENTS.md` under 150 lines.
- Include project purpose, setup, verification, hard constraints, and topic-doc routing.
- Link to `CLAUDE.md`, `docs/feature-workflow.md`, `docs/mill-mode.md`, `docs/ready-stage.md`, `.wavemill/project-context.md`, and `.wavemill/context/`.
- Add a lint/check that validates the file exists and stays below a size threshold.

Target score impact: instruction architecture 3 -> 4.

### P1: Turn harness scorecard into a recurring quality document

Why it matters: The wiki's clean-state practice calls for an active quality document and periodic cleanup loop. Wavemill has cleanup mechanics, but no continuously updated health artifact that directs future agents toward the lowest-quality modules.

Natural roadmap fit:

- Convert this document into `.wavemill/quality.md` or `.wavemill/quality.json`.
- Track module-level ratings: verification passing, agent understandability, test stability, architecture compliance, stale docs, cleanup debt.
- Auto-update from CI/eval/lifecycle outputs.
- Have `wavemill mill` surface the lowest-scoring subsystem as a backlog recommendation.

Target score impact: clean-state 3 -> 5, repo-as-spec 3 -> 4.

### P1: Standardize agent-oriented failure messages

Why it matters: The wiki emphasizes feedback that says what failed, why, and how to fix it. Wavemill has many checks, but not all failures are formatted as repairable agent feedback.

Natural roadmap fit:

- Define a shared `AgentCheckFailure` shape: `what`, `why`, `fix`, `evidence`, `docs`.
- Use it in ready checks, lifecycle checks, migration checks, routing validation, and review findings.
- Add snapshot tests for high-value failure messages.

Target score impact: verification 4 -> 5, observability 4 -> 5.

### P1: Make sprint contracts first-class per task

Why it matters: Sprint contracts front-load scope, exclusions, and verification before coding begins. Wavemill has plans and task packets, but no compact, enforced task contract shared by builder and evaluator.

Natural roadmap fit:

- Generate `features/<slug>/sprint-contract.json` after planning.
- Include scope, exclusions, allowed files, verification commands, risk flags, and reviewer rubric.
- Require review/eval to reference the contract explicitly.
- Fail planning handoff if the contract is missing for non-trivial tasks.

Target score impact: observability 4 -> 5, task boundaries 3 -> 4.

### P2: Add OpenTelemetry-style task traces

Why it matters: Wavemill already has logs, manifests, and status hooks. A trace/span model would make run replay and bottleneck analysis much easier.

Natural roadmap fit:

- Create a `traceId` per mill task.
- Emit spans for expansion, routing, planning, coding, review, ready, tend, eval, cleanup.
- Link resource manifests and prompt versions to spans.
- Export JSONL first; bridge to OTLP later if useful.

Target score impact: observability 4 -> 5.

### P2: Add adoption bootstrap checks for downstream repos

Why it matters: Wavemill itself has strong setup, but adopting repos can miss basic harness readiness: start command, test command, context files, CI, ready config.

Natural roadmap fit:

- Add `wavemill doctor` or extend `wavemill init`.
- Check setup, test, CI, config version, project context, ready checks, eval settings, branch policy hints.
- Produce actionable remediation with copy/paste commands.

Target score impact: environment/initialization 4 -> 5, repo-as-spec 3 -> 4.

## Recommended Execution Order

1. Create `AGENTS.md` and a size/content check.
2. Add `feature-state.json` with pass-state gating.
3. Introduce `sprint-contract.json` and make planning handoff produce it.
4. Normalize agent-oriented failure messages across ready/lifecycle/migration checks.
5. Add `.wavemill/quality.json` and a weekly cleanup recommendation flow.
6. Add trace IDs and JSONL spans across the mill lifecycle.
7. Add `wavemill doctor` for adopting repos.

This sequence fits wavemill's existing roadmap because it strengthens the factory loop without changing the core product shape: backlog intake, expansion, routing, parallel execution, review, ready, eval, and learning.
