Execute the feature implementation workflow by:
1. First, run `node ~/.claude/tools/workflow.js` to display the workflow steps
2. Then follow the feature workflow exactly as described in ~/.claude/tools/prompts/workflow-prompt.md
3. Use `osascript -e 'beep'` to alert the user when you need input (like selecting a feature from the list)
4. Create the features/<feature-name>/ directory structure for PRD and tasks
5. Use the PRD and task templates from ~/.claude/tools/prompts/ as specified in the workflow
6. Guide the user through the entire process until the PR is ready for review
