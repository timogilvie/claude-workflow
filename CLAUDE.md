# Claude Configuration

## Architecture

This repository provides shared tooling for both Claude and Codex AI workflows:

### Directory Structure
- **`shared/lib/`** - Shared JavaScript helpers (Linear API, Git, GitHub) used by both Claude and Codex
- **`tools/`** - TypeScript wrappers that import from shared helpers (used by Claude commands)
- **`commands/`** - Workflow command definitions (symlinked from `~/.claude/commands/`)
- **`claude/config.json`** - Claude-specific configuration (Linear projects, git prefixes, check commands)
- **`codex/`** - Codex-specific commands and state management
- **`tools/prompts/`** - Shared prompt templates for PRDs, tasks, bug investigations, and issue expansion

### Key Principles
1. **Single Source of Truth**: This repo is canonical. `shared/lib/` contains all API logic; `tools/` contains all CLI tools. `wavemill` runs tools directly from the repo — never from `~/.claude/tools/`.
2. **Config Schema**: Both `claude/config.json` and `codex/config.json` follow `claude/config.schema.json`; wavemill runtime config follows `wavemill-config.schema.json`
3. **Shared Templates**: `tools/prompts/` templates are consumed by both toolchains
4. **State Separation**: Claude uses `features/`, `bugs/`, `epics/`; Codex uses `.codex/state/`

## Commands

### Linear Backlog Tool
To fetch the Linear backlog:
```bash
npx tsx tools/get-backlog.ts "Project Name"
```

### Workflow Commands
Available in `~/.claude/commands/`:
- `/workflow` - Full feature workflow (task selection → plan → implementation → validation → PR)
- `/plan` - Epic decomposition into sub-issues
- `/bugfix` - Bug investigation and fix workflow
- `/create-plan` - Research and create implementation plan
- `/implement-plan` - Execute plan with phase gates
- `/validate-plan` - Validate implementation against plan

## Project Context

The `.wavemill/project-context.md` file maintains living documentation of:
- **Architectural decisions and patterns** established in the codebase
- **Key conventions** (state management, API patterns, styling approach)
- **Recent work log** - automatically updated after each PR merge
- **Known gotchas** and constraints discovered during development

This file is automatically included when agents expand Linear issues, enabling them to build on previous work rather than starting from scratch.

### Initialization

**Recommended:** Use `wavemill init` which will prompt you to initialize project context:

```bash
cd ~/your-repo
wavemill init
# Answer 'Y' when prompted to initialize project context
```

**Manual initialization** (if you skipped it during `wavemill init`):

```bash
npx tsx tools/init-project-context.ts

# Overwrite existing context (use with caution)
npx tsx tools/init-project-context.ts --force
```

**Auto-initialization:** When you run `wavemill mill` or `wavemill expand` for the first time, you'll be prompted to initialize if the file doesn't exist. You can skip this check with:

```bash
SKIP_CONTEXT_CHECK=true wavemill mill
```

### Automatic Updates

The "Recent Work" section is automatically updated after each PR merge in mill mode. The post-completion hook:
1. Analyzes the PR diff
2. Generates a concise summary using LLM
3. Appends the summary to project-context.md

Manual edits to other sections (Architecture, Conventions, etc.) are encouraged to keep documentation current.

### Size Management

If the file exceeds 100KB, you'll receive warnings during issue expansion. To manage size:

```bash
# Archive old entries
mv .wavemill/project-context.md .wavemill/project-context-archive-$(date +%Y%m).md
npx tsx tools/init-project-context.ts
# Then manually copy relevant patterns/conventions to new file
```

Best practice: Keep the "Recent Work" log to the last 20-30 entries, archiving older history.

## Syncing with ~/.claude

This repo is the source of truth. `~/.claude/` is a consumer that can optionally sync from the repo for use by Claude commands outside of wavemill.

```bash
# Sync repo → ~/.claude (after making changes in the repo)
./sync-claude.sh to-claude

# Sync ~/.claude → repo (if you edited tools directly in ~/.claude)
./sync-claude.sh from-claude

# Check sync status
./sync-claude.sh status

# Set up symlinks for commands
./sync-claude.sh links
```

`wavemill` will warn on startup if `~/.claude/tools/` has drifted from the repo.