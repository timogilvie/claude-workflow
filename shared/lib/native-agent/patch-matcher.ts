import type {
  NativePatchEditOperation,
  NativePatchFuzzyMatch,
  NativePatchRuntimeRejection,
  NativePatchRuntimeRejectionCode,
  NativePatchRuntimeRejectionContext,
} from './patch-contract.ts';

export type NativePatchMatchStrategy = 'exact' | 'offset' | 'fuzzy';

export interface NativePatchMatchOptions {
  /** Lines of context to include around the match in diagnostics. Default: 3. */
  contextLines?: number;
  /** Minimum similarity score [0,1] to accept a fuzzy match. Default: 0.9. */
  fuzzyThreshold?: number;
  /** Best score must exceed second-best by at least this margin. Default: 0.05. */
  fuzzyMargin?: number;
  /** Maximum characters in the live-context excerpt. Default: 400. */
  maxExcerptChars?: number;
}

export interface NativePatchMatchLocation {
  strategy: NativePatchMatchStrategy;
  /** Char offset of match start in liveContent (inclusive). */
  startIndex: number;
  /** Char offset of match end in liveContent (exclusive). */
  endIndex: number;
  /** 1-based line number of match start. */
  startLine: number;
  /** 1-based line number of match end. */
  endLine: number;
}

export type NativePatchMatchResult =
  | { ok: true; location: NativePatchMatchLocation }
  | { ok: false; rejection: NativePatchRuntimeRejection };

interface CharRange {
  start: number;
  end: number;
}

/**
 * Resolve an edit operation's oldText to exactly one unambiguous location in
 * liveContent, or return a structured rejection with bounded diagnostics.
 *
 * Matching ladder (stops at first resolution):
 *   1. Exact — single verbatim occurrence → strategy 'exact'
 *   2. Offset — 2+ verbatim occurrences, anchor uniquely selects one → 'offset'
 *   3. Fuzzy — no verbatim, best normalized-line similarity ≥ threshold → 'fuzzy'
 *
 * Non-edit operations are not supported; callers should only pass 'edit' ops.
 */
export function matchNativePatchOperation(
  liveContent: string,
  operation: NativePatchEditOperation,
  operationIndex: number,
  fuzzyMatch?: NativePatchFuzzyMatch,
  options?: NativePatchMatchOptions,
): NativePatchMatchResult {
  const contextLines = options?.contextLines ?? 3;
  const fuzzyThreshold = options?.fuzzyThreshold ?? fuzzyMatch?.minSimilarity ?? 0.9;
  const fuzzyMargin = options?.fuzzyMargin ?? 0.05;
  const maxExcerptChars = options?.maxExcerptChars ?? 400;

  const { oldText, anchorBefore, anchorAfter } = operation;
  const content = liveContent.replace(/\r\n/g, '\n');
  const searchText = oldText.replace(/\r\n/g, '\n');

  const lineOffsets = computeLineOffsets(content);
  const numLines = lineOffsets.length;

  // ── Step 1: Exact matching ────────────────────────────────────────────────
  const exactMatches = findAllOccurrences(content, searchText);

  if (exactMatches.length === 1) {
    const m = exactMatches[0];
    return {
      ok: true,
      location: {
        strategy: 'exact',
        startIndex: m.start,
        endIndex: m.end,
        startLine: offsetToLine(lineOffsets, m.start),
        endLine: offsetToLine(lineOffsets, Math.max(m.start, m.end - 1)),
      },
    };
  }

  // ── Step 2: Offset / anchored matching ───────────────────────────────────
  if (exactMatches.length >= 2) {
    const hasAnchors = anchorBefore !== undefined || anchorAfter !== undefined;
    const scored = exactMatches.map((m) => ({
      m,
      score: hasAnchors ? scoreAnchorAgreement(content, m, anchorBefore, anchorAfter) : 0,
    }));

    const maxScore = Math.max(...scored.map((s) => s.score));
    const winners = scored.filter((s) => s.score === maxScore);

    if (hasAnchors && maxScore === 0) {
      const first = exactMatches[0];
      return {
        ok: false,
        rejection: buildRejection({
          operationIndex,
          code: 'anchor_mismatch',
          message: `oldText found ${exactMatches.length} time(s) but no candidate agrees with the supplied anchor.`,
          operation,
          content,
          lineOffsets,
          numLines,
          candidateStart: first.start,
          candidateEnd: first.end,
          contextLines,
          maxExcerptChars,
          hint: 'Update anchorBefore / anchorAfter to match the surrounding content in the live file.',
        }),
      };
    }

    if (winners.length === 1 && maxScore > 0) {
      const m = winners[0].m;
      return {
        ok: true,
        location: {
          strategy: 'offset',
          startIndex: m.start,
          endIndex: m.end,
          startLine: offsetToLine(lineOffsets, m.start),
          endLine: offsetToLine(lineOffsets, Math.max(m.start, m.end - 1)),
        },
      };
    }

    const first = exactMatches[0];
    return {
      ok: false,
      rejection: buildRejection({
        operationIndex,
        code: 'ambiguous_anchor',
        message: `oldText found ${exactMatches.length} time(s) and could not be uniquely resolved.`,
        operation,
        content,
        lineOffsets,
        numLines,
        candidateStart: first.start,
        candidateEnd: first.end,
        contextLines,
        maxExcerptChars,
        hint: 'Add more surrounding context (anchorBefore / anchorAfter) or set expectedOccurrences to select the intended occurrence.',
      }),
    };
  }

  // ── Step 3: Fuzzy matching ───────────────────────────────────────────────
  const ignoreWs = fuzzyMatch?.ignoreWhitespace ?? false;
  const contentLines = content.split('\n');
  const windowSize = Math.max(1, searchText.split('\n').length);
  const oldNormLines = normalizeLines(searchText, ignoreWs);

  interface FuzzyCandidate {
    lineIndex: number;
    score: number;
    startChar: number;
    endChar: number;
  }

  const candidates: FuzzyCandidate[] = [];

  for (let i = 0; i <= contentLines.length - windowSize; i++) {
    const windowNorm = normalizeLines(contentLines.slice(i, i + windowSize).join('\n'), ignoreWs);
    const score = similarityRatio(oldNormLines, windowNorm);
    if (score > 0) {
      const startChar = lineOffsets[i];
      const endChar = i + windowSize < lineOffsets.length
        ? lineOffsets[i + windowSize]
        : content.length;
      candidates.push({ lineIndex: i, score, startChar, endChar });
    }
  }

  candidates.sort((a, b) => b.score - a.score);

  const best = candidates[0];
  const second = candidates[1];

  if (best !== undefined && best.score >= fuzzyThreshold) {
    const isAmbiguous =
      second !== undefined
      && second.score >= fuzzyThreshold
      && best.score - second.score < fuzzyMargin;

    if (isAmbiguous) {
      return {
        ok: false,
        rejection: buildRejection({
          operationIndex,
          code: 'ambiguous_anchor',
          message:
            'Fuzzy matching found multiple candidates above the similarity threshold; cannot resolve unambiguously.',
          operation,
          content,
          lineOffsets,
          numLines,
          candidateStart: best.startChar,
          candidateEnd: best.endChar,
          contextLines,
          maxExcerptChars,
          hint: 'Add more surrounding context (anchorBefore / anchorAfter) or set expectedOccurrences to select the intended occurrence.',
          normalizedOldText: oldNormLines.join('\n'),
        }),
      };
    }

    if (anchorBefore !== undefined || anchorAfter !== undefined) {
      const matchRange: CharRange = { start: best.startChar, end: best.endChar };
      if (scoreAnchorAgreement(content, matchRange, anchorBefore, anchorAfter) === 0) {
        return {
          ok: false,
          rejection: buildRejection({
            operationIndex,
            code: 'anchor_mismatch',
            message: 'Fuzzy match found but surroundings do not agree with the supplied anchor.',
            operation,
            content,
            lineOffsets,
            numLines,
            candidateStart: best.startChar,
            candidateEnd: best.endChar,
            contextLines,
            maxExcerptChars,
            hint: 'Update anchorBefore / anchorAfter to match the surrounding content in the live file.',
            normalizedOldText: oldNormLines.join('\n'),
          }),
        };
      }
    }

    return {
      ok: true,
      location: {
        strategy: 'fuzzy',
        startIndex: best.startChar,
        endIndex: best.endChar,
        startLine: best.lineIndex + 1,
        endLine: best.lineIndex + windowSize,
      },
    };
  }

  if (best !== undefined && best.score > 0) {
    return {
      ok: false,
      rejection: buildRejection({
        operationIndex,
        code: 'fuzzy_below_threshold',
        message: `Best fuzzy match score ${best.score.toFixed(2)} is below the required threshold ${fuzzyThreshold.toFixed(2)}.`,
        operation,
        content,
        lineOffsets,
        numLines,
        candidateStart: best.startChar,
        candidateEnd: best.endChar,
        contextLines,
        maxExcerptChars,
        hint: 'oldText has drifted from the live file; re-read the current content via read_file and re-emit the patch.',
        normalizedOldText: oldNormLines.join('\n'),
      }),
    };
  }

  return {
    ok: false,
    rejection: buildRejection({
      operationIndex,
      code: 'old_text_not_found',
      message: 'oldText was not found in the live file (no verbatim or fuzzy match).',
      operation,
      content,
      lineOffsets,
      numLines,
      candidateStart: undefined,
      candidateEnd: undefined,
      contextLines,
      maxExcerptChars,
      hint: 'Verify oldText against the current file content via read_file; the text may have been modified or removed.',
    }),
  };
}

// ─── internal helpers ─────────────────────────────────────────────────────────

function findAllOccurrences(content: string, search: string): CharRange[] {
  const result: CharRange[] = [];
  if (search.length === 0) return result;
  let pos = 0;
  while (pos <= content.length - search.length) {
    const idx = content.indexOf(search, pos);
    if (idx === -1) break;
    result.push({ start: idx, end: idx + search.length });
    pos = idx + 1;
  }
  return result;
}

function computeLineOffsets(content: string): number[] {
  const offsets = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') offsets.push(i + 1);
  }
  return offsets;
}

function offsetToLine(lineOffsets: number[], offset: number): number {
  let lo = 0;
  let hi = lineOffsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineOffsets[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1; // 1-based
}

function scoreAnchorAgreement(
  content: string,
  match: CharRange,
  anchorBefore: string | undefined,
  anchorAfter: string | undefined,
): number {
  let score = 0;
  if (anchorBefore !== undefined) {
    const windowSize = Math.max(anchorBefore.length + 100, 200);
    const before = content.slice(Math.max(0, match.start - windowSize), match.start);
    if (before.includes(anchorBefore)) score++;
  }
  if (anchorAfter !== undefined) {
    const windowSize = Math.max(anchorAfter.length + 100, 200);
    const after = content.slice(match.end, Math.min(content.length, match.end + windowSize));
    if (after.includes(anchorAfter)) score++;
  }
  return score;
}

function normalizeLines(text: string, ignoreWs: boolean): string[] {
  return text.split('\n').map((line) => {
    const trimmed = line.trimEnd();
    return ignoreWs ? trimmed.trim().replace(/\s+/g, ' ') : trimmed;
  });
}

function lineArrayDistance(a: string[], b: string[]): number {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => i);
  for (let j = 1; j <= n; j++) {
    let prev = dp[0];
    dp[0] = j;
    for (let i = 1; i <= m; i++) {
      const temp = dp[i];
      dp[i] = a[i - 1] === b[j - 1] ? prev : Math.min(prev, dp[i - 1], dp[i]) + 1;
      prev = temp;
    }
  }
  return dp[m];
}

function similarityRatio(normOldLines: string[], candidateLines: string[]): number {
  const maxLen = Math.max(normOldLines.length, candidateLines.length);
  if (maxLen === 0) return 1;
  return 1 - lineArrayDistance(normOldLines, candidateLines) / maxLen;
}

interface BuildRejectionParams {
  operationIndex: number;
  code: NativePatchRuntimeRejectionCode;
  message: string;
  operation: NativePatchEditOperation;
  content: string;
  lineOffsets: number[];
  numLines: number;
  candidateStart: number | undefined;
  candidateEnd: number | undefined;
  contextLines: number;
  maxExcerptChars: number;
  hint: string;
  normalizedOldText?: string;
}

function buildRejection(params: BuildRejectionParams): NativePatchRuntimeRejection {
  const {
    operationIndex,
    code,
    message,
    operation,
    content,
    lineOffsets,
    numLines,
    candidateStart,
    candidateEnd,
    contextLines,
    maxExcerptChars,
    hint,
    normalizedOldText,
  } = params;

  const liveContext = buildLiveContext(
    operation.path,
    content,
    lineOffsets,
    numLines,
    candidateStart,
    candidateEnd,
    contextLines,
    maxExcerptChars,
  );

  return {
    operationIndex,
    code,
    message,
    requestedContext: {
      oldText: operation.oldText,
      ...(operation.anchorBefore !== undefined ? { anchorBefore: operation.anchorBefore } : {}),
      ...(operation.anchorAfter !== undefined ? { anchorAfter: operation.anchorAfter } : {}),
      ...(normalizedOldText !== undefined ? { normalizedOldText } : {}),
    },
    liveContext,
    hint,
  };
}

function buildLiveContext(
  path: string,
  content: string,
  lineOffsets: number[],
  numLines: number,
  candidateStart: number | undefined,
  candidateEnd: number | undefined,
  contextLines: number,
  maxExcerptChars: number,
): NativePatchRuntimeRejectionContext {
  if (content.length === 0) {
    return { path, excerpt: '', startLine: 1, endLine: 1 };
  }

  const centerStartLine =
    candidateStart !== undefined ? offsetToLine(lineOffsets, candidateStart) : 1;
  const centerEndLine =
    candidateEnd !== undefined
      ? offsetToLine(lineOffsets, Math.max(candidateStart ?? 0, candidateEnd - 1))
      : centerStartLine;

  const firstLine = Math.max(1, centerStartLine - contextLines);
  const lastLine = Math.min(numLines, centerEndLine + contextLines);

  const startChar = lineOffsets[firstLine - 1];
  const endChar =
    lastLine < lineOffsets.length ? lineOffsets[lastLine] : content.length;

  let excerpt = content.slice(startChar, endChar);
  if (excerpt.length > maxExcerptChars) {
    excerpt = excerpt.slice(0, maxExcerptChars - 1) + '…';
  }

  return { path, excerpt, startLine: firstLine, endLine: lastLine };
}
