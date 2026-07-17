import { existsSync } from "node:fs";

import {
  DEFAULT_TEST_ATTESTATION_POLICY,
  type AttestationPolicy,
  type PlatformAttestationPolicy,
} from "../attestation.js";
import { loadAttestationPolicyFromFile } from "../attestation-policy-file.js";
import type { EnginePlanePoolClientOptions } from "../engine-plane/pool-client.js";

/**
 * Engine-side mutual gateway platform verify at attested connect (SEC-029).
 * Reads TeaChat env keys; does not depend on TeaChat regional URL helpers.
 */
export function engineGatewayPlatformVerifyFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): EnginePlanePoolClientOptions["gatewayPlatformVerify"] {
  const raw = (env.TEECHAT_ENGINE_VERIFY_GATEWAY_PLATFORM ?? "1").trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "off" || raw === "no") {
    return undefined;
  }

  const enginePolicy = resolveEnginePolicy(env);
  const gatewayBinarySha256 = (
    env.TEECHAT_GATEWAY_BINARY_SHA256 ??
    "c3d4e5f6789012345678abcdef9012345678abcdef9012345678abcdef901234"
  )
    .trim()
    .toLowerCase();
  const skillHubBinarySha256 = (
    env.TEECHAT_SKILL_HUB_BINARY_SHA256 ?? gatewayBinarySha256
  )
    .trim()
    .toLowerCase();
  const gatewayEd25519Public = (
    env.TEECHAT_GATEWAY_ED25519_PUBLIC ??
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
  ).trim();

  const platformPolicy: PlatformAttestationPolicy = {
    policyId: enginePolicy.policyId,
    allowedGatewayBinarySha256: new Set(
      (env.TEECHAT_ALLOWED_GATEWAY_BINARY_SHA256 ?? gatewayBinarySha256)
        .split(/[,\s]+/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),
    allowedSkillHubBinarySha256: new Set(
      (env.TEECHAT_ALLOWED_SKILL_HUB_BINARY_SHA256 ?? skillHubBinarySha256)
        .split(/[,\s]+/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),
    maxQuoteAgeMs: enginePolicy.maxQuoteAgeMs,
  };

  return {
    enginePolicy,
    platformPolicy,
    gatewayBinarySha256,
    skillHubBinarySha256,
    gatewayEd25519Public,
  };
}

function resolveEnginePolicy(env: NodeJS.ProcessEnv): AttestationPolicy {
  const path = env.TEECHAT_ATTESTATION_POLICY_PATH?.trim();
  if (path && existsSync(path)) {
    try {
      return loadAttestationPolicyFromFile(path);
    } catch {
      // fall through
    }
  }
  return DEFAULT_TEST_ATTESTATION_POLICY;
}
