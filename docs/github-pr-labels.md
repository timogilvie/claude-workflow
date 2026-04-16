# GitHub PR Labeling Without Deprecated GraphQL

## Why this exists

`gh pr edit --add-label` can fail in some environments because it may hit deprecated GitHub GraphQL fields related to Projects (classic), even when you only intend to modify labels.

To avoid that failure mode, use the GitHub REST API path via `gh api`.

## Manual CLI usage

Old (avoid):

```bash
gh pr edit 229 --add-label "HOK-1305"
```

New (safe):

```bash
gh api repos/{owner}/{repo}/issues/229/labels \
  -f labels[]="HOK-1305"
```

Multiple labels:

```bash
gh api repos/{owner}/{repo}/issues/229/labels \
  -f labels[]="HOK-1305" \
  -f labels[]="Bug"
```

Remove one label:

```bash
gh api --method DELETE repos/{owner}/{repo}/issues/229/labels/HOK-1305
```

Replace all labels on a PR:

```bash
gh api --method PUT repos/{owner}/{repo}/issues/229/labels \
  -f labels[]="HOK-1305" \
  -f labels[]="Bug"
```

## Programmatic usage (`shared/lib/github.ts`)

```typescript
import { addLabelsToPr, removeLabelFromPr, setLabelsOnPr } from '../shared/lib/github.ts';

await addLabelsToPr(229, ['HOK-1305']);
await addLabelsToPr(229, ['HOK-1305', 'Bug'], { repo: 'owner/repo' });

await removeLabelFromPr(229, 'HOK-1305');

await setLabelsOnPr(229, ['Bug', 'High Priority']);
```

## Error handling behavior

The helpers in `shared/lib/github.ts` normalize common failures:

- PR not found: `Pull request #<n> not found`
- Authentication missing/expired: `GitHub CLI (gh) is not authenticated`
- Other API/transport failures: operation-specific error with original message context

## Troubleshooting

- Ensure `gh` is installed: `gh --version`
- Ensure auth is valid: `gh auth status` (or `gh auth login`)
- If using `options.repo`, pass `owner/name` format
- Verify PR number exists in target repo
