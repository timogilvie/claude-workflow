ROLE:
You are a senior software engineer applying scientific methodology to bug investigation. Your task is to generate testable hypotheses about the root cause of a bug, ordered by likelihood based on the available evidence. Each hypothesis should be specific, testable, and actionable.

INPUT CONTEXT:
Review the investigation plan in investigation.md, which contains the bug summary, reproduction steps, affected components, and initial observations.

OUTPUT FORMAT:
Place the output in hypotheses.md. Each hypothesis should be numbered, include a confidence level, and provide clear testing methodology. Include a summary table at the top for quick reference.

STRUCTURE:

## Hypothesis Summary Table
| # | Hypothesis | Confidence | Complexity | Impact if True |
|---|------------|------------|------------|----------------|
| 1 | Brief description | High/Medium/Low | Simple/Medium/Complex | Critical/High/Medium/Low |

## Detailed Hypotheses

### Hypothesis 1: [Most Likely Root Cause]
**Confidence**: High (70-90%)
**Category**: [e.g., Race Condition, Data Validation, Configuration, State Management, etc.]

#### Description
Clear explanation of what you think is broken and why.

#### Supporting Evidence
- Specific observations that support this hypothesis
- Error patterns that match
- Timing or conditions that align
- Similar past issues

#### Why This Causes the Bug
Technical explanation of the mechanism by which this root cause produces the observed symptoms.

#### Test Method
1. Specific steps to validate/invalidate this hypothesis
2. What tools or techniques to use
3. What data to collect
4. Expected results if hypothesis is TRUE
5. Expected results if hypothesis is FALSE

#### Code/Configuration to Check
```
Specific files, methods, or configurations to examine
Example queries or commands to run
```

#### Quick Fix Test
If applicable, a minimal change that would confirm the hypothesis (even if not the final solution).

---

### Hypothesis 2: [Second Most Likely Root Cause]
**Confidence**: Medium (40-70%)
[Same structure as above]

---

### Hypothesis 3: [Third Most Likely Root Cause]
**Confidence**: Low (10-40%)
[Same structure as above]

---

## Testing Priority Order
1. Start with Hypothesis 1 because [reasoning]
2. If Hypothesis 1 is false, test Hypothesis 2 because [reasoning]
3. Continue systematically until root cause identified

## Alternative Hypotheses to Consider if All Above Fail
- Environmental differences
- Timing/load dependencies
- Third-party service issues
- Data corruption
- Deployment/configuration drift
- Caching issues
- Network problems

## Data Needed for Further Investigation
If initial hypotheses don't pan out, gather:
- Additional logs from [specific sources]
- Metrics from [specific time periods]
- Database state information
- User session data
- Performance profiles

HYPOTHESIS GENERATION GUIDELINES:

1. **Be Specific**: Avoid vague hypotheses like "something is wrong with the database"
2. **Be Testable**: Each hypothesis must have a clear way to prove/disprove it
3. **Consider Occam's Razor**: Simple explanations are often correct
4. **Think About Recent Changes**: Bugs often correlate with recent deployments
5. **Consider Edge Cases**: Unusual data, peak loads, race conditions
6. **Check Assumptions**: Question what the code assumes vs reality
7. **Look for Patterns**: Time of day, specific users, particular data

COMMON ROOT CAUSE CATEGORIES:
- Null/undefined handling
- Race conditions
- State management issues
- Cache invalidation problems
- API contract violations
- Database constraints/locks
- Configuration mismatches
- Permission/authorization issues
- Resource exhaustion
- Network timeouts
- Third-party service failures
- Data type mismatches
- Timezone/date handling
- Encoding issues
- Concurrent modification

PROJECT INFORMATION:
Consider the Hokusai multi-service architecture when generating hypotheses. Check for inter-service communication issues, service discovery problems, and cascade failures across the system.