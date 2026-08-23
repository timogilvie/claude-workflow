import type { ModelFamily } from './openrouter-catalog.ts';

export interface FamilyCapabilities {
  supportsTools: boolean;
  supportsStreaming: boolean;
  supportsTemperature: boolean;
  temperatureRange?: [number, number];
}

const DEFAULT_CAPABILITIES: FamilyCapabilities = {
  supportsTools: true,
  supportsStreaming: true,
  supportsTemperature: true,
  temperatureRange: [0, 2],
};

const FAMILY_CAPABILITIES: Record<ModelFamily, FamilyCapabilities> = {
  claude: DEFAULT_CAPABILITIES,
  gpt: DEFAULT_CAPABILITIES,
  deepseek: DEFAULT_CAPABILITIES,
  glm: DEFAULT_CAPABILITIES,
  qwen: DEFAULT_CAPABILITIES,
  kimi: DEFAULT_CAPABILITIES,
  gemini: DEFAULT_CAPABILITIES,
  llama: DEFAULT_CAPABILITIES,
  mistral: DEFAULT_CAPABILITIES,
  grok: DEFAULT_CAPABILITIES,
  unknown: {
    supportsTools: false,
    supportsStreaming: true,
    supportsTemperature: false,
  },
};

export function getFamilyCapabilities(family: ModelFamily): FamilyCapabilities {
  const capabilities = FAMILY_CAPABILITIES[family];
  return {
    ...capabilities,
    temperatureRange: capabilities.temperatureRange
      ? [...capabilities.temperatureRange] as [number, number]
      : undefined,
  };
}
