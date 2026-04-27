# DSPy Optimized Artifacts

`optimized-planner.json` and `optimized-coder.json` were generated before the HOK-1414 rubric-based evaluator prompt updates. Treat them as stale relative to the default prompts in `dspy/evaluators/planner_evaluator.py` and `dspy/evaluators/coder_evaluator.py`.

Do not overwrite these artifacts as part of prompt-only changes. Regenerate them after enough eval data has been labeled by the production rubric prompt at `tools/prompts/eval-judge.md`, so persisted labels and optimized prompts stay aligned.

Regeneration commands:

```bash
cd dspy && python optimize_stages.py --stage planner
cd dspy && python optimize_stages.py --stage coder
```

