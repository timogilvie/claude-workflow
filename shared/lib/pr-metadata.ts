export type RiskLevel = 'low' | 'medium' | 'high';

export interface PrMetadata {
  task?: string;
  stack?: string;
  depends_on?: string[];
  depends_on_linear?: string[];
  requires?: string[];
  risk?: RiskLevel;
  challenge?: boolean;
  challengePairId?: string;
}

export interface PrMetadataError {
  field: string;
  code:
    | 'malformed-line'
    | 'unknown-field'
    | 'empty-string'
    | 'invalid-json'
    | 'wrong-type'
    | 'invalid-enum'
    | 'invalid-boolean';
  message: string;
}

export type ParseResult =
  | { ok: true; metadata: PrMetadata; bodyWithoutBlock: string }
  | { ok: false; errors: PrMetadataError[]; bodyWithoutBlock: string };

export type PrMetadataValidationResult =
  | { status: 'absent'; bodyWithoutBlock: string }
  | { status: 'valid'; metadata: PrMetadata; bodyWithoutBlock: string }
  | { status: 'invalid'; errors: PrMetadataError[]; bodyWithoutBlock: string };

const BLOCK_REGEX = /<!-- wavemill-meta\n([\s\S]*?)\n-->/g;
const LINE_REGEX = /^([a-zA-Z][a-zA-Z0-9_-]*):\s*(.*)$/;
const MAX_DIAGNOSTIC_FIELD_LENGTH = 80;
const ARRAY_FIELDS = new Set<keyof PrMetadata>(['depends_on', 'depends_on_linear', 'requires']);
const STRING_FIELDS = new Set<keyof PrMetadata>(['task', 'stack', 'challengePairId']);
const FIELD_ORDER: Array<keyof PrMetadata> = [
  'task',
  'stack',
  'depends_on',
  'depends_on_linear',
  'requires',
  'risk',
  'challenge',
  'challengePairId',
];
const REGISTERED_FIELDS = new Set<string>(FIELD_ORDER);

function trimBlockAdjacentWhitespace(body: string): string {
  return body
    .replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, '\n\n')
    .replace(/^\s*\n/, '')
    .replace(/\n\s*$/, '');
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function diagnosticField(field: string): string {
  const trimmed = field.trim();
  if (!trimmed) {
    return 'metadata';
  }
  return trimmed.length <= MAX_DIAGNOSTIC_FIELD_LENGTH
    ? trimmed
    : `${trimmed.slice(0, MAX_DIAGNOSTIC_FIELD_LENGTH)}...`;
}

export function extractMetadataBlock(body: string): { block: string | null; bodyWithoutBlock: string } {
  let block: string | null = null;
  let bodyWithoutBlock = body;

  for (const match of body.matchAll(BLOCK_REGEX)) {
    block = match[1] ?? '';
  }

  if (block === null) {
    return { block: null, bodyWithoutBlock: body };
  }

  bodyWithoutBlock = trimBlockAdjacentWhitespace(bodyWithoutBlock.replace(BLOCK_REGEX, ''));
  return { block, bodyWithoutBlock };
}

export function parsePrMetadata(body: string): ParseResult {
  const validated = validatePrMetadata(body);
  if (validated.status === 'invalid') {
    return {
      ok: false,
      errors: validated.errors,
      bodyWithoutBlock: validated.bodyWithoutBlock,
    };
  }

  return {
    ok: true,
    metadata: validated.status === 'valid' ? validated.metadata : {},
    bodyWithoutBlock: validated.bodyWithoutBlock,
  };
}

export function validatePrMetadata(body: string): PrMetadataValidationResult {
  const { block, bodyWithoutBlock } = extractMetadataBlock(body);

  if (block === null) {
    return { status: 'absent', bodyWithoutBlock };
  }

  const metadata: PrMetadata = {};
  const errors: PrMetadataError[] = [];

  for (const line of block.split('\n')) {
    if (!line.trim()) {
      continue;
    }

    const match = line.match(LINE_REGEX);
    if (!match) {
      errors.push({
        field: 'line',
        code: 'malformed-line',
        message: 'Malformed wavemill-meta line',
      });
      continue;
    }

    const [, field, rawValue] = match;
    if (!REGISTERED_FIELDS.has(field)) {
      const boundedField = diagnosticField(field);
      errors.push({
        field: boundedField,
        code: 'unknown-field',
        message: `Unknown wavemill-meta field: ${boundedField}`,
      });
      continue;
    }

    if (STRING_FIELDS.has(field as keyof PrMetadata)) {
      if (!rawValue.trim()) {
        errors.push({
          field,
          code: 'empty-string',
          message: `Expected non-empty string for ${field}`,
        });
        continue;
      }

      metadata[field as 'task' | 'stack' | 'challengePairId'] = rawValue.trim();
      continue;
    }

    if (ARRAY_FIELDS.has(field as keyof PrMetadata)) {
      try {
        const parsed = JSON.parse(rawValue) as unknown;
        if (!isStringArray(parsed)) {
          errors.push({
            field,
            code: 'wrong-type',
            message: `Expected JSON string array for ${field}`,
          });
          continue;
        }

        metadata[field as 'depends_on' | 'depends_on_linear' | 'requires'] = parsed;
      } catch {
        errors.push({
          field,
          code: 'invalid-json',
          message: `Invalid JSON for ${field}`,
        });
      }
      continue;
    }

    if (field === 'risk') {
      if (rawValue === 'low' || rawValue === 'medium' || rawValue === 'high') {
        metadata.risk = rawValue;
      } else {
        errors.push({
          field,
          code: 'invalid-enum',
          message: `Expected one of low, medium, high for ${field}`,
        });
      }
      continue;
    }

    if (field === 'challenge') {
      if (rawValue === 'true' || rawValue === 'false') {
        metadata.challenge = rawValue === 'true';
      } else {
        errors.push({
          field,
          code: 'invalid-boolean',
          message: `Expected boolean true/false for ${field}`,
        });
      }
    }
  }

  if (errors.length > 0) {
    return { status: 'invalid', errors, bodyWithoutBlock };
  }

  return { status: 'valid', metadata, bodyWithoutBlock };
}

export function renderPrMetadata(meta: PrMetadata): string {
  assertRegisteredMetadataObject(meta);
  const lines = FIELD_ORDER.flatMap((field) => {
    const value = meta[field];
    if (value === undefined) {
      return [];
    }

    if (Array.isArray(value)) {
      return `${field}: ${JSON.stringify(value)}`;
    }

    if (typeof value === 'boolean') {
      return `${field}: ${value ? 'true' : 'false'}`;
    }

    return `${field}: ${value}`;
  });

  return lines.length > 0
    ? `<!-- wavemill-meta\n${lines.join('\n')}\n-->`
    : '<!-- wavemill-meta\n\n-->';
}

export function updatePrMetadata(body: string, meta: PrMetadata): string {
  const rendered = renderPrMetadata(meta);
  const matches = [...body.matchAll(BLOCK_REGEX)];

  if (matches.length > 0) {
    let updated = '';
    let cursor = 0;

    for (let index = 0; index < matches.length; index += 1) {
      const match = matches[index];
      const start = match.index ?? 0;
      const full = match[0];
      updated += body.slice(cursor, start);
      if (index === matches.length - 1) {
        updated += rendered;
      }
      cursor = start + full.length;
    }

    return updated + body.slice(cursor);
  }

  if (!body.trim()) {
    return rendered;
  }

  return `${body}\n\n${rendered}`;
}

function assertRegisteredMetadataObject(meta: PrMetadata): void {
  for (const key of Object.keys(meta)) {
    if (!REGISTERED_FIELDS.has(key)) {
      const boundedField = diagnosticField(key);
      throw new Error(`Unknown wavemill-meta field: ${boundedField}`);
    }
  }
}
