# Router Operating Modes

Wavemill derives a single global operating mode from the quota snapshot so routing and command logic can make consistent decisions.

## Modes

- `normal`: No premium model is currently degrading or exhausted.
- `constrained`: At least one premium model is degrading, and none are exhausted.
- `survival`: At least one premium model is exhausted.

## Derivation Rules

1. Inspect quota entries for models in the `frontier` class (`shared/lib/model-registry.ts`).
2. If any frontier model has status `exhausted`, mode is `survival`.
3. Else if any frontier model has status `degrading`, mode is `constrained`.
4. Else mode is `normal`.

Priority order is `survival > constrained > normal`.

## Scope

This milestone only exposes mode derivation and retrieval helpers.
Behavior changes in individual commands are deferred to a later milestone.
