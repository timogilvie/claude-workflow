Aggregate eval logs from multiple wavemill repositories into a single deduplicated JSONL file.

This command collects eval records from multiple repositories and merges them for cross-repo analysis and ML training.

---

## Usage

### Default: Use config-driven repos
```bash
npx tsx tools/aggregate-evals.ts
```
Reads `eval.aggregation.repos` from `.wavemill-config.json` and outputs to `.wavemill/evals/aggregated-evals.jsonl`.

### Auto-discover wavemill directories
```bash
npx tsx tools/aggregate-evals.ts --discover /path/to/repos
```
Recursively scans `/path/to/repos` to find all `.wavemill/evals` directories and aggregates them.

### Explicit repo list
```bash
npx tsx tools/aggregate-evals.ts --repos ~/proj1 ~/proj2 ~/proj3
```
Aggregates eval logs from specified directories only.

### Custom output path
```bash
npx tsx tools/aggregate-evals.ts --discover /repos --output custom-aggregated.jsonl
```

### Disable deduplication
```bash
npx tsx tools/aggregate-evals.ts --discover /repos --no-deduplicate-by-hash
```
Keeps all records including duplicates (not recommended).

## How It Works

### 1. Directory Discovery
If `--discover` is provided, recursively scans the directory to find all subdirectories containing `.wavemill/evals/evals.jsonl`. Respects max depth of 5 levels and excludes common patterns like `node_modules/`, `.git/`, etc.

### 2. Record Reading
Reads JSONL files from all located repos. Each line must be valid JSON representing an `EvalRecord`. Malformed lines are skipped with a warning.

### 3. Hash-Based Deduplication (default)
Computes MD5 hash of key fields for each record:
```
hash = MD5(JSON({
  issueId,
  prUrl,
  score,
  timestamp,
  modelId
}))
```

When duplicates are found (same hash), keeps the earliest by timestamp. This identifies and removes duplicate evaluations of the same task across repositories.

### 4. Sorting
Sorts deduplicated records by timestamp (ISO 8601, lexicographically) for reproducibility and chronological analysis.

### 5. Output
Writes to JSONL format (one JSON object per line):
```
{"id": "...", "score": 0.92, ...}
{"id": "...", "score": 0.85, ...}
...
```

### 6. Reporting
Prints aggregation statistics:
- Total records and unique records (if dedup enabled)
- Per-repo record counts
- Duplicate groups (if found)
- Cost statistics (if available):
  - Records with workflow cost data
  - Cost summary (total, average, median, range)
  - Workflow cost status distribution

## Configuration

### Config File (`config.json`)
```json
{
  "eval": {
    "aggregation": {
      "repos": [
        "/path/to/repo1",
        "/path/to/repo2"
      ],
      "outputPath": ".wavemill/evals/aggregated-evals.jsonl"
    },
    "evalsDir": ".wavemill/evals"
  }
}
```

### Command-Line Flags

| Flag | Type | Description |
|------|------|-------------|
| `--repos <path>` | multiple | List of repo directories to aggregate from |
| `--discover <path>` | string | Base directory to recursively search for wavemill dirs |
| `--output <path>` | string | Output file path (default: `.wavemill/evals/aggregated-evals.jsonl`) |
| `--deduplicate-by-hash` | boolean | Enable dedup (default: true) |
| `--no-deduplicate-by-hash` | flag | Disable dedup and keep all records |

## Output Format

### JSONL Structure
Each line is a complete `EvalRecord` (see `shared/lib/eval-schema.ts`):

```json
{
  "id": "8c682707-966a-48e3-b0f0-a4c6a7695b52",
  "schemaVersion": "1.0.0",
  "score": 0.92,
  "scoreBand": "Minor Feedback",
  "timestamp": "2026-02-17T15:17:49.760Z",
  "issueId": "HOK-681",
  "prUrl": "https://github.com/timogilvie/repo/pull/40",
  "modelId": "claude-sonnet-4-5-20250929",
  "workflowCost": 14.86,
  "workflowCostStatus": "success",
  "sourceRepo": "hokusai-site",
  ...
}
```

### Report Output
```
=== Aggregation Summary ===
Aggregated repositories: 5
Total records: 89
Duplicates removed: 0
Unique records: 89

=== Records per Repository ===
  hokusai-site: 43
  hokusai-data-pipeline: 38
  hokusai-auth-service: 4
  hokusai-docs: 2
  hokusai-token: 2

=== Cost Statistics ===
Records with cost: 80 (89.9%)
Records without cost: 9

Cost Summary:
  Total: $1189.11
  Average: $14.86
  Median: $11.33
  Range: $1.05 - $108.75

Workflow Cost Status Distribution:
  success         19 (21.3%)
  unknown         70 (78.7%)

Output: /Users/timothyogilvie/Dropbox/wavemill/.wavemill/evals/aggregated-evals.jsonl
```

## Examples

### Aggregate all Hokusai repos with auto-discovery
```bash
npx tsx tools/aggregate-evals.ts --discover ~/Dropbox/Hokusai
```

### Combine config repos + explicit repos
```bash
npx tsx tools/aggregate-evals.ts --repos ~/extra-repo
```
(Uses config repos + explicit `--repos` argument)

### Export to custom location for analysis
```bash
npx tsx tools/aggregate-evals.ts --discover ~/repos --output /tmp/eval-analysis.jsonl
```

### Analyze aggregated logs with jq
```bash
# Count unique issues
jq '.issueId' aggregated-evals.jsonl | sort -u | wc -l

# Get avg score
jq '.score' aggregated-evals.jsonl | jq -s 'add/length'

# Filter by model
jq 'select(.modelId == "claude-opus-4-6")' aggregated-evals.jsonl | wc -l

# Find high-cost evals
jq 'select(.workflowCost > 50)' aggregated-evals.jsonl
```

## Use Cases

### 1. Cross-Repo Analysis
Combine eval data from all projects to identify patterns, model performance trends, and infrastructure costs across the organization.

### 2. ML Training Data
Aggregate evals as training data for DSPy evaluation models or other ML workflows.

### 3. Cost Attribution
Track total spend across all repos and models with consolidated cost statistics.

### 4. Quality Metrics
Analyze success rates, score distributions, and intervention requirements across repos and models.

### 5. Debugging
Identify duplicate evaluations and compare outcomes for the same task evaluated multiple times.

## Deduplication Details

### Hash Calculation
Combines issue ID, PR URL, score, timestamp, and model ID to create a stable hash. Two evaluations are considered duplicates if these fields match.

### Conflict Resolution
When duplicates are found:
1. Group records by hash
2. Sort each group by timestamp
3. Keep the earliest record (first evaluation)
4. Report other records as removed

### When to Disable
Disable dedup (`--no-deduplicate-by-hash`) only if you need to:
- Preserve all evaluations for historical analysis
- Track multiple evaluations of the same task over time
- Intentionally include re-evaluations with different models

Note: Disabled dedup can significantly increase file size and duplicate analysis results.

## Performance

- **Discovery**: Scans ~1000 directories in ~2 seconds
- **Reading**: Processes ~1000 JSONL records in ~1 second
- **Dedup**: Hash computation for ~1000 records in <100ms
- **Sorting**: Sorts ~1000 records in <500ms
- **Writing**: Writes aggregated JSONL in <100ms

Total: 89 records from 5 repos typically takes <5 seconds.

## Troubleshooting

### No records found
```bash
# Verify .wavemill/evals/evals.jsonl exists
find /path -name evals.jsonl

# Check if path is accessible
ls -la /path/to/repo/.wavemill/evals/
```

### Permission denied
```bash
# Ensure read permissions on all repos
chmod +r /path/to/repo/.wavemill/evals/evals.jsonl
```

### Wrong schema version
The tool supports all `schemaVersion` values (1.0.0, 1.1.0, etc.). Older versions are included as-is in the aggregated file.

### Malformed JSONL
```bash
# Find problematic lines
jq . aggregated-evals.jsonl 2>&1 | grep -B1 "parse error"
```
Malformed lines are silently skipped during reading; they won't appear in the output.

## Related Commands

- `/eval` — Evaluate a single workflow
- `/plan` — Epic decomposition
- `/workflow` — Full feature workflow with auto-eval
