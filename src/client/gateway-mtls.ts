import https from "node:https";

/** Dev/test transport TLS client material for Attested TLS + HTTP/2 engine plane connections. */
export interface GatewayMtlsTlsMaterial {
  caCertPem: string;
  clientCertPem: string;
  clientKeyPem: string;
  rejectUnauthorized?: boolean;
}

export async function postJsonOverMtls(opts: {
  baseUrl: string;
  path: string;
  body: unknown;
  tls: GatewayMtlsTlsMaterial;
}): Promise<{ status: number; json: unknown }> {
  const url = new URL(opts.path, opts.baseUrl);
  const payload = JSON.stringify(opts.body);

  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: "POST",
        ca: opts.tls.caCertPem,
        cert: opts.tls.clientCertPem,
        key: opts.tls.clientKeyPem,
        rejectUnauthorized: opts.tls.rejectUnauthorized ?? true,
        minVersion: "TLSv1.2",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk as Buffer));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8").trim();
          let json: unknown = {};
          if (text) {
            try {
              json = JSON.parse(text) as unknown;
            } catch {
              json = { raw: text };
            }
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}
