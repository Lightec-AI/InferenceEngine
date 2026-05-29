import https from "node:https";

export interface GatewayMtlsTlsMaterial {
  caCertPem: string;
  clientCertPem: string;
  clientKeyPem: string;
  rejectUnauthorized?: boolean;
}

export interface GatewayEnginePlaneResponse {
  status: number;
  json: unknown;
  text: string;
}

/** POST JSON to the gateway engine control plane over mTLS. */
export async function postJsonEnginePlane(opts: {
  baseUrl: string;
  path: string;
  body: unknown;
  tls: GatewayMtlsTlsMaterial;
}): Promise<GatewayEnginePlaneResponse> {
  const url = new URL(opts.path, opts.baseUrl);
  const payload = JSON.stringify(opts.body);
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
        ca: opts.tls.caCertPem,
        cert: opts.tls.clientCertPem,
        key: opts.tls.clientKeyPem,
        rejectUnauthorized: opts.tls.rejectUnauthorized ?? true,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk as Buffer));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: unknown = {};
          if (text.trim()) {
            try {
              json = JSON.parse(text) as unknown;
            } catch {
              json = { raw: text };
            }
          }
          resolve({ status: res.statusCode ?? 0, json, text });
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

/** Register + optional ephemeral rotation via mTLS engine plane. */
export async function registerEngineViaMtls(opts: {
  engineBaseUrl: string;
  tls: GatewayMtlsTlsMaterial;
  registerBody: Record<string, unknown>;
  ephemeralBody?: Record<string, unknown>;
}): Promise<{ registerStatus: number; ephemeralStatus?: number }> {
  const reg = await postJsonEnginePlane({
    baseUrl: opts.engineBaseUrl,
    path: "/v1/ope/engines/register",
    body: opts.registerBody,
    tls: opts.tls,
  });
  let ephemeralStatus: number | undefined;
  if (reg.status === 201 && opts.ephemeralBody) {
    const engineId = String(
      (opts.registerBody as { engine_id?: string }).engine_id ?? "",
    );
    const ep = await postJsonEnginePlane({
      baseUrl: opts.engineBaseUrl,
      path: `/v1/ope/engines/${encodeURIComponent(engineId)}/ephemeral`,
      body: opts.ephemeralBody,
      tls: opts.tls,
    });
    ephemeralStatus = ep.status;
  }
  return { registerStatus: reg.status, ephemeralStatus };
}
