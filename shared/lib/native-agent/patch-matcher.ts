import type {
  NativePatch,
  NativePatchEditOperation,
  NativePatchFuzzyMatch,
  NativePatchRuntimeRejection,
  NativePatchRuntimeRejectionCode,
} from './patch-contract.ts';

export interface OperationMatch {
  startOffset: number;
  endOffset: number;
  startLine: number;
  endLine: number;
  strategy: 'exact' | 'anchored' | 'fuzzy';
  similarity?: number;
}

type MatchResult =
  | { ok: true; match: OperationMatch }
  | { ok: false; rejection: NativePatchRuntimeRejection };

type LocateResult =
  | { ok: true; matches: OperationMatch[] }
  | { ok: false; rejection: NativePatchRuntimeRejection };

/** Minimum similarity ratio for a fuzzy candidate to be accepted. */
const DEFAULT_MIN_SIMILARITY = 0.75;

/** Maximum number of fuzzy candidates to evaluate. */
const DEFAULT_MAX_MATCH_CANDIDATES = 5;

/** Maximum number of context lines in excerpts. */
const DEFAULT_MAX_CONTEXT_LINES = 4;

/** Whether to collapse whitespace before scoring by default. */
const DEFAULT_IGNORE_WHITESPACE = false;

/** Whether fuzzy candidates must also satisfy anchor overlap by default. */
const DEFAULT_REQUIRE_ANCHOR_OVERLAP = false;

/** Minimum margin between best and second-best fuzzy similarity to avoid ambiguity. */
const FUZZY_MARGIN = 0.05;

function resolvedFuzzy(config: NativePatchFuzzyMatch | undefined): Required<NativePatchFuzzyMatch> {
  return {
    minSimilarity: config?.minSimilarity ?? DEFAULT_MIN_SIMILARITY,
    maxMatchCandidates: config?.maxMatchCandidates ?? DEFAULT_MAX_MATCH_CANDIDATES,
    maxContextLines: config?.maxContextLines ?? DEFAULT_MAX_CONTEXT_LINES,
    ignoreWhitespace: config?.ignoreWhitespace ?? DEFAULT_IGNORE_WHITESPACE,
    requireAnchorOverlap: config?.requireAnchorOverlap ?? DEFAULT_REQUIRE_ANCHOR_OVERLAP,
  };
}

/** Return 0-based line number for a given byte offset in content. */
function lineAt(content: string, offset: number): number {
  let line = 0;
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content[i] === '\n') line++;
  }
  return line;
}

/** Find all start offsets of needle in haystack (non-overlapping). */
function findAllOccurrences(haystack: string, needle: string): number[] {
  const results: number[] = [];
  let pos = 0;
  while (pos <= haystack.length - needle.length) {
    const idx = haystack.indexOf(needle, pos);
    if (idx === -1) break;
    results.push(idx);
    pos = idx + needle.length;
  }
  return results;
}

/** Normalize text for whitespace-insensitive comparison: collapse runs to single space, trim. */
function normalizeWs(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Compute a simple line-level similarity ratio between two strings.
 * Returns a value in [0, 1]: 1.0 means identical, 0 means completely different.
 */
function lineSimilarity(a: string, b: string, ignoreWhitespace: boolean): number {
  const aLines = a.split('\n').map((l) => (ignoreWhitespace ? normalizeWs(l) : l));
  const bLines = b.split('\n').map((l) => (ignoreWhitespace ? normalizeWs(l) : l));

  const maxLen = Math.max(aLines.length, bLines.length);
  if (maxLen === 0) return 1;

  let matches = 0;
  const minLen = Math.min(aLines.length, bLines.length);
  for (let i = 0; i < minLen; i++) {
    if (aLines[i] === bLines[i]) {
      matches++;
    } else {
      // Partial credit via character-level ratio
      matches += charSimilarity(aLines[i] ?? '', bLines[i] ?? '');
    }
  }

  return matches / maxLen;
}

/** Character-level similarity ratio (0–1). Uses simple LCS approximation. */
function charSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  const dist = levenshtein(a, b);
  return Math.max(0, 1 - dist / maxLen);
}

/** Levenshtein distance (capped at max 500 chars for performance). */
function levenshtein(a: string, b: string): number {
  const A = a.slice(0, 500);
  const B = b.slice(0, 500);
  const m = A.length;
  const n = B.length;
  const row = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = i;
    for (let j = 1; j <= n; j++) {
      const next = A[i - 1] === B[j - 1] ? (row[j - 1] ?? 0) : Math.min((row[j - 1] ?? 0) + 1, (row[j] ?? 0) + 1, prev + 1);
      row[j - 1] = prev;
      prev = next;
    }
    row[n] = prev;
  }
  return row[n] ?? 0;
}

/** Truncate text to maxLines lines, appending "…" if truncated. */
function truncateLines(text: string, maxLines: number): string {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;
  return lines.slice(0, maxLines).join('\n') + '\n…';
}

/** Extract a bounded excerpt around a region in content. */
function excerpt(
  content: string,
  startOffset: number,
  endOffset: number,
  maxContextLines: number,
): { text: string; startLine: number; endLine: number } {
  const regionText = content.slice(startOffset, endOffset);
  const startLine = lineAt(content, startOffset);
  const endLine = lineAt(content, endOffset - 1);
  const truncated = truncateLines(regionText, maxContextLines);
  return { text: truncated, startLine, endLine };
}

/** Build the rejection-feedback contract object. */
function buildRejection(
  code: NativePatchRuntimeRejectionCode,
  operationIndex: number,
  operation: NativePatchEditOperation,
  fileContent: string,
  message: string,
  candidateOffset?: number,
  candidateEndOffset?: number,
  fuzzyConfig?: NativePatchFuzzyMatch,
): NativePatchRuntimeRejection {
  const maxContextLines = fuzzyConfig?.maxContextLines ?? DEFAULT_MAX_CONTEXT_LINES;
  const ignoreWs = fuzzyConfig?.ignoreWhitespace ?? DEFAULT_IGNORE_WHITESPACE;

  const normalizedOldText = ignoreWs ? normalizeWs(operation.oldText) : operation.oldText.trim();

  const requestedContext: NativePatchRuntimeRejection['requestedContext'] = {
    oldText: normalizedOldText,
  };
  if (operation.anchorBefore) requestedContext.anchorBefore = operation.anchorBefore;
  if (operation.anchorAfter) requestedContext.anchorAfter = operation.anchorAfter;

  let hint: string;
  switch (code) {
    case 'old_text_not_found':
      hint = 'Re-read the file; oldText no longer matches. Nearest similar block shown.';
      break;
    case 'ambiguous_anchor':
      hint = 'Add/adjust anchorBefore/anchorAfter or expectedOccurrences to disambiguate the candidates.';
      break;
    case 'anchor_mismatch':
      hint = 'oldText was found but the surrounding anchor did not match the live file.';
      break;
    default:
      hint = 'Check the operation and retry.';
  }

  let liveContext: NativePatchRuntimeRejection['liveContext'];
  if (candidateOffset !== undefined && candidateEndOffset !== undefined) {
    const ex = excerpt(fileContent, candidateOffset, candidateEndOffset, maxContextLines);
    liveContext = {
      path: operation.path,
      excerpt: ex.text,
      startLine: ex.startLine + 1, // 1-based for output
      endLine: ex.endLine + 1,
    };
  } else if (fileContent.length > 0) {
    // Show file head as fallback
    const headEnd = fileContent.indexOf('\n', fileContent.split('\n').slice(0, maxContextLines).join('\n').length);
    const headOffset = headEnd === -1 ? Math.min(fileContent.length, 200) : headEnd;
    const ex = excerpt(fileContent, 0, headOffset, maxContextLines);
    liveContext = {
      path: operation.path,
      excerpt: ex.text,
      startLine: 1,
      endLine: ex.endLine + 1,
    };
  }

  return {
    operationIndex,
    code,
    message,
    requestedContext,
    liveContext,
    hint,
  };
}

/**
 * Match a single edit operation against file content.
 * Returns a match location or a rejection with diagnostic context.
 */
export function matchEditOperation(
  operation: NativePatchEditOperation,
  fileContent: string,
  fuzzyConfig?: NativePatchFuzzyMatch,
): MatchResult {
  const { oldText, anchorBefore, anchorAfter, expectedOccurrences } = operation;
  const cfg = resolvedFuzzy(fuzzyConfig);

  // --- Step 1: Exact match ---
  const occurrences = findAllOccurrences(fileContent, oldText);
  const count = occurrences.length;

  if (count > 0) {
    // Check expectedOccurrences mismatch first
    if (expectedOccurrences !== undefined && count !== expectedOccurrences) {
      const startOffset = occurrences[0]!;
      const endOffset = startOffset + oldText.length;
      return {
        ok: false,
        rejection: buildRejection(
          'ambiguous_anchor',
          operation.op === 'edit' ? 0 : 0, // index supplied by caller
          operation,
          fileContent,
          `oldText matched ${count} time(s) but expectedOccurrences is ${expectedOccurrences}.`,
          startOffset,
          endOffset,
          fuzzyConfig,
        ),
      };
    }

    // --- Step 2: Fast-exit for single occurrence with no anchors ---
    if (count === 1 && anchorBefore === undefined && anchorAfter === undefined && expectedOccurrences === undefined) {
      const startOffset = occurrences[0]!;
      const endOffset = startOffset + oldText.length;
      return {
        ok: true,
        match: {
          startOffset,
          endOffset,
          startLine: lineAt(fileContent, startOffset) + 1,
          endLine: lineAt(fileContent, endOffset - 1) + 1,
          strategy: 'exact',
        },
      };
    }

    // --- Step 3: Context-anchored filter (applies when anchors present or count > 1) ---
    if (anchorBefore !== undefined || anchorAfter !== undefined || count > 1) {
      const anchored = occurrences.filter((offset) => {
        const end = offset + oldText.length;
        if (anchorBefore !== undefined) {
          const pre = fileContent.slice(Math.max(0, offset - anchorBefore.length), offset);
          if (pre !== anchorBefore) return false;
        }
        if (anchorAfter !== undefined) {
          const post = fileContent.slice(end, end + anchorAfter.length);
          if (post !== anchorAfter) return false;
        }
        return true;
      });

      if (anchored.length === 1) {
        const startOffset = anchored[0]!;
        const endOffset = startOffset + oldText.length;
        return {
          ok: true,
          match: {
            startOffset,
            endOffset,
            startLine: lineAt(fileContent, startOffset) + 1,
            endLine: lineAt(fileContent, endOffset - 1) + 1,
            strategy: count === 1 ? 'exact' : 'anchored',
          },
        };
      }

      if (anchored.length === 0 && (anchorBefore !== undefined || anchorAfter !== undefined)) {
        const startOffset = occurrences[0]!;
        const endOffset = startOffset + oldText.length;
        return {
          ok: false,
          rejection: buildRejection(
            'anchor_mismatch',
            0,
            operation,
            fileContent,
            `oldText was found ${count} time(s) but no occurrence matched the specified anchor(s).`,
            startOffset,
            endOffset,
            fuzzyConfig,
          ),
        };
      }

      // anchored.length > 1
      const startOffset = anchored[0]!;
      const endOffset = startOffset + oldText.length;
      return {
        ok: false,
        rejection: buildRejection(
          'ambiguous_anchor',
          0,
          operation,
          fileContent,
          `oldText matched ${anchored.length} locations even after anchor filtering. Provide more specific anchors.`,
          startOffset,
          endOffset,
          fuzzyConfig,
        ),
      };
    }

    // Exactly 1 occurrence, no anchors needed
    const startOffset = occurrences[0]!;
    const endOffset = startOffset + oldText.length;
    return {
      ok: true,
      match: {
        startOffset,
        endOffset,
        startLine: lineAt(fileContent, startOffset) + 1,
        endLine: lineAt(fileContent, endOffset - 1) + 1,
        strategy: 'exact',
      },
    };
  }

  // --- Step 3: Fuzzy match (0 exact occurrences) ---
  if (!fuzzyConfig) {
    return {
      ok: false,
      rejection: buildRejection(
        'old_text_not_found',
        0,
        operation,
        fileContent,
        'oldText not found in file. No fuzzy matching configured.',
        undefined,
        undefined,
        fuzzyConfig,
      ),
    };
  }

  const oldLines = oldText.split('\n');
  const fileLines = fileContent.split('\n');
  const windowSize = oldLines.length;

  type Candidate = { score: number; startLine: number; endLine: number; startOffset: number; endOffset: number };
  const candidates: Candidate[] = [];

  for (let i = 0; i <= fileLines.length - windowSize; i++) {
    const windowLines = fileLines.slice(i, i + windowSize);
    const windowText = windowLines.join('\n');
    const score = lineSimilarity(oldText, windowText, cfg.ignoreWhitespace);

    if (score >= cfg.minSimilarity) {
      // Compute byte offsets
      let startOffset = 0;
      for (let l = 0; l < i; l++) startOffset += (fileLines[l]?.length ?? 0) + 1;
      const endOffset = startOffset + windowText.length;

      // Optionally require anchor overlap
      if (cfg.requireAnchorOverlap) {
        if (anchorBefore !== undefined) {
          const pre = fileContent.slice(Math.max(0, startOffset - anchorBefore.length), startOffset);
          if (pre !== anchorBefore) continue;
        }
        if (anchorAfter !== undefined) {
          const post = fileContent.slice(endOffset, endOffset + anchorAfter.length);
          if (post !== anchorAfter) continue;
        }
      }

      candidates.push({ score, startLine: i, endLine: i + windowSize - 1, startOffset, endOffset });
    }
  }

  // Sort by score descending
  candidates.sort((a, b) => b.score - a.score);
  const top = candidates.slice(0, cfg.maxMatchCandidates);

  if (top.length === 0) {
    return {
      ok: false,
      rejection: buildRejection(
        'old_text_not_found',
        0,
        operation,
        fileContent,
        'oldText not found and no sufficiently similar block was located.',
        undefined,
        undefined,
        fuzzyConfig,
      ),
    };
  }

  const best = top[0]!;
  const second = top[1];

  // Ambiguous if two candidates are too close in score
  if (second !== undefined && best.score - second.score < FUZZY_MARGIN) {
    return {
      ok: false,
      rejection: buildRejection(
        'ambiguous_anchor',
        0,
        operation,
        fileContent,
        `Fuzzy match found ${top.length} near-equal candidates (best=${best.score.toFixed(2)}, second=${second.score.toFixed(2)}). Add anchors to disambiguate.`,
        best.startOffset,
        best.endOffset,
        fuzzyConfig,
      ),
    };
  }

  return {
    ok: true,
    match: {
      startOffset: best.startOffset,
      endOffset: best.endOffset,
      startLine: best.startLine + 1,
      endLine: best.endLine + 1,
      strategy: 'fuzzy',
      similarity: best.score,
    },
  };
}

/**
 * Locate all operations in a patch atomically.
 * Returns all matches (in order) or the first failing operation's rejection.
 * The `readFile` callback returns file content or null if the file does not exist.
 */
export async function locateOperations(
  patch: NativePatch,
  readFile: (path: string) => Promise<string | null> | string | null,
): Promise<LocateResult> {
  const matches: OperationMatch[] = [];

  for (let i = 0; i < patch.operations.length; i++) {
    const operation = patch.operations[i]!;

    if (operation.op === 'edit-diff') {
      // edit-diff is not yet supported — reject with a clear message
      const rejection: NativePatchRuntimeRejection = {
        operationIndex: i,
        code: 'old_text_not_found',
        message: 'edit-diff operations are not yet supported by the matching engine.',
        requestedContext: { diff: operation.diff },
        hint: 'Use an edit operation with oldText/newText instead.',
      };
      return { ok: false, rejection };
    }

    const fileContent = await readFile(operation.path);

    if (fileContent === null) {
      const rejection: NativePatchRuntimeRejection = {
        operationIndex: i,
        code: 'old_text_not_found',
        message: `File not found: ${operation.path}`,
        requestedContext: { oldText: operation.oldText },
        hint: 'Re-read the file; oldText no longer matches. Nearest similar block shown.',
      };
      return { ok: false, rejection };
    }

    const result = matchEditOperation(operation, fileContent, patch.fuzzyMatch);

    if (!result.ok) {
      // Stamp the correct operation index
      result.rejection.operationIndex = i;
      return { ok: false, rejection: result.rejection };
    }

    matches.push(result.match);
  }

  return { ok: true, matches };
}
