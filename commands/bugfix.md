Execute the bug investigation workflow by:
1. First, run `node ~/.claude/tools/bug-workflow.js` to display the workflow steps
2. Then follow the bug investigation workflow exactly as described in ~/.claude/tools/prompts/bug-workflow-prompt.md
3. Use `osascript -e 'beep'` to alert the user when you need input (like selecting a bug from the list)
4. Create the bugs/<bug-name>/ directory structure for all investigation documents
5. Use the investigation, hypothesis, and task templates from ~/.claude/tools/prompts/ as specified in the workflow
6. Systematically work through each hypothesis until the root cause is found
7. Guide the user through the entire 11-step process until the bug is fixed and PR is ready