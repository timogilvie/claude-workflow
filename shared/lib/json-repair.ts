interface JsonRepairSuccess<T> {
  ok: true;
  value: T;
  repaired: boolean;
  extractedText: string;
  repairedText: string;
}

interface JsonRepairFailure {
  ok: false;
  errorSummary: string;
  extractedText: string | null;
  repairedText: string | null;
}

export type JsonRepairResult<T> = JsonRepairSuccess<T> | JsonRepairFailure;

function cleanLlmJsonEnvelope(text: string): string {
  let cleaned = text.trim();

  if (cleaned.startsWith('```json')) {
    cleaned = cleaned.replace(/^```json\s*/i, '').replace(/\s*```\s*$/m, '');
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```\s*/, '').replace(/\s*```\s*$/m, '');
  }

  cleaned = cleaned.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '');
  cleaned = cleaned.replace(
    /<\/?(?:tool_name|parameters|prompt|command|subagent_type|pattern|file_path|include|path|output_mode|context)[^>]*>/g,
    ''
  );

  return cleaned.trim();
}

function extractJsonObjectCandidate(text: string): string | null {
  const cleaned = cleanLlmJsonEnvelope(text);
  const start = cleaned.indexOf('{');
  if (start < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < cleaned.length; i++) {
    const char = cleaned[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (char === '\\') {
      if (inString) {
        escape = true;
      }
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return cleaned.slice(start, i + 1);
      }
    }
  }

  const end = cleaned.lastIndexOf('}');
  return end > start ? cleaned.slice(start, end + 1) : cleaned.slice(start);
}

function nextNonWhitespace(text: string, start: number): string | null {
  for (let i = start; i < text.length; i++) {
    if (!/\s/.test(text[i])) {
      return text[i];
    }
  }
  return null;
}

function repairJsonCandidate(candidate: string): string {
  let repaired = '';
  let inString = false;
  let escape = false;

  for (let i = 0; i < candidate.length; i++) {
    const char = candidate[i];

    if (inString) {
      if (escape) {
        repaired += char;
        escape = false;
        continue;
      }

      if (char === '\\') {
        repaired += char;
        escape = true;
        continue;
      }

      if (char === '"') {
        const next = nextNonWhitespace(candidate, i + 1);
        if (next === ':' || next === ',' || next === '}' || next === ']') {
          repaired += char;
          inString = false;
        } else {
          repaired += '\\"';
        }
        continue;
      }

      if (char === '\n') {
        repaired += '\\n';
        continue;
      }

      if (char === '\r') {
        repaired += '\\r';
        continue;
      }

      if (char === '\t') {
        repaired += '\\t';
        continue;
      }

      if (char < ' ') {
        repaired += `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
        continue;
      }

      repaired += char;
      continue;
    }

    if (char === '"') {
      repaired += char;
      inString = true;
      continue;
    }

    if (char === ',') {
      const next = nextNonWhitespace(candidate, i + 1);
      if (next === '}' || next === ']') {
        continue;
      }
    }

    repaired += char;
  }

  return repaired;
}

function summarizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function parseAndRepairJsonFromLlm<T>(text: string): JsonRepairResult<T> {
  const extractedText = extractJsonObjectCandidate(text);
  if (!extractedText) {
    return {
      ok: false,
      errorSummary: 'No JSON object found in LLM output.',
      extractedText: null,
      repairedText: null,
    };
  }

  try {
    return {
      ok: true,
      value: JSON.parse(extractedText) as T,
      repaired: false,
      extractedText,
      repairedText: extractedText,
    };
  } catch {
    const repairedText = repairJsonCandidate(extractedText);
    try {
      return {
        ok: true,
        value: JSON.parse(repairedText) as T,
        repaired: repairedText !== extractedText,
        extractedText,
        repairedText,
      };
    } catch (error) {
      return {
        ok: false,
        errorSummary: summarizeError(error),
        extractedText,
        repairedText,
      };
    }
  }
}
