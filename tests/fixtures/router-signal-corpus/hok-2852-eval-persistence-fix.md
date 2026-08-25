# HOK-2852 Task Packet

## Objective

Fix eval persistence so rejected eval records are persisted instead of discarded when validation fails.

## Scope

- Update the eval persistence path in `shared/lib/eval-persistence.ts`
- Add one regression test for rejected record storage

## Key Files

- `shared/lib/eval-persistence.ts`

## Validation

- `node --test shared/lib/eval-persistence.test.ts`

