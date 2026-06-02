/**
 * Browser / Capacitor-safe exports (no `ope-ffi`, `ope-wasm` loader, or Node attestation verify).
 */

export {
  createWasmClientCryptoProvider,
  WasmClientCryptoProvider,
  type WasmOpeClientFfi,
} from "./crypto/wasm-client-provider.js";
export type { EngineTrustBundle, OpeEnvelope, OpeEnvelopeMeta } from "./protocol/types.js";
export {
  DEFAULT_BROWSER_TEST_ATTESTATION_POLICY,
  verifyEngineTrustBundleBrowser,
  type BrowserAttestationPolicy,
  type BrowserTrustVerifyResult,
} from "./browser-trust.js";
