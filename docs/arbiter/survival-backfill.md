# Survival-Label Backfill (HOK-2805)

`tools/backfill-survival.ts` emits Arbiter S2 survival labels (frozen v1.0.0
contract, `shared/schemas/arbiter-survival-label.schema.json`) for merged PRs
on an integration branch: one JSONL row per PR per 14/30/60-day horizon on
stdout, diagnostics and per-repo/per-horizon base rates on stderr.

The engine (`shared/lib/survival-labeller.ts`) is repo-agnostic: it needs only
`(owner, repo, integrationBranch)` plus a local checkout, and reads no
wavemill state. The wavemill `evals.jsonl` join is a caller-side layer on top
of the `prUrl` key. Arbiter S4 lifts this core into `@hokusai/scan`.

## Usage

```bash
# Wavemill's own history (first/backfill run)
npx tsx tools/backfill-survival.ts \
  --integration-branch auto/integration \
  > .wavemill/evals/survival-labels.jsonl

# Any external public repo — no wavemill state required
git clone https://github.com/some/repo /tmp/some-repo
npx tsx tools/backfill-survival.ts \
  --owner some --repo repo --integration-branch develop \
  --repo-dir /tmp/some-repo --no-links > /tmp/some-repo-labels.jsonl

# Focused replay of one PR
npx tsx tools/backfill-survival.ts \
  --integration-branch auto/integration \
  --pr-url https://github.com/timogilvie/wavemill/pull/1348
```

`--no-links` skips the per-PR `gh` cross-reference lookup (offline or bulk
runs). `main` is rejected as an integration branch: in squash-promotion repos
it attributes every change to the promoter.

## Scheduling

Scheduling is an outer layer — the CLI itself is stateless and idempotent:
re-emitting a `(prUrl, horizon_days)` row is safe because queries take the
latest `computed_at` per key (contract rule). Appending re-runs to the same
JSONL file therefore never corrupts the corpus; unelapsed-horizon rows are
emitted as explicit `missing_horizon` labels and are superseded once the
horizon elapses.

Example cron entry (daily, 03:15):

```cron
15 3 * * * cd /path/to/wavemill && npx tsx tools/backfill-survival.ts --integration-branch auto/integration >> .wavemill/evals/survival-labels.jsonl 2>> /tmp/backfill-survival.log
```

Equivalent launchd (`~/Library/LaunchAgents/com.wavemill.backfill-survival.plist`):
set `ProgramArguments` to the same command via `bash -lc`, with a daily
`StartCalendarInterval`.

## Base rates

The stderr summary reports rows/missing/outcome counts and `survival_rate`
per horizon. A uniformly extreme rate (for example ~98% survived at every
horizon on every repo) is a finding to escalate to the Arbiter decision log,
not a bug to hide.
