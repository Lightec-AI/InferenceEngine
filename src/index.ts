export * from "./protocol/types.js";
export * from "./prefill.js";
export * from "./attestation.js";
export { buildMockCpuQuote } from "./attestation.js";
export {
  parseAttestationPolicyJson,
  loadAttestationPolicyFromFile,
  type AttestationPolicyFileJson,
} from "./attestation-policy-file.js";
export {
  createFixtureProductionQuoteBackend,
  FIXTURE_INTEL_TDX_QUOTE_PLACEHOLDER,
} from "./attestation-fixture-backend.js";
export { createSevSnpProductionQuoteBackend } from "./attestation-sev-snp-backend.js";
export {
  createNvCcProductionGpuEvidenceBackend,
} from "./attestation-gpu-backend.js";
export {
  clearProductionGpuEvidenceBackend,
  createFixtureProductionGpuEvidenceBackend,
  isProductionGpuEvidenceBackendRegistered,
  registerProductionGpuEvidenceBackend,
  resolveGpuEvidenceVerifier,
  type GpuAttestationPolicy,
  type GpuEvidenceVerifier,
} from "./gpu-attestation.js";
export {
  buildGpuNotApplicableEvidence,
  buildMockNvCcGpuEvidenceEnvelope,
  decodeNvCcGpuEvidenceEnvelope,
  encodeNvCcGpuEvidenceEnvelope,
  isLegacyMockGpuEvidence,
} from "./nv-cc/index.js";
export {
  collectNvCcGpuEvidence,
  collectNvCcGpuEvidenceB64,
} from "./nv-cc/collect.js";
export {
  validateNvGpuClaimsAgainstPolicy,
  verifyNvCcGpuEvidence,
  verifyMockNvCcGpuEvidence,
} from "./nv-cc/verify.js";
export {
  bindReportData64,
  buildSevSnpAttestationBundle,
  buildSevSnpAttestedConnectRequest,
  encodeSevSnpQuoteWrapper,
  generateSevSnpEngineKeys,
  isSevSnpGuestDeviceAvailable,
  isSevSnpGuestToolAvailable,
  parseSevSnpQuoteWrapper,
  requestSevSnpAttestationReport,
  resolveBinaryMeasurementsFromEnv,
  shouldUseSevSnpAttestation,
  verifySevSnpAttestationReport,
  verifyWrapperReportData,
} from "./sev-snp/index.js";
export * from "./ephemeral.js";
export * from "./metering.js";
export * from "./client-trust.js";
export * from "./build-mode.js";
export * from "./crypto/provider.js";
export * from "./engine/epoch.js";
export * from "./engine/supervisor.js";
export * from "./engine/epoch-rotation-policy.js";
export * from "./engine/epoch-rotator.js";
export * from "./engine/rotating-decryptor.js";
export * from "./engine/decrypt-handle.js";
export * from "./engine/supervised-pool.js";
export * from "./client/ope-client.js";
export * from "./client/gateway-mtls.js";
export * from "./engine-plane/pool-client.js";
export { configureEventLogFromEnv, setEventLogLevel, setEventLogSink } from "./ops/event-log.js";
export {
  logEngineEphemeralRegisterFailed,
  logEnginePoolConnect,
  logEngineEpochRotateSuccess,
  logEngineEpochRotateFailed,
  logEngineSessionReconnect,
  logEngineShutdown,
  logEngineVllmUpstreamError,
  logEngineWorkAssigned,
} from "./ops/engine-events.js";
export { resetMockInferenceKvState } from "./engine-plane/inference-handler.js";
export type { MockInferenceOptions } from "./engine-plane/inference-handler.js";
export {
  loadOpeFfi,
  requireOpeFfi,
  candidateLibraryPaths,
  OpeFfiError,
  type OpeFfi,
  type EngineIdentityFull,
} from "./native/ope-ffi.js";
export {
  createWasmClientCryptoProvider,
  type WasmOpeClientFfi,
} from "./crypto/wasm-client-provider.js";
export {
  DEV_VECTOR_001_PUBLIC_KEY_HEX,
  DEV_VECTOR_001_SECRET_SEED,
  devVector001PublicKey,
  signEnvelopeWithSecretKey,
  verifyGatewayOpaqueEnvelope,
} from "./native/envelope-ffi.js";
export {
  createMockInferenceServer,
  type MockInferenceDecryptor,
} from "./server/mock-inference.js";
export { runOpeInferenceOnEnvelope, resetOpeInferenceKvState } from "./server/ope-inference.js";
export {
  validateOpeInferenceEnvelope,
  validateOpeInferenceContentType,
} from "./server/ope-inference-gate.js";
export {
  clampVllmMaxTokens,
  completeVllmChatCompletion,
  maxTokensFromEnv,
  openAiChatCompletionsUrl,
  resolveVllmBaseUrlForModel,
  streamVllmChatCompletion,
  taskModelIdFromEnv,
  vllmTaskConfigFromEnv,
  VLLM_MAX_TOKENS_DEFAULT,
  vllmConfigFromEnv,
} from "./upstream/vllm-chat.js";
export {
  DEFAULT_OLLAMA_OPENAI_BASE_URL,
  pickUpstreamModel,
  probeOllamaUpstream,
  resolveOpenAiCompatibleUpstream,
  type OpenAiCompatibleUpstreamProbe,
} from "./upstream/openai-compatible-upstream.js";
export {
  GATEWAY_PLANE_TASK_ENC,
  isGatewayPlaneTaskEnvelope,
  runGatewayPlaneTaskInference,
  validateGatewayPlaneTaskEnvelope,
} from "./server/gateway-plane-task-inference.js";
