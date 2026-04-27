export type RiskLevel = 'low' | 'medium' | 'high';

export interface PrMetadata {
  task?: string;
  stack?: string;
  depends_on?: string[];
  depends_on_linear?: string[];
  requires?: string[];
  risk?: RiskLevel;
  challenge?: boolean;
}

export interface PrMetadataError {
  field: string;
  message: string;
  rawValue?: string;
}

export type ParseResult =
  | { ok: true; metadata: PrMetadata; bodyWithoutBlock: string }
  | { ok: false; errors: PrMetadataError[]; bodyWithoutBlock: string };

const BLOCK_REGEX = /<!-- wavemill-meta\n([\s\S]*?)\n-->/g;
const LINE_REGEX = /^([a-z_]+):\s*(.*)$/;
const ARRAY_FIELDS = new Set<keyof PrMetadata>(['depends_on', 'depends_on_linear', 'requires']);
const STRING_FIELDS = new Set<keyof PrMetadata>(['task', 'stack']);
const FIELD_ORDER: Array<keyof PrMetadata> = [
  'task',
  'stack',
  'depends_on',
  'depends_on_linear',
  'requires',
  'risk',
  'challenge',
];

function trimBlockAdjacentWhitespace(body: string): string {
  return body
    .replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, '\n\n')
    .replace(/^\s*\n/, '')
    .replace(/\n\s*$/, '');
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
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
  const { block, bodyWithoutBlock } = extractMetadataBlock(body);

  if (block === null) {
    return { ok: true, metadata: {}, bodyWithoutBlock };
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
        field: line,
        message: `Malformed wavemill-meta line: ${line}`,
        rawValue: line,
      });
      continue;
    }

    const [, field, rawValue] = match;
    if (!FIELD_ORDER.includes(field as keyof PrMetadata)) {
      errors.push({
        field,
        message: `Unknown wavemill-meta field: ${field}`,
        rawValue,
      });
      continue;
    }

    if (STRING_FIELDS.has(field as keyof PrMetadata)) {
      if (!rawValue.trim()) {
        errors.push({
          field,
          message: `Expected non-empty string for ${field}`,
          rawValue,
        });
        continue;
      }

      metadata[field as 'task' | 'stack'] = rawValue.trim();
      continue;
    }

    if (ARRAY_FIELDS.has(field as keyof PrMetadata)) {
      try {
        const parsed = JSON.parse(rawValue) as unknown;
        if (!isStringArray(parsed)) {
          errors.push({
            field,
            message: `Expected JSON string array for ${field}`,
            rawValue,
          });
          continue;
        }

        metadata[field as 'depends_on' | 'depends_on_linear' | 'requires'] = parsed;
      } catch {
        errors.push({
          field,
          message: `Invalid JSON for ${field}`,
          rawValue,
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
          message: `Expected one of low, medium, high for ${field}`,
          rawValue,
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
          message: `Expected boolean true/false for ${field}`,
          rawValue,
        });
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors, bodyWithoutBlock };
  }

  return { ok: true, metadata, bodyWithoutBlock };
}

export function renderPrMetadata(meta: PrMetadata): string {
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
  const { bodyWithoutBlock } = extractMetadataBlock(body);
  const rendered = renderPrMetadata(meta);

  if (!bodyWithoutBlock.trim()) {
    return rendered;
  }

  return `${bodyWithoutBlock.trimEnd()}\n\n${rendered}`;
}
