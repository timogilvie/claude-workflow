export type {
  CertificationPhase,
  NativeCertificationArtifact,
  ScenarioResult,
} from './schema.ts';

export {
  CERTIFICATION_BASE_PATH,
  CERTIFICATION_SCHEMA_VERSION,
  CERTIFICATION_TTL_DAYS,
  PHASE_ORDER,
  allScenariosPassed,
  isCertificationFresh,
  phaseSatisfies,
} from './schema.ts';

export type { CertificationEligibility, IneligibilityReason } from './loader.ts';

export {
  buildCertificationPath,
  checkCertificationEligibility,
  evaluateEligibility,
  isValidPathSegment,
  loadCertification,
  parseCertificationPath,
} from './loader.ts';
