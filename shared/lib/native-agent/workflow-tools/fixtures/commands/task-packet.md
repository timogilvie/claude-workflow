## Objective

Wrap native workflow commands so the runtime can invoke them like external tools.

## Implementation Notes

- Record command metadata in transcripts.
- Keep stage-result writes idempotent.
