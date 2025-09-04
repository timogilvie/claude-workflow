import { execSync } from "child_process";

export const createGitBranch = (name: string) => {
  const sanitized = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  const branchName = `feature/${sanitized}`;
  try {
    execSync(`git checkout -b ${branchName}`, { stdio: "inherit" });
    return `✅ Created and switched to branch: ${branchName}`;
  } catch (err) {
    return `❌ Failed to create branch: ${err}`;
  }
};

// Test the function
const result = createGitBranch("test-branch");
console.log(result);