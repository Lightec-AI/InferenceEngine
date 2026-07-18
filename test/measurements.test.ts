import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { resolveBinaryMeasurementsFromEnv } from "../src/sev-snp/measurements.js";

const IE_RUNTIME =
  "a88ef141c677ff01b2624e73fee45b66964965214d673b7ea331c00df12af9c9";
const OPE_FFI =
  "0803b3cb08bd9ce5b01dbfb6d57661a0d29e5b9cf460e38de10ee9d437465623";
const AMT =
  "ca5324d6261218c61fab6a88a913a8370c9c4f4d324e451c99490099ea11128a";
const VLLM = "63060173412591d807fe4e571e30b34414cc9837cb54cfd950a4fcb3548bdac5";

const roots: string[] = [];

afterEach(() => {
  // tmp dirs cleaned by OS; keep list for clarity
  roots.length = 0;
});

function makeRoot(manifest?: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "ie-meas-"));
  roots.push(root);
  if (manifest) {
    writeFileSync(join(root, "RELEASE_MANIFEST.json"), JSON.stringify(manifest), "utf8");
  }
  return root;
}

describe("resolveBinaryMeasurementsFromEnv", () => {
  it("uses ieRuntimeSha256 as engine.binary_sha256 (not opeFfiSha256)", () => {
    const root = makeRoot({
      version: "0.8.1",
      ieRuntimeSha256: IE_RUNTIME,
      opeFfiSha256: OPE_FFI,
      opeVersion: "0.1.0",
      opeGitSha: "ffbee812e32a880bd61ed227271d98465f6bb0cb",
      attestedMtlsSha256: AMT,
      attestedMtlsVersion: "0.1.0",
    });
    const m = resolveBinaryMeasurementsFromEnv(
      { TEECHAT_VLLM_BINARY_SHA256: VLLM } as NodeJS.ProcessEnv,
      root,
    );
    expect(m.engineBinarySha256).toBe(IE_RUNTIME);
    expect(m.engineVersion).toBe("0.8.1");
    expect(m.ope?.libopeFfiSha256).toBe(OPE_FFI);
    expect(m.attestedMtls?.libAttestedMtlsSha256).toBe(AMT);
    expect(m.engineBinarySha256).not.toBe(m.ope!.libopeFfiSha256);
  });

  it("prefers TEECHAT_ENGINE_BINARY_SHA256 over manifest ieRuntimeSha256", () => {
    const override = "1111111111111111111111111111111111111111111111111111111111111111";
    const root = makeRoot({ ieRuntimeSha256: IE_RUNTIME, version: "0.8.1" });
    const m = resolveBinaryMeasurementsFromEnv(
      {
        TEECHAT_ENGINE_BINARY_SHA256: override,
        TEECHAT_VLLM_BINARY_SHA256: VLLM,
        TEECHAT_ENGINE_BUILD_VERSION: "0.8.1",
      } as NodeJS.ProcessEnv,
      root,
    );
    expect(m.engineBinarySha256).toBe(override);
  });

  it("accepts TEECHAT_IE_RUNTIME_SHA256 alias", () => {
    const root = makeRoot();
    const m = resolveBinaryMeasurementsFromEnv(
      {
        TEECHAT_IE_RUNTIME_SHA256: IE_RUNTIME,
        TEECHAT_VLLM_BINARY_SHA256: VLLM,
        TEECHAT_ENGINE_BUILD_VERSION: "0.8.1",
      } as NodeJS.ProcessEnv,
      root,
    );
    expect(m.engineBinarySha256).toBe(IE_RUNTIME);
  });

  it("fails closed when engine runtime hash is missing", () => {
    const root = makeRoot({ opeFfiSha256: OPE_FFI, version: "0.8.1" });
    expect(() =>
      resolveBinaryMeasurementsFromEnv(
        { TEECHAT_VLLM_BINARY_SHA256: VLLM } as NodeJS.ProcessEnv,
        root,
      ),
    ).toThrow(/TEECHAT_ENGINE_BINARY_SHA256|TEECHAT_IE_RUNTIME_SHA256|ieRuntimeSha256/);
  });

  it("resolves OPE and attested-mtls from tcb-pins.json when manifest omits them", () => {
    const root = makeRoot({ ieRuntimeSha256: IE_RUNTIME, version: "0.8.1" });
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(
      join(root, "config", "tcb-pins.json"),
      JSON.stringify({
        ope: {
          version: "0.1.0",
          gitSha: "ffbee812e32a880bd61ed227271d98465f6bb0cb",
          libopeFfiSha256: OPE_FFI,
        },
        attestedMtls: {
          version: "0.1.0",
          gitSha: "deadbeef",
          libAttestedMtlsSha256: AMT,
        },
      }),
      "utf8",
    );
    const m = resolveBinaryMeasurementsFromEnv(
      { TEECHAT_VLLM_BINARY_SHA256: VLLM } as NodeJS.ProcessEnv,
      root,
    );
    expect(m.ope?.libopeFfiSha256).toBe(OPE_FFI);
    expect(m.attestedMtls?.libAttestedMtlsSha256).toBe(AMT);
  });
});
