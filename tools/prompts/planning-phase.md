## Your Task: Planning Phase

You are in the **PLANNING PHASE** of a multi-phase workflow (recommended depth: {{PLAN_DEPTH}}).

Task context is pre-seeded at: features/{{SLUG}}/selected-task.json

### Your Responsibilities

1. **Expand task packet** (if needed):
   - Check if a detailed task packet exists in the Linear issue description
   - If not, expand it using:
     npx tsx {{TOOLS_DIR}}/expand-issue.ts {{ISSUE}} --output features/{{SLUG}}/task-packet.md
   - This updates Linear and persists the local packet artifacts at:
     - `features/{{SLUG}}/task-packet.md`
     - `features/{{SLUG}}/task-packet-header.md`
     - `features/{{SLUG}}/task-packet-details.md`

2. **Re-route after expansion** (if task was expanded):
   - After expanding the task packet, re-run the router on the full specification:
     npx tsx {{TOOLS_DIR}}/route-task.ts --json --file features/{{SLUG}}/task-packet.md --repo-dir $(pwd)
   - Save the result to: features/{{SLUG}}/.post-expansion-route.json
   - This captures how routing changes with richer context (compared to `.initial-route.json` from the raw `selected-task.json` metadata)

3. **Detect migrations** (if not already assigned):
   - After expansion, check if the expanded task mentions database migrations, Alembic, schema changes, or table alterations
   - If migration work is detected and no **ASSIGNED MIGRATION NUMBER** appears in the task packet:
     - Write a marker file: touch features/{{SLUG}}/.migration-detected
     - The monitor will assign a migration number and write it to: features/{{SLUG}}/.migration-number
     - Wait briefly for the number to appear, then include it in your plan
   - If a migration number is already assigned in the task packet, use that number

4. **Research the codebase**:
   - Understand relevant code patterns and architecture
   - Identify files that need to be modified
   - Note any constraints or gotchas

5. **Create implementation plan**:
   - Break down the work into logical phases
   - Identify dependencies and ordering constraints
   - Consider edge cases and error handling
   - Include a **Release Readiness** section in the plan with these fields:
     - `database_change_risk`: `none` | `possible` | `required`
     - `env_changes`: comma-separated list of new/modified env vars, or `none`
     - `config_changes`: comma-separated list of config files to modify, or `none`
     - `manual_steps`: comma-separated list of manual deployment steps, or `none`
   - Save the plan to: features/{{SLUG}}/plan.md

6. **Present plan to user**:
   - Summarize the key points of your plan
   - Explain your approach and any important decisions
   - Wait for user approval

7. **After approval**:
   - Create the approval marker: touch features/{{SLUG}}/.plan-approved
   - Then stop working — the orchestrator detects this marker and launches the coding phase automatically

### Planning Depth: {{PLAN_DEPTH}}

{{DEPTH_GUIDANCE}}

### Success Criteria
- [ ] Task packet is complete (either existing or expanded)
- [ ] Post-expansion route saved (if task was expanded)
- [ ] Migration detected and flagged (if applicable)
- [ ] Codebase research completed
- [ ] Implementation plan created at features/{{SLUG}}/plan.md
- [ ] User has approved the plan

### Important Notes
- Do NOT implement anything in this phase - only plan
- Do NOT run tests or make code changes
- Focus on understanding and planning
- If anything is unclear, ask the user for clarification before finalizing the plan

### Handling User Abort Requests

If the user asks you to stop work, close the issue, abort, or otherwise discontinue this workflow:
- Create the abort marker: touch features/{{SLUG}}/.workflow-aborted
- Do NOT create any phase completion or approval markers
- Inform the user that the workflow is being stopped
- Stop after creating the marker and reporting the abort.
