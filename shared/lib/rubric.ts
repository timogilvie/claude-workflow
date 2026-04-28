export const RUBRIC_SCHEMA_VERSION = '1.0';
export const RUBRIC_VERSION = '1.0';

export interface RubricCriterionDefinition {
  id: 'completeness' | 'correctness' | 'code_quality' | 'intervention_impact' | 'autonomy';
  description: string;
}

export const CANONICAL_RUBRIC_CRITERIA: readonly RubricCriterionDefinition[] = [
  { id: 'completeness', description: 'Were all requirements in the task prompt addressed?' },
  { id: 'correctness', description: 'Does the implementation work correctly based on the PR review?' },
  { id: 'code_quality', description: 'Is the code clean, idiomatic, and aligned with project conventions?' },
  {
    id: 'intervention_impact',
    description: 'Combined count and severity penalty. 1.0 means no interventions; lower scores reflect more severe intervention burden.',
  },
  { id: 'autonomy', description: 'Holistic judgment of how independently the agent executed the task.' },
] as const;

export function formatRubricForJudgePrompt(): string {
  return CANONICAL_RUBRIC_CRITERIA.map((criterion) => `- **${criterion.id}**: ${criterion.description}`).join('\n');
}

export function formatRubricForAgentPrompt(): string {
  const lines = [
    '## Grading Rubric',
    'Your output is evaluated with these criteria:',
    ...CANONICAL_RUBRIC_CRITERIA.map((criterion) => `- \`${criterion.id}\`: ${criterion.description}`),
  ];
  return lines.join('\n');
}
