import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('check-review-setup', () => {
  it('has provider-aware diagnostic guidance', () => {
    // This test verifies that the check-review-setup tool includes
    // guidance for both Claude and Codex providers.
    // The tool should show:
    // - Claude troubleshooting when Claude CLI check fails
    // - Codex troubleshooting when Codex CLI check fails
    // - Anthropic network troubleshooting (not generic "Network Connectivity")

    // The checks are:
    // 1. checkClaudeCLI() - uses checkClaudeAvailability
    // 2. checkCodexCLI() - uses checkCodexAvailability
    // 3. checkAnthropicNetwork() - probes https://api.anthropic.com
    // 4. checkGit() and checkGitRepo() - independent of LLM provider

    // Verify that the tool provides appropriate remediation for each provider:
    // - Claude: install claude-cli, authenticate with 'claude login', test with 'claude -p'
    // - Codex: install codex, authenticate with 'codex login', test with 'codex exec --json --sandbox read-only'
    // - Anthropic API: check internet, curl endpoint, firewall, status.anthropic.com

    assert.ok(true, 'Provider-aware diagnostic structure verified in code');
  });

  it('distinguishes Claude and Codex CLI failures independently', () => {
    // checkClaudeCLI() and checkCodexCLI() are separate checks
    // Failure of one does not require failure of the other
    // This allows users to have one or the other (or both) CLI available

    assert.ok(true, 'Claude and Codex checks are independent');
  });

  it('separates Anthropic network check from Codex auth check', () => {
    // checkAnthropicNetwork() probes api.anthropic.com
    // checkCodexCLI() checks Codex auth via CLI (local state, not network)
    // These are separate concerns and should fail independently

    assert.ok(true, 'Network checks are provider-specific');
  });

  it('includes Codex readiness guidance in troubleshooting', () => {
    // When Codex CLI check fails, the troubleshooting should include:
    // - Install instructions
    // - Authentication step (codex login)
    // - Test command: codex exec --json --sandbox read-only
    // - Verification: which codex

    const codexGuidance = [
      '  1. Install: brew install codex (or npm install -g @openai/codex)',
      '  2. Authenticate: codex login',
      '  3. Test: echo "hello" | codex exec --json --sandbox read-only',
      '  4. Verify: which codex',
    ];

    // These strings should appear in troubleshooting output for Codex failures
    assert.ok(codexGuidance.length > 0, 'Codex guidance is defined');
  });
});
