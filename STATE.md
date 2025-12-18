# State Management

This document describes how workflow state is managed and shared between Claude and Codex tools.

## Overview

Both Claude and Codex maintain ephemeral workflow state to track progress through multi-phase workflows (plan → implement → validate). State is persisted to disk to enable:

- **Session resumption**: Continue work after interruptions
- **Cross-tool handoff**: Share context between Claude and Codex
- **Phase gating**: Enforce sequential workflow completion
- **Audit trail**: Track when phases were completed

## State Locations

### Codex State
- **Directory**: `.codex/state/`
- **Format**: `<feature-name>.json`
- **Purpose**: Tracks workflow phases for Codex-initiated work
- **Managed by**: [codex/src/state.js](codex/src/state.js)

### Claude State
- **Directory**: `.claude/state/` (future implementation)
- **Format**: `<feature-name>.json`
- **Purpose**: Tracks workflow phases for Claude-initiated work
- **Status**: Not yet implemented

### Feature Artifacts
- **Directory**: `features/<feature-name>/`, `bugs/<bug-name>/`, `epics/<epic-name>/`
- **Contents**: Task context, plans, validation reports, documentation
- **Purpose**: Persistent work products (committed to git)
- **Shared by**: Both Claude and Codex

## State Schema

### Codex Workflow State

Location: `.codex/state/<feature-name>.json`

```json
{
  "feature": "string",           // Feature name (slugified)
  "branch": "string",             // Git branch name (e.g., "feature/user-auth")
  "planPath": "string",           // Path to plan.md (e.g., "features/user-auth/plan.md")
  "phases": {
    "plan": "pending|complete",       // Planning phase status
    "implement": "pending|complete",  // Implementation phase status
    "validate": "pending|complete"    // Validation phase status
  },
  "checks": {
    "test": "string",           // Test command (from config)
    "lint": "string",           // Lint command (from config)
    "build": "string",          // Build command (from config)
    "typecheck": "string"       // Type check command (from config)
  },
  "updatedAt": "ISO8601"        // Last update timestamp
}
```

### Example State File

```json
{
  "feature": "add-user-authentication",
  "branch": "feature/add-user-authentication",
  "planPath": "features/add-user-authentication/plan.md",
  "phases": {
    "plan": "complete",
    "implement": "complete",
    "validate": "pending"
  },
  "checks": {
    "test": "npm test",
    "lint": "npm run lint",
    "build": "npm run build",
    "typecheck": "npm run typecheck"
  },
  "updatedAt": "2025-12-18T18:51:47.324Z"
}
```

## Feature Artifacts Schema

### Task Selection Context

Location: `features/<feature-name>/selected-task.json`

Created by: `codex/src/commands/start-workflow.js` or Claude `/workflow` command

```json
{
  "taskId": "string",           // Linear issue ID
  "title": "string",            // Issue title
  "description": "string",      // Issue description
  "labels": ["string"],         // Issue labels
  "state": "string",            // Issue state (e.g., "Backlog")
  "projectName": "string",      // Linear project name
  "workflowType": "feature|bugfix|epic",
  "featureName": "string",      // Slugified feature name
  "contextPath": "string",      // Path to this file
  "selectedAt": "ISO8601"       // Selection timestamp
}
```

### Implementation Plan

Location: `features/<feature-name>/plan.md`

Created by: Claude `/create-plan` command or Codex equivalent

Format: Markdown document with structured phases

```markdown
# Feature: User Authentication

## Overview
[Description of the feature]

## Phase 1: Setup
- Task 1
- Task 2

## Phase 2: Core Implementation
- Task 1
- Task 2

## Phase 3: Validation
- Test 1
- Test 2

## Success Criteria
- [ ] Criterion 1
- [ ] Criterion 2
```

### Validation Report

Location: `features/<feature-name>/validation-report.md`

Created by: Claude `/validate-plan` command

Format: Markdown document with test results and verification status

## Workflow Phase Gating

The workflow enforces sequential phase completion:

1. **Plan Phase** (`pending` → `complete`)
   - Research codebase
   - Generate implementation plan
   - Save to `plan.md`
   - **Gate**: User approval required before moving to implement

2. **Implement Phase** (`pending` → `complete`)
   - Execute plan phase-by-phase
   - Run tests after each phase
   - Commit changes to git
   - **Gate**: User verification required before moving to validate

3. **Validate Phase** (`pending` → `complete`)
   - Run all automated checks
   - Verify success criteria
   - Generate validation report
   - **Gate**: User approval required before creating PR

### Phase Enforcement

Implemented in [codex/src/workflow.js](codex/src/workflow.js):

```javascript
// Cannot complete validate before implement
requirePhaseOrder('validate', state)
// Throws error if implement is not 'complete'
```

## Cross-Tool Handoff

### Codex → Claude

1. Codex creates state in `.codex/state/<feature>.json`
2. Codex creates artifacts in `features/<feature>/`
3. Claude reads artifacts from `features/<feature>/` (state is tool-specific)
4. Claude continues work using artifact context

### Claude → Codex

1. Claude creates artifacts in `features/<feature>/`
2. Codex can initialize state from artifacts:
   ```bash
   node codex/src/commands/workflow.js init <feature> --plan features/<feature>/plan.md
   ```
3. Codex resumes workflow at appropriate phase

### State Independence

- Each tool maintains its own state directory (`.claude/state/` vs `.codex/state/`)
- Prevents conflicts when both tools run concurrently
- Artifacts in `features/`, `bugs/`, `epics/` are the shared source of truth

## State Lifecycle

### Creation
```bash
# Codex
node codex/src/commands/start-workflow.js

# Creates:
# - features/<name>/selected-task.json
# - .codex/state/<name>.json
```

### Updates
```bash
# Mark phase complete
node codex/src/commands/workflow.js complete <feature> --phase plan

# Updates:
# - .codex/state/<feature>.json (phases.plan = 'complete')
# - updatedAt timestamp
```

### Querying
```bash
# Check current state
node codex/src/commands/workflow.js status <feature>

# Check next action
node codex/src/commands/workflow.js next <feature>
```

### Cleanup

State directories are **ephemeral** and excluded from git (see `.gitignore`):

```
.codex/state/       # Not committed
.claude/state/      # Not committed
features/*/         # Not committed (unless explicitly added)
```

To preserve completed work:
1. Commit `features/<name>/plan.md` and other artifacts to git
2. State files in `.codex/state/` can be deleted after PR merge
3. Feature directories can be cleaned up after merge

## Configuration Integration

State creation uses configuration from [claude/config.json](claude/config.json) or [codex/config.json](codex/config.json):

```json
{
  "git": {
    "featurePrefix": "feature",  // → state.branch = "feature/..."
    "bugfixPrefix": "bugfix"     // → state.branch = "bugfix/..."
  },
  "checks": {
    "test": "npm test",          // → state.checks.test
    "lint": "npm run lint",      // → state.checks.lint
    "build": "npm run build",    // → state.checks.build
    "typecheck": "npm run typecheck"  // → state.checks.typecheck
  }
}
```

See [config.schema.json](config.schema.json) for full schema.

## Best Practices

### Do's
- ✅ Use state for tracking workflow progress
- ✅ Commit artifacts (`plan.md`, `validation-report.md`) to git
- ✅ Query state before resuming work: `workflow.js status <feature>`
- ✅ Clean up state files after PR merge
- ✅ Use slugified names for consistency: `add-user-auth` not `Add User Auth!!!`

### Don'ts
- ❌ Don't commit `.codex/state/` or `.claude/state/` to git
- ❌ Don't manually edit state files (use `workflow.js` commands)
- ❌ Don't skip phases (workflow enforces order)
- ❌ Don't share state files between tools (use artifacts instead)

## Troubleshooting

### State file corrupted
```bash
# Remove and reinitialize
rm .codex/state/<feature>.json
node codex/src/commands/workflow.js init <feature> --plan features/<feature>/plan.md
```

### Feature directory conflicts
```bash
# Multiple sessions trying to create same feature
# Ensure unique feature names (slugified from Linear task titles)
```

### Phase gate errors
```bash
# Error: Cannot complete "validate" before "implement" is complete
node codex/src/commands/workflow.js complete <feature> --phase implement
node codex/src/commands/workflow.js complete <feature> --phase validate
```

## Future Enhancements

- [ ] Implement `.claude/state/` directory for Claude workflows
- [ ] Add state migration tools for format changes
- [ ] Create state visualization dashboard
- [ ] Add state expiration (auto-cleanup after N days)
- [ ] Support state export/import for backup
- [ ] Add state validation against JSON schema
