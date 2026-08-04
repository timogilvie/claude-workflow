# CI Contract Drift

Wavemill can compare GitHub-enforced checks with the local `prePrVerification`
recipe that maintainers expect agents to run before PR creation.

The drift check is read-only. It never executes GitHub Actions workflow YAML and
never edits `.wavemill-config.json` automatically.

## Configuration

Add check mappings under `prePrVerification.checks`. The object key is the exact
GitHub check name.

```json
{
  "prePrVerification": {
    "enabled": true,
    "required": true,
    "source": "github-enforced",
    "recipe": {
      "commands": ["npm test"]
    },
    "checks": {
      "ci / test": {
        "type": "workflow",
        "localEquivalent": "npm test",
        "workflowFile": ".github/workflows/ci.yml",
        "workflowJob": "test"
      },
      "security/vendor-scan": {
        "type": "remote-only",
        "rationale": "Vendor-hosted scan has no safe local equivalent and must remain enforced in GitHub.",
        "acknowledgedBy": "maintainer@example.com",
        "acknowledgedDate": "2026-08-04"
      }
    }
  }
}
```

## Check Types

- `workflow`: a GitHub Actions job with a known local command equivalent.
- `integration`: a third-party app check that requires manual provenance review.
- `remote-only`: an intentionally remote-only enforced check. It must include a
  rationale, acknowledgement email, and acknowledgement date.

## Commands

```bash
npx tsx tools/validate-drift.ts --repo owner/repo --branch auto/integration
npx tsx tools/validate-drift.ts --propose
npx tsx tools/validate-drift.ts --json
```

`--propose` writes `.wavemill/drift-update-proposal.json` for maintainer review.
It does not apply the proposal.

## States

- `ALIGNED`: GitHub check and local mapping agree.
- `RECIPE_MISSING`: no enabled local recipe is configured.
- `CHECK_MISSING`: GitHub enforces a check that has no mapping.
- `CHECK_UNMAPPED`: remote-only mapping is missing explicit acknowledgement.
- `WORKFLOW_CHANGED`: mapped workflow file or job is missing or renamed.
- `METADATA_UNAVAILABLE`: GitHub checks could not be fetched.
- `REQUIRES_REVIEW`: mapping cannot be safely inferred.
