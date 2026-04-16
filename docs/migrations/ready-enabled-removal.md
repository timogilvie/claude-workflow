# Config Migration: Remove ready.enabled (April 2026)

**Issue**: HOK-1310  
**Date**: April 16, 2026  
**Author**: Claude Sonnet 4.5

## Problem

After commit `c0930f2` removed `ready.enabled` from `wavemill-config.schema.json`, two repos still had the old config format:

```
Config validation failed: /ready: must NOT have additional properties
Ready checks produced unparseable output
```

## Solution

Removed the `ready` section from:
- `/Users/timothyogilvie/Dropbox/Hokusai/hokusai-site/.wavemill-config.json`
- `/Users/timothyogilvie/Dropbox/blue-horseshoe/.wavemill-config.json`

## Verification

Tested `tools/ready.ts` on PR #228 (HOK-1302) - now produces parseable JSON output with no validation errors:

```json
{
  "prNumber": 228,
  "verdict": "warn",
  "checks": [...],
  "summary": "Checks passed with warnings - review before merge"
}
```

## Affected PRs

- HOK-1302 (PR #228) - now passes validation
- HOK-1305 - now passes validation

## Schema Change Reference

The schema was updated in commit `c0930f2` (April 15, 2026) to remove the `ready.enabled` toggle. The ready stage is now always active and cannot be disabled.
