/**
 * Compact, pane-friendly rendering of an observer snapshot.
 *
 * The observer's backstage pane previously received raw `--json`, which is
 * unreadable in a small pane: a single finding wraps past the visible area and
 * the high-signal findings are buried under the log-scrape tier.
 *
 * This renderer prints one line per actionable finding and rolls the
 * log-scrape tier (`log-error-*` / `log-warning-*`) into a single counted
 * line, so what stays on screen is what an operator can act on.
 */

export type ObserverSeverity = 'urgent' | 'high' | 'medium' | 'low';

export interface RenderableFinding {
  id: string;
  severity: ObserverSeverity;
  category?: string;
  confidence?: string;
  issue?: string;
  title: string;
  recommendation?: string;
  evidence?: string[];
  occurrenceCount?: number;
}

export interface RenderableIncident {
  lifecycle?: string;
  category?: string;
  rootCauseClass?: string;
  summary?: string;
  operatorAction?: string;
}

export interface RenderableSnapshot {
  timestamp?: string;
  findings?: RenderableFinding[];
  incidents?: RenderableIncident[];
}

export interface ObserverRenderOptions {
  /** Maximum actionable findings to list. Default 12. */
  maxFindings?: number;
  /** Include the log-scrape tier as individual lines instead of one rolled-up line. Default false. */
  includeNoise?: boolean;
  /** Column budget for truncation. Default 100. */
  width?: number;
}

const SEVERITY_ORDER: Record<ObserverSeverity, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
const SEVERITY_MARK: Record<ObserverSeverity, string> = { urgent: '!!', high: ' !', medium: ' ·', low: ' ·' };

/**
 * True for findings that merely echo a mill log line. These are the highest-volume
 * and lowest-signal category, so the pane rolls them up rather than listing them.
 */
export function isLogNoiseFinding(id: string): boolean {
  return /^log-(error|warning)-/.test(id);
}

/** Strip a leading `HH:MM:SS` (and optional level tag) so repeated messages collapse. */
function canonicalizeEvidence(line: string): string {
  return line.replace(/^\d{2}:\d{2}:\d{2}\s+/, '').trim();
}

function truncate(value: string, width: number): string {
  if (width <= 1 || value.length <= width) return value;
  return `${value.slice(0, Math.max(1, width - 1))}…`;
}

function shortTimestamp(timestamp?: string): string {
  if (!timestamp) return '';
  const match = /T(\d{2}:\d{2}:\d{2})/.exec(timestamp);
  return match ? match[1] : timestamp;
}

/**
 * Count how many distinct underlying messages a set of noise findings represents.
 * 15 findings covering 8 distinct warnings is far less alarming than 15 distinct
 * ones, and the difference is what an operator needs in order to ignore them.
 */
export function countDistinctNoise(findings: RenderableFinding[]): number {
  const seen = new Set<string>();
  for (const finding of findings) {
    const first = finding.evidence?.[0];
    seen.add(first ? canonicalizeEvidence(first) : finding.title);
  }
  return seen.size;
}

export function renderObserverStatus(
  snapshot: RenderableSnapshot,
  options: ObserverRenderOptions = {},
): string {
  const width = options.width ?? 100;
  const maxFindings = options.maxFindings ?? 12;
  const includeNoise = options.includeNoise ?? false;
  const findings = snapshot.findings ?? [];

  const counts: Record<ObserverSeverity, number> = { urgent: 0, high: 0, medium: 0, low: 0 };
  for (const finding of findings) {
    if (finding.severity in counts) counts[finding.severity] += 1;
  }

  const noise = includeNoise ? [] : findings.filter((finding) => isLogNoiseFinding(finding.id));
  const actionable = includeNoise ? [...findings] : findings.filter((finding) => !isLogNoiseFinding(finding.id));
  actionable.sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9));

  const stamp = shortTimestamp(snapshot.timestamp);
  const lines: string[] = [
    truncate(
      `Wavemill Observer ${stamp}  urgent=${counts.urgent} high=${counts.high} medium=${counts.medium} low=${counts.low}`,
      width,
    ),
  ];

  if (actionable.length === 0) {
    lines.push('  no actionable findings');
  }

  for (const finding of actionable.slice(0, maxFindings)) {
    const mark = SEVERITY_MARK[finding.severity] ?? ' ·';
    const scope = finding.issue ? `${finding.issue} ` : '';
    const repeat = finding.occurrenceCount && finding.occurrenceCount > 1 ? ` (x${finding.occurrenceCount})` : '';
    lines.push(truncate(`${mark} ${scope}${finding.title}${repeat}`, width));
    // Only the actionable tiers earn a second line; medium/low stay one-per-line.
    if ((finding.severity === 'urgent' || finding.severity === 'high') && finding.recommendation) {
      lines.push(truncate(`     → ${finding.recommendation}`, width));
    }
  }

  if (actionable.length > maxFindings) {
    lines.push(`  ... ${actionable.length - maxFindings} more finding(s)`);
  }

  if (noise.length > 0) {
    const distinct = countDistinctNoise(noise);
    lines.push(
      truncate(
        `  log noise: ${noise.length} finding(s), ${distinct} distinct — hidden (observer --once --json to inspect)`,
        width,
      ),
    );
  }

  const incidents = snapshot.incidents ?? [];
  if (incidents.length > 0) {
    lines.push(truncate(`  incidents: ${incidents.length}`, width));
    for (const incident of incidents.slice(0, 3)) {
      const label = [incident.rootCauseClass, incident.summary].filter(Boolean).join(': ');
      lines.push(truncate(`   - ${label}`, width));
    }
  }

  return `${lines.join('\n')}\n`;
}
