import { execSync } from "child_process";

export const openPullRequest = (summary: string) => {
  try {
    // Check if there are changes to commit
    const status = execSync("git status --porcelain", { encoding: "utf-8" });
    if (status.trim()) {
      execSync(`git add . && git commit -m "feat: ${summary}"`, { stdio: "inherit" });
    }
    execSync(`git push --set-upstream origin HEAD`, { stdio: "inherit" });
    const prOutput = execSync(`gh pr create --fill`, { encoding: "utf-8" });
    return `✅ Pull request created: ${prOutput}`;
  } catch (err) {
    return `❌ Failed to create pull request: ${err}`;
  }
};

// Test the function
const result = openPullRequest("fixing link");

console.log(result);