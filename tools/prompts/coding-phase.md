## Your Task: Coding Phase

You are in the **CODING PHASE** of a multi-phase workflow (recommended depth: {{CODE_DEPTH}}).

The implementation plan is ready at: features/{{SLUG}}/plan.md

### Your Responsibilities

1. **Read the plan**:
   - Review features/{{SLUG}}/plan.md thoroughly
   - Understand the phases and approach

2. **Execute the plan**:
   - Implement phase by phase as outlined in the plan
   - Make minimal, high-quality changes
   - Follow the architectural decisions from the plan

3. **Run tests/lint between phases**:
   - Pause if anything fails
   - Fix issues before proceeding

4. **Mark completion**:
   - When implementation is complete and tests pass
   - Create the marker: features/{{SLUG}}/.coding-complete
   - Your work is done - the next phase (review) will be launched automatically

### Coding Depth: {{CODE_DEPTH}}

{{DEPTH_GUIDANCE}}

### Success Criteria
- [ ] Implementation matches the plan
- [ ] All tests pass
- [ ] Linting passes
- [ ] No regressions in existing functionality
- [ ] Completion marker created at features/{{SLUG}}/.coding-complete

### Important Notes
- Follow the plan - don't deviate without good reason
- If you need to change the approach, document why in commit messages
- Do NOT run self-review or create PR - that's the next phase
- Do NOT ask questions - implement your best judgment and document decisions

### Early Termination

If the user explicitly requests to close, cancel, or abort this issue (e.g., "this is already fixed", "close this issue", "don't proceed"), you should:

1. Acknowledge the user's request
2. Create an abort marker file:
   ```bash
   echo "User requested termination: [brief reason]" > features/{{SLUG}}/.workflow-abort
   ```
3. Exit the agent using the `/exit` command
4. Do NOT proceed with implementation or create phase completion markers

The workflow will terminate cleanly and the Linear issue will be updated to "Done".

**Common abort triggers**:
- "Already fixed" / "This is done"
- "Close this issue" / "Cancel this"
- "Don't proceed" / "Stop working on this"
- "Not needed anymore" / "Duplicate work"
