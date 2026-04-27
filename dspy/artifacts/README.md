# DSPy Optimized Artifacts

This directory contains prompt-optimization artifacts produced by `dspy/optimize_stages.py`.

The production rubric schema is defined in `shared/lib/eval-schema.ts`. DSPy stage optimization uses that persisted schema as training signal, but it does not write production labels and it does not define the production schema. Production eval records remain the source of truth in `.wavemill/evals/evals.jsonl`; these artifacts are offline prompt-experimentation outputs.

## Rubric-Aligned Stage Artifacts

`optimized-planner.json` is for the planner evaluator signature. Its rubric output fields mirror `stageScores.plan.rubricCriteria`:

- `component_boundaries`
- `invariant_coverage`
- `sequencing_and_dependencies`
- `risk_and_validation_coverage`

`optimized-coder.json` is for the coder evaluator signature. Its rubric output fields mirror `stageScores.implementation.rubricCriteria`:

- `requirement_completeness`
- `correctness`
- `integration_with_existing_patterns`
- `code_quality_and_test_coverage`

The optimizer blends agreement on the main stage score with agreement on the per-criterion rubric scores when those labels exist in the aggregated eval data. When older eval records lack criterion labels, the examples fall back to the stage score for compatibility.

## Out Of Scope

`optimized-selector.json` and `optimized-selector-20260404.json` are selector/router artifacts, not stage evaluator artifacts. They are regenerated through the selector optimization path, not the planner/coder stage commands below.

`optimized-reviewer.json` is a stage artifact, but reviewer rubric alignment is not part of HOK-1412.

## Regeneration

Regenerate stage evaluator artifacts only from aggregated production eval data. Do not hand-edit `optimized_instruction`, `few_shot_examples`, or score metadata.

Prerequisites:

- DSPy dependencies are installed, for example `cd dspy && pip install -e .`
- `.wavemill/evals/aggregated-evals.jsonl` exists and has at least 5 training examples for the target stage

Commands from the repository root:

```bash
python dspy/optimize_stages.py --stage planner --evals .wavemill/evals/aggregated-evals.jsonl
python dspy/optimize_stages.py --stage coder --evals .wavemill/evals/aggregated-evals.jsonl
```

Artifacts include `rubric_schema_version` so reviewers can distinguish the schema target. If an artifact also has `rubric_artifact_status: "pending_regeneration"`, its optimization payload predates rubric-aware signatures and should be regenerated after persisted `rubricCriteria` labels are available.
