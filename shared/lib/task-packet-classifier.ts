import type { TaskType } from './model-router.ts';

export type ComplexityBand = 'xs' | 's' | 'm' | 'l' | 'xl';

export interface PacketClassificationEvidence {
  charCount: number;
  promptLength: 'short' | 'medium' | 'long';
  fileTypes: string[];
  declaredFileCount: number;
  phaseCount: number;
  requirementCount: number;
  validationCount: number;
  explicitEstimateCount: number;
  taskTypeScores: Record<TaskType, number>;
  matchedSignals: string[];
}

export interface TaskPacketClassification {
  taskType: TaskType;
  complexity: number;
  complexityScore: number;
  complexityBand: ComplexityBand;
  riskFlags: string[];
  riskScore: number;
  suspiciousZero: boolean;
  suspiciousZeroReason?: string;
  evidence: PacketClassificationEvidence;
}

const FILE_TYPE_PATTERN = /\.\b(ts|tsx|js|jsx|py|sh|json|yaml|yml|md|css|html|sql|go|rs|rb)\b/gi;

const TASK_TYPE_WEIGHTS: Array<{ type: TaskType; weight: number; patterns: RegExp[] }> = [
  {
    type: 'feature',
    weight: 3,
    patterns: [
      /\b(add|implement|create|build|introduce|integrate|develop|support)\b/i,
      /\bnew\s+(module|workflow|cli|command|scorer|model|schema|dispatch|feature)\b/i,
      /\bgreenfield\b/i,
      /\bv1\b/i,
    ],
  },
  {
    type: 'bugfix',
    weight: 2,
    patterns: [
      /\bfix\b/i,
      /\bbug\b/i,
      /\bbroken\b/i,
      /\bregression\b/i,
      /\bfailing\b/i,
      /\bdoes not\b/i,
      /\bnever\b/i,
    ],
  },
  {
    type: 'refactor',
    weight: 2,
    patterns: [/\brefactor\b/i, /\brestructur/i, /\breorganiz/i, /\bextract\b/i, /\bsimplif/i],
  },
  {
    type: 'test',
    weight: 2,
    patterns: [/\btest\b/i, /\bspec\b/i, /\bcoverage\b/i, /\bassertion\b/i, /\be2e\b/i],
  },
  {
    type: 'documentation',
    weight: 2,
    patterns: [/\bdocument/i, /\breadme\b/i, /\bjsdoc\b/i, /\btsdoc\b/i, /\bchangelog\b/i],
  },
  {
    type: 'infrastructure',
    weight: 2,
    patterns: [/\bci\b/i, /\bcd\b/i, /\bdeploy/i, /\bdocker/i, /\bpipeline\b/i, /\bmigration\b/i, /\bconfig\b/i],
  },
];

const COMPLEXITY_PATTERNS = [
  /\bmulti[- ]?(phase|stage|step)\b/i,
  /\bstatistical\s+analysis\b/i,
  /\bshadow[- ]?mode\b/i,
  /\bdispatch\b/i,
  /\bschema\b/i,
  /\beval\b/i,
  /\brouter\b/i,
  /\bclassifier\b/i,
  /\bscorer\b/i,
  /\bcli\b/i,
  /\bworkflow\b/i,
  /\bintegration\b/i,
  /\bconcurren/i,
  /\basync\b/i,
  /\bsecurity\b/i,
  /\bperformance\b/i,
  /\bauth(entication|orization)?\b/i,
  /\bdatabase\b/i,
  /\bmigration\b/i,
];

function countMatches(text: string, patterns: RegExp[]): number {
  return patterns.reduce((count, pattern) => count + (pattern.test(text) ? 1 : 0), 0);
}

function uniqueFileTypes(text: string): string[] {
  const matches = text.match(FILE_TYPE_PATTERN) || [];
  return [...new Set(matches.map((match) => match.toLowerCase()))];
}

function countLikelyListItems(text: string, heading: RegExp): number {
  const match = heading.exec(text);
  if (!match || typeof match.index !== 'number') {
    return 0;
  }
  const rest = text.slice(match.index + match[0].length);
  const nextHeading = rest.search(/\n#{1,6}\s+/);
  const section = nextHeading >= 0 ? rest.slice(0, nextHeading) : rest;
  return (section.match(/^\s*(?:[-*]|\d+[.)])\s+/gm) || []).length;
}

function extractLargestNumberBefore(text: string, units: RegExp): number {
  let largest = 0;
  const pattern = new RegExp(String.raw`(\d{1,4}(?:,\d{3})*|\d+)\s*(?:${units.source})`, 'gi');
  for (const match of text.matchAll(pattern)) {
    const parsed = Number(match[1].replace(/,/g, ''));
    if (Number.isFinite(parsed)) {
      largest = Math.max(largest, parsed);
    }
  }
  return largest;
}

function scoreTaskType(text: string): Record<TaskType, number> {
  const scores: Record<TaskType, number> = {
    feature: 0,
    bugfix: 0,
    refactor: 0,
    test: 0,
    documentation: 0,
    infrastructure: 0,
    unknown: 0,
  };

  for (const entry of TASK_TYPE_WEIGHTS) {
    scores[entry.type] += countMatches(text, entry.patterns) * entry.weight;
  }

  const declaredFiles = extractLargestNumberBefore(text, /\b(files?|modules?)\b/i);
  const declaredLoc = extractLargestNumberBefore(text, /\b(lines?|loc)\b/i);
  const phaseCount = countLikelyListItems(text, /(?:^|\n)#{1,6}\s*(?:phases?|implementation plan|plan)\b[^\n]*\n/i);

  if (/\bgreenfield\b/i.test(text) || /\bnew modules?\b/i.test(text)) scores.feature += 6;
  if (declaredFiles >= 4) scores.feature += 3;
  if (declaredLoc >= 500) scores.feature += 3;
  if (phaseCount >= 3) scores.feature += 3;
  if (/\bone[- ]file\b/i.test(text) || /\bsingle[- ]file\b/i.test(text)) scores.bugfix += 3;
  if (/\bfix(?:es)?\s+(?:a|the)?\s*(?:bug|regression|failure)\b/i.test(text)) scores.bugfix += 3;

  return scores;
}

function chooseTaskType(scores: Record<TaskType, number>): TaskType {
  const ordered: TaskType[] = ['feature', 'bugfix', 'refactor', 'infrastructure', 'test', 'documentation'];
  let best: TaskType = 'unknown';
  let bestScore = 0;
  for (const type of ordered) {
    if (scores[type] > bestScore) {
      best = type;
      bestScore = scores[type];
    }
  }
  return bestScore > 0 ? best : 'unknown';
}

function complexityBand(score: number): ComplexityBand {
  if (score <= 1) return 'xs';
  if (score === 2) return 's';
  if (score === 3) return 'm';
  if (score === 4) return 'l';
  return 'xl';
}

function riskFlagsFor(text: string, evidence: PacketClassificationEvidence, complexity: number): string[] {
  const flags = new Set<string>();
  if (/\bmigration\b|\bschema\s+change\b|\bALTER\s+TABLE\b|\bCREATE\s+TABLE\b|\bDROP\s+TABLE\b/i.test(text)) {
    flags.add('schema-migration');
  }
  if (/\bmodify\b.*\b(runtime|production)\b|\b(runtime|production)\b.*\bmodify\b/i.test(text)) {
    flags.add('modifies-existing-runtime');
  }
  if (/\bcross[- ]service\b|\bmulti[- ]service\b|\bcross[- ]repo\b|\bmicroservice\b/i.test(text)) {
    flags.add('cross-service');
  }
  if (/\btest\b/i.test(text) && /\b(ci|infrastructure|harness)\b/i.test(text)) {
    flags.add('test-infrastructure');
  }
  if (/\brsc\b|\bserver\s+component\b/i.test(text)) {
    flags.add('rsc-serialization');
  }
  if (/\bgreenfield\b|\bcreate\s+new\b|\bnew modules?\b/i.test(text)) {
    flags.add('greenfield');
  }
  if (complexity >= 4 || evidence.declaredFileCount > 10 || /\blarge[- ]scope\b|\brefactor\b/i.test(text)) {
    flags.add('large-scope-refactor');
  }
  return [...flags].sort();
}

export function classifyTaskPacket(input: string): TaskPacketClassification {
  const text = String(input || '');
  const charCount = text.length;
  const promptLength = charCount < 200 ? 'short' : charCount < 1000 ? 'medium' : 'long';
  const declaredFileCount = Math.max(
    extractLargestNumberBefore(text, /\b(files?|modules?)\b/i),
    countLikelyListItems(text, /(?:^|\n)#{1,6}\s*(?:key files?|files?|modules?)\b[^\n]*\n/i),
  );
  const phaseCount = countLikelyListItems(text, /(?:^|\n)#{1,6}\s*(?:phases?|implementation plan|plan)\b[^\n]*\n/i);
  const requirementCount = countLikelyListItems(text, /(?:^|\n)#{1,6}\s*(?:requirements?|scope|acceptance)\b[^\n]*\n/i);
  const validationCount = countLikelyListItems(text, /(?:^|\n)#{1,6}\s*(?:validation|tests?)\b[^\n]*\n/i);
  const explicitEstimateCount = Math.max(
    extractLargestNumberBefore(text, /\b(lines?|loc)\b/i),
    extractLargestNumberBefore(text, /\b(files?|modules?)\b/i),
  );
  const fileTypes = uniqueFileTypes(text);
  const taskTypeScores = scoreTaskType(text);

  const evidence: PacketClassificationEvidence = {
    charCount,
    promptLength,
    fileTypes,
    declaredFileCount,
    phaseCount,
    requirementCount,
    validationCount,
    explicitEstimateCount,
    taskTypeScores,
    matchedSignals: [],
  };

  let rawComplexity = 1;
  if (charCount >= 1000) rawComplexity += 1;
  if (charCount >= 3000) rawComplexity += 1;
  if (fileTypes.length >= 3) rawComplexity += 1;
  if (declaredFileCount >= 3) rawComplexity += 1;
  if (declaredFileCount >= 8) rawComplexity += 1;
  if (phaseCount >= 2) rawComplexity += 1;
  if (phaseCount >= 5) rawComplexity += 1;
  if (requirementCount >= 4) rawComplexity += 1;
  if (explicitEstimateCount >= 500) rawComplexity += 1;
  if (explicitEstimateCount >= 1500) rawComplexity += 1;
  rawComplexity += Math.min(3, countMatches(text, COMPLEXITY_PATTERNS));

  if (declaredFileCount > 0) evidence.matchedSignals.push(`files=${declaredFileCount}`);
  if (phaseCount > 0) evidence.matchedSignals.push(`phases=${phaseCount}`);
  if (explicitEstimateCount > 0) evidence.matchedSignals.push(`estimate=${explicitEstimateCount}`);

  const complexity = Math.min(5, rawComplexity);
  const riskFlags = riskFlagsFor(text, evidence, complexity);
  const riskScore = Math.max(
    complexity,
    Math.min(12, complexity + riskFlags.length + Math.floor(declaredFileCount / 4) + Math.floor(phaseCount / 2)),
  );

  const classification = {
    taskType: chooseTaskType(taskTypeScores),
    complexity,
    complexityScore: complexity,
    complexityBand: complexityBand(complexity),
    riskFlags,
    riskScore,
    suspiciousZero: false,
    evidence,
  } as TaskPacketClassification;

  const suspiciousZeroCheck = isSuspiciousZeroClassification(classification);
  if (suspiciousZeroCheck.suspicious) {
    classification.suspiciousZero = true;
    classification.suspiciousZeroReason = suspiciousZeroCheck.reason;
  }

  return classification;
}

export function isSuspiciousZeroClassification(classification: Pick<TaskPacketClassification, 'complexityScore' | 'evidence' | 'riskFlags'>): { suspicious: boolean; reason?: string } {
  if (classification.complexityScore !== 0) {
    return { suspicious: false };
  }

  const evidence = classification.evidence;
  if (evidence.charCount >= 1000) {
    return { suspicious: true, reason: `zero_complexity_long_packet:${evidence.charCount}` };
  }
  if (evidence.declaredFileCount >= 3) {
    return { suspicious: true, reason: `zero_complexity_files:${evidence.declaredFileCount}` };
  }
  if (evidence.phaseCount >= 2) {
    return { suspicious: true, reason: `zero_complexity_phases:${evidence.phaseCount}` };
  }
  if (classification.riskFlags.length > 0) {
    return { suspicious: true, reason: `zero_complexity_risk:${classification.riskFlags.join(',')}` };
  }

  return { suspicious: false };
}

