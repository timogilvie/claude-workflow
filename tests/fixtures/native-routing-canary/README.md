# HOK-2074 Native Routing Canary

This fixture sets up HOK-2074 as a deterministic native-routing canary. It is
designed to test real Wavemill routing work with a bounded implementation
surface.

## Model Matrix

Primary run:

- Planner: `glm-5.2`
- Coder: `qwen-3-coder`
- Reviewer: `glm-5.2`

Challenger run:

- Planner: `kimi-k2.7-code`
- Coder: `kimi-k2.7-code`
- Reviewer: `qwen-3-coder`

## Preflight

```bash
set -a; source .env; set +a

for pair in \
  "planning glm-5.2" \
  "coding qwen-3-coder" \
  "review glm-5.2" \
  "planning kimi-k2.7-code" \
  "coding kimi-k2.7-code" \
  "review qwen-3-coder"
do
  phase="${pair%% *}"
  model="${pair#* }"
  node --import tsx tools/check-native-agent-launch.ts \
    --repo-dir . \
    --agent native-openrouter \
    --phase "$phase" \
    --model "$model"
done
```

Expected result: all six checks return `"ok": true`.

## Isolated Dry-Run Launch Plans

These commands use a temporary `STATE_DIR` so they do not resume or clear an
existing mill session.

Primary:

```bash
printf '\n' | STATE_DIR=/tmp/hok-2074-native-primary-state \
  SESSION=hok-2074-native-primary \
  SKIP_CONFIG_CHECK=true \
  SKIP_CONTEXT_CHECK=true \
  WAVEMILL_NO_PROGRESS=1 \
  ./wavemill mill \
    --dry-run \
    --no-progress \
    --dry-run-backlog tests/fixtures/native-routing-canary/hok-2074-backlog.json \
    --dry-run-plan-out /tmp/hok-2074-native-primary-plan.json \
    --planner-model glm-5.2 \
    --coder-model qwen-3-coder \
    --reviewer-model glm-5.2
```

Challenger:

```bash
printf '\n' | STATE_DIR=/tmp/hok-2074-native-challenger-state \
  SESSION=hok-2074-native-challenger \
  SKIP_CONFIG_CHECK=true \
  SKIP_CONTEXT_CHECK=true \
  WAVEMILL_NO_PROGRESS=1 \
  ./wavemill mill \
    --dry-run \
    --no-progress \
    --dry-run-backlog tests/fixtures/native-routing-canary/hok-2074-backlog.json \
    --dry-run-plan-out /tmp/hok-2074-native-challenger-plan.json \
    --planner-model kimi-k2.7-code \
    --coder-model kimi-k2.7-code \
    --reviewer-model qwen-3-coder
```

Inspect the generated plans:

```bash
jq '.tasks[] | {title, route}' /tmp/hok-2074-native-primary-plan.json
jq '.tasks[] | {title, route}' /tmp/hok-2074-native-challenger-plan.json
```

The dry-run plan confirms stage model selection. The preflight command confirms
that each model resolves to the native OpenRouter launcher for its phase.

## Live Canary

Run the primary canary first, with tmux panes visible. The challenger should run
only after the primary completes or fails with actionable native recovery
artifacts.

The live run should be judged on:

- native planning writes planning artifacts and waits for approval correctly
- native coding creates scoped patch artifacts and completion or blocked
  completion state
- native review produces structured review output and PR handoff state
- `wavemill status` does not show stuck panes or silent failures
