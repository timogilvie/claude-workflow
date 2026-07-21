# Native Routing Execution Plan

## Objective

Make native/OpenRouter models launchable only through validated phase-specific paths, and make failures visible instead of leaving stuck tmux panes.

## Scope

This execution addresses the launch-safety and approval-boundary parts of the 12-gap review immediately. Native coding remains a larger follow-up because it requires a new patch runtime, write policy, and phase launcher rather than a shell guard change.

## Gap Map

1. **Fail closed on route validation before window launch**: implemented in `shared/lib/wavemill-mill.sh` for primary and challenger stage routes.
2. **Fix all launcher paths, not just autonomous native launch**: covered for interactive and autonomous native planning/review launchers in `tests/launch-native-planning-phase.test.sh`.
3. **Clean up already-broken panes**: not implemented in this slice; stale panes that already ran malformed launchers still need a monitor transcript/hook recovery.
4. **Stop selecting ineligible models by stage**: partially handled by pre-launch fail-closed validation; a follow-up should filter challenge/router pools earlier.
5. **Unify native config semantics**: partially handled by strict launch validation; native coding still remains intentionally unavailable.
6. **Native planning should not silently auto-approve**: implemented in `shared/lib/native-agent/launch-planning.ts`.
7. **Native coding is not implemented**: explicitly preserved fail-closed; implementation remains follow-up.
8. **Native review is partial**: preserved existing native review path; PR workflow completion remains follow-up.
9. **Batch resolver errors are mishandled**: implemented at launch call sites by treating nonzero batch resolution as fatal.
10. **Tests cover the wrong surface**: implemented interactive native launcher and role-rejection coverage.
11. **Dashboard status is misleading**: not implemented in this slice; requires status rendering/recovery changes for historical broken panes.
12. **Provider/model naming remains split**: existing native launch probe coverage is preserved; broader normalization audit remains follow-up.

## Execution Order

1. Harden route resolution in `shared/lib/wavemill-mill.sh` so ignored batch failures cannot produce partial launches.
2. Adjust native planning completion in `shared/lib/native-agent/launch-planning.ts` to write `planning/awaiting_user` and no approval marker.
3. Update native planning tests for the approval boundary.
4. Add shell tests proving interactive native planning uses the native planning launcher and rejects role-ineligible routes.
5. Run focused verification:
   - `node --test --test-concurrency=1 shared/lib/native-agent/launch-planning.test.ts`
   - `bash tests/launch-native-planning-phase.test.sh`
   - `bash tests/agent-resolve-from-model.test.sh`
   - `bash tests/check-shell.sh`

## Residual Work After This Slice

Native coding remains intentionally blocked until a real patch runtime and launcher are implemented. A follow-up should add `tools/launch-native-coding.ts`, a write-policy-limited patch tool registry, coding transcript cleanup, earlier router/challenge pool filtering, dashboard recovery for historical/stale broken panes, and full PR workflow completion for native review.
