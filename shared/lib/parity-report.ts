import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildModelCertificationReport,
  type ModelCertificationReportRow,
} from './native-agent/certification/report.ts';
import { resolveCertificationStorage } from './native-agent/certification/storage.ts';
import { explainEffectiveModelAvailability } from './effective-models.ts';
import type { SupportedModelStage } from './model-registry.ts';
import { loadWavemillConfig } from './config.ts';
import {
  REMOVED_MODEL_SETTING_PATHS,
  scanForbiddenModelSettings,
  type RemovedModelSettingInventoryItem,
} from './model-settings-migrator.ts';

export interface ProviderRuntimeReadiness {
  provider: string;
  ready: number;
  total: number;
  apiKeyEnv?: string;
  apiKeySet: boolean;
  blockers: Record<string, number>;
}

export interface StageAvailability {
  stage: SupportedModelStage;
  certifiedCount: number;
  runtimeReadyCount: number;
  challengePairAvailable: boolean;
  models: string[];
}

export interface GlobalModelParityReport {
  schemaVersion: 1;
  generatedAt: string;
  repoDir: string;
  globalRoot: string;
  globalCatalogVersion?: string;
  certifiedModelCountByStage: Record<SupportedModelStage, number>;
  runtimeReadyCountByStage: Record<SupportedModelStage, number>;
  stages: StageAvailability[];
  runtimeReadyByProvider: ProviderRuntimeReadiness[];
  challengePairAvailability: Record<SupportedModelStage, boolean>;
  forbiddenLocalConfig: RemovedModelSettingInventoryItem[];
  forbiddenPathCatalog: readonly string[];
}

const STAGES: SupportedModelStage[] = ['planning', 'coding', 'review'];
const STAGE_TO_REPORT_ROLE: Record<SupportedModelStage, 'planner' | 'coder' | 'reviewer'> = {
  expansion: 'reviewer',
  planning: 'planner',
  coding: 'coder',
  review: 'reviewer',
};

function readDotEnv(repoDir: string): Record<string, string> {
  const path = join(repoDir, '.env');
  if (!existsSync(path)) return {};
  const entries: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf-8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const [key, ...rest] = trimmed.split('=');
    entries[key.trim()] = rest.join('=').trim().replace(/^['"]|['"]$/g, '');
  }
  return entries;
}

function providerApiKeyEnv(repoDir: string, provider: string): string | undefined {
  try {
    const config = loadWavemillConfig(repoDir);
    const providerConfig = (config.providers as Record<string, { apiKeyEnv?: string } | undefined> | undefined)?.[provider];
    return providerConfig?.apiKeyEnv;
  } catch {
    const raw = readJsonConfig(repoDir);
    const providers = raw?.providers;
    if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return undefined;
    const providerConfig = (providers as Record<string, unknown>)[provider];
    if (!providerConfig || typeof providerConfig !== 'object' || Array.isArray(providerConfig)) return undefined;
    const apiKeyEnv = (providerConfig as Record<string, unknown>).apiKeyEnv;
    return typeof apiKeyEnv === 'string' ? apiKeyEnv : undefined;
  }
}

function readJsonConfig(repoDir: string): Record<string, unknown> | undefined {
  const path = join(repoDir, '.wavemill-config.json');
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function apiKeyIsSet(repoDir: string, envName?: string): boolean {
  if (!envName) return true;
  const dotenv = readDotEnv(repoDir);
  return Boolean(process.env[envName] || dotenv[envName]);
}

function catalogVersion(rows: ModelCertificationReportRow[]): string | undefined {
  const versions = [...new Set(rows.map((row) => row.suiteVersion).filter((value): value is string => Boolean(value)))].sort();
  if (versions.length === 0) return undefined;
  return versions.length === 1 ? versions[0] : versions.join(',');
}

export function buildGlobalModelParityReport(opts: {
  repoDir?: string;
  now?: Date;
  certificationRoot?: string;
} = {}): GlobalModelParityReport {
  const repoDir = opts.repoDir ?? process.cwd();
  const now = opts.now ?? new Date();
  const forbiddenLocalConfig = scanForbiddenModelSettings(repoDir);
  const effectiveRepoDir = forbiddenLocalConfig.length > 0 ? process.cwd() : repoDir;
  const rows = buildModelCertificationReport({
    repoDir: effectiveRepoDir,
    now,
    certificationRoot: opts.certificationRoot,
  });
  const certifiedModelCountByStage = {} as Record<SupportedModelStage, number>;
  const runtimeReadyCountByStage = {} as Record<SupportedModelStage, number>;
  const challengePairAvailability = {} as Record<SupportedModelStage, boolean>;
  const stages: StageAvailability[] = [];

  for (const stage of STAGES) {
    const reportRole = STAGE_TO_REPORT_ROLE[stage];
    const certifiedRows = rows.filter((row) => row.eligibleStages.includes(reportRole));
    const readyModels = certifiedRows
      .filter((row) => explainEffectiveModelAvailability(row.model, stage, {
        repoDir: effectiveRepoDir,
        now,
        requireRuntimeReady: true,
        apiKeyPresent: apiKeyIsSet(repoDir, providerApiKeyEnv(repoDir, row.provider)),
        apiKeyEnv: providerApiKeyEnv(repoDir, row.provider),
        certificationRoot: opts.certificationRoot,
      }).available)
      .map((row) => row.model)
      .sort();
    certifiedModelCountByStage[stage] = certifiedRows.length;
    runtimeReadyCountByStage[stage] = readyModels.length;
    challengePairAvailability[stage] = readyModels.length >= 2;
    stages.push({
      stage,
      certifiedCount: certifiedRows.length,
      runtimeReadyCount: readyModels.length,
      challengePairAvailable: readyModels.length >= 2,
      models: readyModels,
    });
  }

  const byProvider = new Map<string, ModelCertificationReportRow[]>();
  for (const row of rows) {
    byProvider.set(row.provider, [...(byProvider.get(row.provider) ?? []), row]);
  }
  const runtimeReadyByProvider = [...byProvider.entries()].map(([provider, providerRows]) => {
    const apiKeyEnv = providerApiKeyEnv(repoDir, provider);
    const apiKeySet = apiKeyIsSet(repoDir, apiKeyEnv);
    const blockers: Record<string, number> = {};
    let ready = 0;
    for (const row of providerRows) {
      const availability = explainEffectiveModelAvailability(row.model, 'coding', {
        repoDir: effectiveRepoDir,
        now,
        requireRuntimeReady: true,
        apiKeyPresent: apiKeySet,
        apiKeyEnv,
        certificationRoot: opts.certificationRoot,
      });
      if (availability.available) {
        ready += 1;
      } else {
        const reason = availability.nativeGate && !availability.nativeGate.ok
          ? availability.nativeGate.reason
          : availability.reason;
        blockers[reason] = (blockers[reason] ?? 0) + 1;
      }
    }
    return {
      provider,
      ready,
      total: providerRows.length,
      ...(apiKeyEnv ? { apiKeyEnv } : {}),
      apiKeySet,
      blockers,
    };
  }).sort((a, b) => a.provider.localeCompare(b.provider));

  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    repoDir,
    globalRoot: resolveCertificationStorage({ scope: 'global', root: opts.certificationRoot }).root,
    ...(catalogVersion(rows) ? { globalCatalogVersion: catalogVersion(rows) } : {}),
    certifiedModelCountByStage,
    runtimeReadyCountByStage,
    stages,
    runtimeReadyByProvider,
    challengePairAvailability,
    forbiddenLocalConfig,
    forbiddenPathCatalog: REMOVED_MODEL_SETTING_PATHS,
  };
}

export function renderGlobalModelParityReport(report: GlobalModelParityReport): string {
  const lines = [
    'Global Model Report',
    '===================',
    `Catalog version: ${report.globalCatalogVersion ?? 'unknown'} (global root ${report.globalRoot})`,
    '',
    'Certified models by stage:',
  ];
  for (const stage of STAGES) {
    lines.push(`  ${stage}: ${report.certifiedModelCountByStage[stage] ?? 0}`);
  }
  lines.push('', 'Runtime-ready by provider:');
  for (const provider of report.runtimeReadyByProvider) {
    const blockerSummary = Object.entries(provider.blockers)
      .map(([reason, count]) => `${reason}=${count}`)
      .join(', ');
    lines.push(
      `  ${provider.provider}: ${provider.ready}/${provider.total} ready`
      + (provider.apiKeyEnv ? ` key: ${provider.apiKeyEnv} (${provider.apiKeySet ? 'set' : 'missing'})` : '')
      + (blockerSummary ? ` blockers: ${blockerSummary}` : ''),
    );
  }
  lines.push('', 'Challenge pair availability:');
  for (const stage of STAGES) {
    const stageRow = report.stages.find((entry) => entry.stage === stage);
    lines.push(`  ${stage}: ${report.challengePairAvailability[stage] ? 'available' : 'unavailable'} (${stageRow?.runtimeReadyCount ?? 0} candidates, min 2)`);
  }
  lines.push('', 'Forbidden local configuration:');
  if (report.forbiddenLocalConfig.length === 0) {
    lines.push('  none');
  } else {
    for (const item of report.forbiddenLocalConfig) {
      lines.push(`  ${item.file}: ${item.path}`);
    }
  }
  lines.push('', 'Consumer config validation:');
  lines.push(report.forbiddenLocalConfig.length === 0
    ? '  clean (no removed HOK-2587 fields present)'
    : '  blocked (removed HOK-2587 fields present)');
  return `${lines.join('\n')}\n`;
}
