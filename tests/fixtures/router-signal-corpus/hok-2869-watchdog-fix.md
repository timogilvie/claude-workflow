# HOK-2869 Task Packet

## Objective

Fix the ready watchdog so it clears a resolved classification after a PR is fixed.

## Scope

- Update one watchdog branch in `shared/lib/ready-watchdog.ts`
- Preserve the existing state shape
- Add a focused regression test

## Key Files

- `shared/lib/ready-watchdog.ts`

## Validation

- `node --test shared/lib/ready-watchdog.test.ts`

