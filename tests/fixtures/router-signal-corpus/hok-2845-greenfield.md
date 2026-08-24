# HOK-2845 Task Packet

## Objective

Build a task scorer that predicts whether a task packet is ready to run before spending an arm.

## Scope

- Create new modules under `src/evaluation/scorers/wavemill/`
- Add a statistical analysis phase for historical packet outcomes
- Introduce a v1 model with feature extraction and calibration
- Add two CLIs for training and offline scoring
- Bump the eval schema minor version
- Integrate shadow-mode dispatch so router decisions can record scorer output

## Key Files

- `src/evaluation/scorers/wavemill/index.ts`
- `src/evaluation/scorers/wavemill/features.ts`
- `src/evaluation/scorers/wavemill/model.ts`
- `src/evaluation/scorers/wavemill/train.ts`
- `src/evaluation/scorers/wavemill/score.ts`
- `shared/lib/eval-schema.ts`
- `tools/train-task-scorer.ts`
- `tools/score-task-packet.ts`
- `shared/lib/workflow-router.ts`
- `shared/lib/hokusai-schema.ts`
- `tests/task-scorer.test.ts`
- `tests/fixtures/task-scorer/sample.jsonl`
- `docs/eval-mode.md`
- `package.json`

## Estimates

Expected change size: 2,131 new lines across 14 files.

## Phases

1. Add feature extraction.
2. Add statistical analysis.
3. Train and serialize v1 model.
4. Add CLIs.
5. Bump eval schema.
6. Wire shadow-mode dispatch integration.

## Validation

- Unit tests for feature extraction
- CLI smoke test
- Shadow-mode dispatch fixture

