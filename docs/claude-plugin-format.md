# Claude Code Plugin Format

## Verification Environment

- Verification date: 2026-05-14
- Claude Code CLI version: `2.1.141 (Claude Code)` (`claude --version`)
- Official docs consulted:
  - https://code.claude.com/docs/en/plugins
  - https://code.claude.com/docs/en/plugins-reference
  - https://code.claude.com/docs/en/cli-reference

Provenance legend used throughout this document:

- `verified`: observed directly on local CLI `2.1.141`
- `sourced`: stated in official docs, not directly re-tested here
- `unverified`: not confirmed in the time box

## Minimal Plugin

The spike includes a minimal plugin at `experiments/hello-world-plugin/`.

```text
experiments/hello-world-plugin/
├── .claude-plugin/
│   └── plugin.json
└── commands/
    └── hello.md
```

Primary load command (`verified`):

```bash
claude --plugin-dir ./experiments/hello-world-plugin
```

Expected slash namespace (`verified`): `/wavemill-hello-world:hello`

Observed behavior (`verified`):

- `claude --plugin-dir ./experiments/hello-world-plugin -p "/wavemill-hello-world:hello"`
  - Output: `Hello from wavemill-hello-world`
- `claude --plugin-dir ./experiments/hello-world-plugin -p "/wavemill-hello-world:hello Ada"`
  - Output: `Hello from wavemill-hello-world, Ada`

## Manifest File

- Manifest path: `.claude-plugin/plugin.json` (`verified`)
- Manifest required?: optional overall (`sourced`)
  - Docs state plugin components can be auto-discovered without a manifest.
- If manifest exists, required field is `name` (`sourced`)
- This spike uses a minimal manifest with `name`, `version`, and `description`.

## Manifest Schema

Requested field coverage (plus adjacent real schema fields) is below.

| Field | Type | Required? | Where configured | Discovery/load behavior | Provenance |
|---|---|---|---|---|---|
| `name` | string | Required if manifest exists | `.claude-plugin/plugin.json` | Defines plugin namespace prefix (`plugin:component`) | `verified` + `sourced` |
| `version` | string | Optional | `.claude-plugin/plugin.json` | Metadata/versioning; used by packaging/update flows | `sourced` |
| `description` | string | Optional | `.claude-plugin/plugin.json` | Human-readable metadata in plugin views | `sourced` |
| `commands` | string or array | Optional | `.claude-plugin/plugin.json` | Custom command path(s); replaces default `commands/` discovery when set | `sourced` |
| `skills` | string or array | Optional | `.claude-plugin/plugin.json` | Custom skill path(s); adds skills with `/plugin:skill` commands | `sourced` |
| `agents` | string or array | Optional | `.claude-plugin/plugin.json` | Custom agent path(s); plugin agents appear in `/agents` | `sourced` |
| `hooks` | string, array, or object | Optional | `.claude-plugin/plugin.json` or `hooks/hooks.json` | Hook config path(s) or inline hook config | `sourced` |
| `mcp` | n/a | n/a | n/a | Not present in current schema key naming | `verified` |
| `mcpServers` | string, array, or object | Optional | `.claude-plugin/plugin.json` or `.mcp.json` | MCP server definitions loaded with plugin | `sourced` |
| `permissions` | n/a | n/a | n/a | Not present as a top-level plugin manifest field in current schema docs | `verified` |
| `author` | string or object | Optional | `.claude-plugin/plugin.json` | Metadata/attribution | `sourced` |
| `homepage` | string | Optional | `.claude-plugin/plugin.json` | Metadata | `sourced` |
| `repository` | string | Optional | `.claude-plugin/plugin.json` | Metadata | `sourced` |
| `license` | string | Optional | `.claude-plugin/plugin.json` | Metadata | `sourced` |
| `outputStyles` | string or array | Optional | `.claude-plugin/plugin.json` or `output-styles/` | Output style definitions | `sourced` |
| `lspServers` | string, array, or object | Optional | `.claude-plugin/plugin.json` or `.lsp.json` | LSP server definitions | `sourced` |
| `experimental.themes` | string or array | Optional | `.claude-plugin/plugin.json` / `themes/` | Theme definitions | `sourced` |
| `experimental.monitors` | string, array, or object | Optional | `.claude-plugin/plugin.json` / `monitors/monitors.json` | Background monitors | `sourced` |
| `userConfig` | object | Optional | `.claude-plugin/plugin.json` | Defines user-entered config values for substitution/env injection | `sourced` |
| `settings` | object | Optional | `.claude-plugin/plugin.json` | Plugin-declared defaults; docs note `settings.json` has priority | `sourced` |

Notes:

- The issue prompt requested `mcp` and `permissions`; current docs use `mcpServers` and do not define a manifest `permissions` key.
- Permission control is exposed via settings and agent-level/tool-level controls, not a top-level `permissions` manifest field in current schema docs.

## Directory Layout

Root-level layout expectations (`verified` for paths in CLI/docs help text; behavior mostly `sourced` unless noted):

- `.claude-plugin/plugin.json` (manifest)
- `commands/` (flat `*.md` command files)
- `skills/` (`<name>/SKILL.md` structure)
- `agents/` (agent markdown)
- `hooks/hooks.json`
- `.mcp.json`
- `.lsp.json`
- `monitors/monitors.json`
- `bin/` (executables on plugin PATH)
- `settings.json` (limited supported keys, per docs)

Important constraint (`sourced`): component directories are at plugin root and should not be nested under `.claude-plugin/`.

## Commands And Skills

- Commands: flat markdown files under `commands/*.md` (`verified` in experiment)
- Skills: directories under `skills/<name>/SKILL.md` (`sourced`)
- Namespace behavior: plugin components are namespaced by plugin `name`, e.g. `/wavemill-hello-world:hello` (`verified`)
- Frontmatter requirements:
  - `commands/hello.md` with frontmatter `description` and optional `argument-hint` validated and loaded (`verified`)
  - Full frontmatter contract for commands/skills is `sourced`

## Agents

- Plugin agents live in `agents/*.md` (`sourced`)
- They appear in `/agents` and can be invoked automatically or manually (`sourced`)
- Supported frontmatter includes `name`, `description`, `model`, `effort`, `maxTurns`, `tools`, `disallowedTools`, `skills`, `memory`, `background`, `isolation` (`sourced`)
- For plugin agents, docs say `hooks`, `mcpServers`, and `permissionMode` are not supported in agent frontmatter (`sourced`)

## Hooks

- Preferred file: `hooks/hooks.json` (`sourced`)
- Also configurable inline via manifest `hooks` field (`sourced`)
- Hook schema uses event matchers and action types (`command`, `http`, `mcp_tool`, `prompt`, `agent`) (`sourced`)

## MCP Servers

- Plugin MCP file: `.mcp.json` at plugin root (`sourced`)
- Manifest key: `mcpServers` (`sourced`)
- Variable/path behavior: docs describe `${CLAUDE_PLUGIN_ROOT}` and `${user_config.KEY}` substitutions (`sourced`)
- Not empirically tested in this spike (`unverified`)

## Permissions And Settings

- Top-level manifest `permissions` field: not present in current docs schema (`verified` against docs/CLI output)
- Plugin `settings.json` is supported at plugin root with currently limited supported keys (`sourced`)
- Docs indicate settings can also be declared in `plugin.json`, and `settings.json` takes priority (`sourced`)
- Permission behavior should be treated as settings/hook/tool-policy surfaces, not a plugin manifest `permissions` field (`sourced`)

## Zip Structure

Two zip layouts were tested with `--plugin-dir` on CLI `2.1.141`:

- Accepted (`verified`): zip root is plugin root (contains `.claude-plugin/`, `commands/`, etc.)
  - `/tmp/wavemill-hello-world-plugin-root.zip`
- Accepted (`verified`): zip has one top-level directory that contains plugin root
  - `/tmp/wavemill-hello-world-plugin-flat.zip` created from `experiments/hello-world-plugin/`

Docs requirement (`sourced`): `.zip` with `--plugin-dir` requires Claude Code `v2.1.128+`.

## --plugin-dir Loader Behavior

Observed on local CLI `2.1.141`:

- Path type (`verified`): accepts directory path and `.zip` path.
- Relative paths (`verified`): `./experiments/hello-world-plugin` resolved correctly from repo root.
- Multiple flags (`verified`): repeated flags accepted (`--plugin-dir A --plugin-dir B.zip`).
- Namespace exposure (`verified`): command discovered as `/wavemill-hello-world:hello`.
- Command invocation (`verified`): slash command executed in `-p` mode with and without arguments.
- Error handling (`verified`): invalid manifest schema fails validation with typed error.
  - Example from `claude plugin validate`: `name: Invalid input: expected string, received number`.
- Reload behavior (`unverified`): `/reload-plugins` was not exercised in this non-interactive spike.
- Local precedence over installed plugin with same name (`sourced`): documented, not re-tested.

## Gap Analysis: Wavemill Assets

| Wavemill area | Current layout | Claude plugin expectation | Gap/mismatch | Packaging implication |
|---|---|---|---|---|
| `commands/` | Flat markdown files (`commands/*.md`) | Same flat markdown command surface supported | Low gap | Can be packaged mostly as-is, but plugin namespacing will change invocation to `/plugin-name:command` |
| `skills/` | `skills/<name>/SKILL.md` directories | Same `skills/<name>/SKILL.md` structure | Low gap | Can be packaged with minimal reshaping; keep skill folder boundaries |
| `agents/` | Flat markdown agent files in `agents/` | Same `agents/*.md` surface, with plugin-agent frontmatter restrictions | Medium gap | Need validation pass for unsupported agent frontmatter fields (`hooks`, `mcpServers`, `permissionMode`) before packaging |

Additional naming implications:

- Existing top-level repo folder names align with plugin component naming.
- Manifest key mismatch vs prompt wording: use `mcpServers` (not `mcp`).
- No first-class manifest `permissions` key to map directly from prompt wording.

## Open Questions

- Exact merge/precedence semantics when both default component folders and explicit manifest path fields are present were not locally tested.
- `settings.json` key support beyond `agent` and `subagentStatusLine` was not empirically tested.
- Hook/MCP/LSP/monitor runtime behavior and security boundaries were not exercised.
- `/reload-plugins` behavior after file edits was not empirically tested in this spike.
