# Launch Priority Validation

Run `npx tsx tools/launch-validation.ts` to generate `.wavemill/audits/launch-validation.json` in fixture mode. This validates the grouped audit shape, dry-run smoke coverage, family challenger checks, and Hokusai export compatibility without requiring live provider access.

Run `OPENROUTER_API_KEY=... npx tsx tools/launch-validation.ts --live` to fetch the live OpenRouter catalog and execute live smoke coverage. Missing provider access is reported as a blocker in the artifact instead of failing the run.

The artifact records:

- The OpenRouter catalog snapshot hash and timestamp.
- The launch-priority list version and source hash.
- Per-model smoke status plus per-role Wavemill evidence, success/failure counts, and blockers.
- Qwen, DeepSeek, and Kimi challenger-family status.
- Hokusai export diagnostics showing whether validated contribution rows carry launch-priority provenance and expose under-sampled launch targets versus overrepresented anchors.
