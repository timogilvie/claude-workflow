## Prerequisites
Before starting, ensure you have:

1. Linear Access:
   - A Linear account with access to the project
   - Your Linear API key (Settings > API)
   - Add to `.env` file: `LINEAR_API_KEY=your_key_here`

2. GitHub Setup:
   - GitHub CLI installed (`brew install gh` on macOS)
   - GitHub account with repository access
   - Authenticated with GitHub CLI:
     ```bash
     gh auth login
     ```

3. Development Environment:
   ```bash
   # Install dependencies
   npm install
   
   # Verify setup
   node --version
   npm --version
   gh --version
   ```

4. Required Files:
   - `prd-prompt-template.md`
   - `tasks-prompt-template.md`
   - `.env` file in project root
