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

export type { ReadResult, StoreError, StoreErrorCode } from './store.ts';

export {
  listCertifications,
  readCertification,
  serializeCertification,
  writeCertification,
} from './store.ts';

export type {
  CertificationExpectations,
  ValidationError,
  ValidationErrorCode,
  ValidationResult,
} from './validator.ts';

export {
  checkIdentity,
  checkLimitations,
  checkNotExpired,
  checkPhaseSatisfies,
  checkScenarios,
  checkSchemaVersion,
  checkSuiteVersion,
  validateCertification,
} from './validator.ts';

export type {
  ScenarioClassification,
  ScenarioCategory,
  ScenarioContext,
  ScenarioAssertion,
  ScenarioAssertionOutcome,
  FailureClass,
  HarnessUnsupportedReason,
  HarnessNotRunReason,
  CertificationScenario,
} from './scenarios.ts';

export { getDefaultScenarios } from './scenarios.ts';

export type {
  HarnessScenarioStatus,
  HarnessScenarioResult,
  HarnessReport,
  RunScenariosOptions,
} from './scenario-runner.ts';

export {
  runScenarios,
  aggregateReport,
  classifyAttempt,
  toArtifactScenario,
} from './scenario-runner.ts';

export type {
  RouterCertificationRejection,
  RouterCertificationRejectionReason,
  RouterRole,
} from './router-filter.ts';

export { filterNativeModels, STAGE_PHASE_REQUIREMENT } from './router-filter.ts';
