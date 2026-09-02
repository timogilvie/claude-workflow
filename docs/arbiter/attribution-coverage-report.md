# Arbiter R4 Attribution Coverage Baseline

HOK-2791 measured observable agent/model attribution coverage on public external
repositories with visible agent activity. This is a feasibility sample for
candidate repositories, not a prevalence estimate across all public GitHub
repositories.

## Snapshot

- Scan timestamp: 2026-09-02T15:42:15.725Z
- Tool: `npx tsx tools/measure-repo-attribution.ts --repos-file docs/arbiter/attribution-coverage-repos.txt --limit 20 --output docs/arbiter/attribution-coverage-results.json`
- Candidate list: `docs/arbiter/attribution-coverage-repos.txt`
- Raw evidence: `docs/arbiter/attribution-coverage-results.json`
- Window: most recent merged PRs returned by GitHub's closed PR API, sorted by
  updated timestamp, capped at 20 merged PRs per repo.
- Exclusions: no PRs were manually excluded. Repositories with fewer than 20
  merged PRs use the available merged denominator.

Signals were matched case-insensitively using the detector signature set saved
in the raw JSON: known agent bot logins, `Co-Authored-By` trailers mentioning an
agent/model, explicit agent branch prefixes, explicit agent/model labels, and
explicit agent/model commit-message signatures. Generic automation bots,
generic dependency updaters, and incidental uses of words such as "AI" were not
counted as attribution.

## Coverage

| Repository | Merged PRs | Bot author | Co-authored-by | Branch prefix | Label | Commit signature | Union | Unattributed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| github/gh-aw | 20 | 13 (65.0%) | 5 (25.0%) | 14 (70.0%) | 0 (0.0%) | 0 (0.0%) | 18 (90.0%) | 2 (10.0%) |
| lowgrade12/myplugins | 20 | 20 (100.0%) | 0 (0.0%) | 20 (100.0%) | 0 (0.0%) | 0 (0.0%) | 20 (100.0%) | 0 (0.0%) |
| CommsLRSD/LRSD-LitLab | 20 | 20 (100.0%) | 0 (0.0%) | 20 (100.0%) | 0 (0.0%) | 0 (0.0%) | 20 (100.0%) | 0 (0.0%) |
| xadupre/locodellm | 17 | 11 (64.7%) | 0 (0.0%) | 11 (64.7%) | 0 (0.0%) | 0 (0.0%) | 11 (64.7%) | 6 (35.3%) |
| mantelimustikka-prog/multisite-network-email-manager | 20 | 20 (100.0%) | 0 (0.0%) | 20 (100.0%) | 0 (0.0%) | 0 (0.0%) | 20 (100.0%) | 0 (0.0%) |
| kristofer/WorryBoards | 8 | 8 (100.0%) | 0 (0.0%) | 8 (100.0%) | 0 (0.0%) | 0 (0.0%) | 8 (100.0%) | 0 (0.0%) |
| finos/open-source-readiness | 20 | 6 (30.0%) | 0 (0.0%) | 6 (30.0%) | 0 (0.0%) | 0 (0.0%) | 6 (30.0%) | 14 (70.0%) |
| AdG-pbi/CheckOutputPBI | 9 | 9 (100.0%) | 0 (0.0%) | 9 (100.0%) | 0 (0.0%) | 0 (0.0%) | 9 (100.0%) | 0 (0.0%) |
| genomescan/gaia | 20 | 19 (95.0%) | 0 (0.0%) | 19 (95.0%) | 0 (0.0%) | 0 (0.0%) | 19 (95.0%) | 1 (5.0%) |
| dbritto-dev/amzn-selling-partner-python | 11 | 5 (45.5%) | 0 (0.0%) | 5 (45.5%) | 0 (0.0%) | 0 (0.0%) | 5 (45.5%) | 6 (54.5%) |
| erkaa2323-sudo/oni-kishin-web | 9 | 9 (100.0%) | 0 (0.0%) | 9 (100.0%) | 0 (0.0%) | 0 (0.0%) | 9 (100.0%) | 0 (0.0%) |
| maorun/buisness-calculation | 20 | 6 (30.0%) | 0 (0.0%) | 6 (30.0%) | 0 (0.0%) | 0 (0.0%) | 6 (30.0%) | 14 (70.0%) |
| colin-gourlay/qwerty | 20 | 20 (100.0%) | 0 (0.0%) | 20 (100.0%) | 0 (0.0%) | 0 (0.0%) | 20 (100.0%) | 0 (0.0%) |
| gituserc1140/SSReverse1VidApp | 2 | 2 (100.0%) | 0 (0.0%) | 2 (100.0%) | 0 (0.0%) | 0 (0.0%) | 2 (100.0%) | 0 (0.0%) |
| zaffnet/whetstone | 20 | 2 (10.0%) | 1 (5.0%) | 2 (10.0%) | 0 (0.0%) | 0 (0.0%) | 3 (15.0%) | 17 (85.0%) |
| **Total** | **236** | **170 (72.0%)** | **6 (2.5%)** | **171 (72.5%)** | **0 (0.0%)** | **0 (0.0%)** | **176 (74.6%)** | **60 (25.4%)** |

## Observations

The current Phase 2 gate, ">=60% agent/model attribution coverage on at least 6
external repos," is achievable on candidate external repos selected for visible
agent activity. In this sample, 11 of 15 repositories met or exceeded 60% union
coverage.

Coverage is dominated by GitHub-hosted agent identity. Bot author and branch
prefix signals overlap heavily in Copilot SWE-agent PRs; branch prefix has one
additional hit over bot author because some PRs retained the agent branch name
after the author signal changed or was absent. Labels and explicit
commit-message signatures contributed no coverage in this sample.

`Co-Authored-By` trailers were rare: 6 of 236 sampled PRs (2.5%). The cases that
did appear were GitHub/Copilot-style trailers, not a broad CLI provenance
baseline. This supports the expected failure mode: CLI-driven workflows can
leave trailers when configured to do so, while IDE-driven or web/agent-app
workflows often leave no trailer and should not be inferred from absence.

The no-signal bucket is still material at 60 of 236 PRs (25.4%). In the low
coverage repos, the detector did not prove those PRs were human-authored; it
only found no observable attribution in the sampled GitHub metadata and commit
messages.

## Recommendation

Keep the Phase 2 numeric gate, but phrase it precisely:

> Phase 2 exits when the attribution detector reaches >=60% observable
> agent/model attribution coverage on at least 6 sampled public external
> candidate repos selected for visible agent activity, with per-signal evidence
> preserved.

Do not generalize this to all public repos. For survival-by-model reporting, use
"all PRs, with agent-attributed PRs highlighted" as the default framing, and
enable the model-specific section only for the attributed subset. No new Phase 2
issue is required from this measurement because the candidate-repo gate is met;
the remaining no-signal gap is a reporting and instrumentation limitation unless
the program chooses to require IDE provenance capture.

## Decision Log Entry (HOK-2791)

**Date**: 2026-09-02  
**Decision**: Keep the Phase 2 numeric gate at ≥60% agent/model attribution coverage on at least 6 external repos, with refined phrasing.

**Verdict**: The Phase 2 exit criterion is achievable. 11 of 15 candidate repos met or exceeded 60% union coverage. Overall attribution across the 236 sampled PRs was 74.6%.

**Key Findings**:
- Attribution is dominated by GitHub-hosted signals (bot author + branch prefix)
- Co-authored-by trailers are rare (2.5%), supporting expected CLI vs IDE signal divergence
- 25.4% remain unattributed across the sampled PRs, representing either human-authored PRs or IDE-driven agent work without visible signals

**Recommendation**: Keep the gate as stated above. Do not generalize to all public repos. For reporting, use "all PRs, with agent-attributed PRs highlighted" as the default framing; enable model-specific sections only for attributed PRs. No new Phase 2 issue required.
