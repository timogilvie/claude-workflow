# Context Concept Page Generator

You are extending wavemill's context management system with **concept pages**.

## Goal

Create or update a **concept/entity page** under:

* `.wavemill/context/concepts/<concept-id>.md`

Concept pages are for **cross-cutting knowledge** that applies across multiple subsystems and should survive subsystem refactors.

Examples:

* `progressive-disclosure`
* `task-packet-format`
* `model-routing-strategy`

These are **not** subsystem specs and should not be written as module-by-module implementation docs.

## What Concept Pages Are For

A concept page should capture durable knowledge such as:

* shared vocabulary and definitions
* invariants and non-negotiable rules
* cross-cutting workflows or contracts
* decision criteria used in multiple places
* boundaries between related concepts
* examples of when the concept applies
* references to relevant subsystem specs

A concept page should remain useful even if:

* files move
* modules are renamed
* code is refactored
* subsystem boundaries change

## What Concept Pages Must Avoid

Do **not** turn the page into:

* a file inventory
* a code walkthrough
* a changelog
* a speculative design doc for unrelated future work
* a duplicate of one subsystem's implementation details

Do **not** include:

* large code excerpts
* low-level per-function descriptions unless absolutely necessary
* fragile references that will break on refactor

## Inputs You May Be Given

You may be given some combination of:

* the concept name or slug
* relevant subsystem specs from `.wavemill/context/`
* project context from `.wavemill/project-context.md`
* issue/task descriptions
* selected source files or diffs
* existing concept pages, if any

Use those to synthesize a durable concept page.

## Context

**Concept ID:** {{CONCEPT_ID}}
**Concept Name:** {{CONCEPT_NAME}}

### Relevant Subsystem Specs

{{RELEVANT_SUBSYSTEMS}}

### Project Context

{{PROJECT_CONTEXT}}

### Existing Content (if updating)

{{EXISTING_CONTENT}}

## Required Output Shape

Return the complete concept page as markdown.

Start with this structure and adapt only when necessary:

# Concept: <Human Name>

**Concept ID:** `<concept-id>`

## Purpose

Explain what this concept is, why it exists, and what problem it solves.

## When It Applies

Describe the situations, workflows, or decisions where this concept matters.

## Core Invariants

List the rules that should remain true regardless of implementation details.

## Mental Model

Explain the concept in a way that helps an LLM reason correctly about it.

Include:

* key abstractions
* important distinctions
* what is central vs incidental

## Operational Rules

Document the actionable rules or constraints an agent should follow when this concept is relevant.

Use concise bullets.

## Boundaries And Non-Goals

Explain what this concept does **not** cover.

Call out nearby concepts that may be confused with it.

## References In This Repo

List the most relevant subsystem specs, docs, or files.

Use references like:

* `.wavemill/context/router.md`
* `.wavemill/context/eval-system.md`
* `docs/eval-mode.md`

Only include references that materially help.

## Examples

Give 2-4 short concrete examples showing how the concept appears in practice.

Prefer examples that generalize across subsystems.

## Guidance For Future Updates

Describe what kinds of repo changes should cause this page to be updated.

## Writing Standards

Write for future LLM agents and human maintainers.

Be:

* durable
* specific
* concise
* implementation-aware without being implementation-bound

Prefer:

* definitions
* invariants
* decision rules
* cross-references

Avoid:

* fluff
* repetition
* module-level duplication
* restating obvious repository facts

## Specific Instructions

1. First determine whether the requested page is truly a **concept** or should remain a subsystem spec.
2. If it is mostly about one module's implementation, say so and do not force it into a concept page.
3. If it is a valid concept, synthesize the shared rules across subsystems.
4. Reference subsystem specs rather than copying them.
5. Preserve any existing stable terminology already used in the repo.
6. Prefer naming and framing that will still make sense after refactors.
7. If there are unresolved ambiguities, document them briefly in "Guidance For Future Updates" instead of inventing fake certainty.

## Output Requirements

* Output only the final markdown page.
* Do not include preamble or commentary.
* Do not include XML tags or tool narration.
