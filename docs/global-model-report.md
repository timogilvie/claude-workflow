# Global Model Report

`wavemill parity-report` is the startup and CI preflight for the global certified-model cutover. It checks the shared certification root, runtime readiness, challenge-pair availability, and removed repo-local model settings.

Run it from any consumer repo:

```bash
wavemill parity-report
wavemill parity-report --json
wavemill parity-report --strict-challenge
```

Use `--repo-dir <path>` when checking another checkout. Use `--strict-challenge` in CI or startup when a missing primary/challenger pair should fail the preflight with exit code `3`.

## How To Read It

`Catalog version` is the certification suite version found in the global root, usually `~/.wavemill/native-agent-certifications` or `WAVEMILL_NATIVE_CERTIFICATION_ROOT`.

`Certified models by stage` counts globally certified models that satisfy each launch stage:

- `planning` requires workflow certification.
- `coding` requires patch certification and local patch-coding readiness.
- `review` requires read-only certification.

`Runtime-ready by provider` shows how many certified models can actually launch with the current provider credentials and runtime gates.

`Challenge pair availability` is available only when at least two runtime-ready candidates exist for the stage.

`Forbidden local configuration` must be `none`. Any listed field is a removed HOK-2587 model-list or certification setting that would reintroduce divergent pools.

## Fixing Blockers

Do not edit consumer repo model lists. The global model projection is authoritative.

For a missing API key, export the provider key named in the report or add it to the repo `.env`, then rerun `wavemill parity-report` and `wavemill doctor openrouter`.

For a stale artifact, refresh the global certificate:

```bash
wavemill native-agent certifications refresh <provider>/<model>
```

For a wrong suite, refresh with the v2 suite:

```bash
wavemill native-agent certifications refresh <provider>/<model> --suite v2
```

For provider outages, verify provider status and retry after the outage clears. The report does not perform live provider calls, so use the provider doctor or launch diagnostics for live outage confirmation.

For forbidden local config, migrate the consumer config:

```bash
wavemill config migrate-model-settings --repo-dir <consumer-repo>
```

If a 100% challenge launch emits `challenge_unavailable`, no challenger worktree was created and no normal task was launched as a substitute. Resolve the listed global/runtime blockers, then requeue or relaunch the task.
