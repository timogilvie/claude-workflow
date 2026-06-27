# Task Packet: HOK-1

## Objective

Implement idempotent native Linear tools for the workflow runtime.

## Key Files

- `shared/lib/native-agent/workflow-tools/linear-tools.ts`
- `shared/lib/native-agent/workflow-tools/dedupe.ts`
- `shared/lib/linear.ts`

## Success Criteria

- All three tools (linear_get_issue, linear_comment, expand_issue) are implemented.
- Retried calls do not duplicate external objects.
- Phase policy gates are enforced.
