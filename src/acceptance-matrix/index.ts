export { loadAcceptanceMatrixConfig, validateAcceptanceMatrixConfig } from './config-loader.js';
export { buildScenarioBlock } from './block-builder.js';
export { classifyScenarioResult } from './classifier.js';
export { buildFakeResponseArrays, buildFakeResponseScenario } from './fake-response-builder.js';
export { runAcceptanceMatrix } from './runner.js';
export { writeAcceptanceMatrixReports } from './report-writer.js';
export type {
  AcceptanceMatrixConfig,
  AcceptanceMatrixProvider,
  AcceptanceMatrixResult,
  AcceptanceScenarioConfig,
  AcceptanceScenarioType,
  FailureClassification,
  FakeResponseArrays,
  FakeResponseScenario,
  FakeResponseStep,
  ScenarioStatus,
  UnsafeResponseMode,
} from './types.js';
