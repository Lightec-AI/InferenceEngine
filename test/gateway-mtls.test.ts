import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { postJsonOverMtls } from "../src/client/gateway-mtls.js";

const FIXTURES = path.join(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../../server/gateway/mtls/fixtures",
);

function loadTlsMaterial() {
  return {
    caCertPem: fs.readFileSync(path.join(FIXTURES, "dev-ca.pem"), "utf8"),
    clientCertPem: fs.readFileSync(path.join(FIXTURES, "dev-client.pem"), "utf8"),
    clientKeyPem: fs.readFileSync(path.join(FIXTURES, "dev-client.key.pem"), "utf8"),
    serverCertPem: fs.readFileSync(path.join(FIXTURES, "dev-server.pem"), "utf8"),
    serverKeyPem: fs.readFileSync(path.join(FIXTURES, "dev-server.key.pem"), "utf8"),
  };
}

describe("postJsonOverMtls", () => {
  let server: https.Server | undefined;

  afterEach(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
    server = undefined;
  });

  it("posts JSON over mTLS and rejects connections without a client cert", async () => {
    const tls = loadTlsMaterial();
    server = https.createServer(
      {
        cert: tls.serverCertPem,
        key: tls.serverKeyPem,
        ca: tls.caCertPem,
        requestCert: true,
        rejectUnauthorized: true,
        minVersion: "TLSv1.2",
      },
      (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end();
          return;
        }
        const chunks: Buffer[] = [];
        req.on("data", (chunk) => chunks.push(chunk as Buffer));
        req.on("end", () => {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { ping?: string };
          res.setHeader("Content-Type", "application/json");
          res.statusCode = 201;
          res.end(JSON.stringify({ ok: true, echo: body.ping ?? "" }));
        });
      },
    );

    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server!.address();
    if (!addr || typeof addr === "string") throw new Error("listen failed");
    const baseUrl = `https://127.0.0.1:${addr.port}`;

    const ok = await postJsonOverMtls({
      baseUrl,
      path: "/ping",
      body: { ping: "pong" },
      tls: {
        caCertPem: tls.caCertPem,
        clientCertPem: tls.clientCertPem,
        clientKeyPem: tls.clientKeyPem,
      },
    });
    expect(ok.status).toBe(201);
    expect(ok.json).toEqual({ ok: true, echo: "pong" });

    await expect(
      new Promise((resolve, reject) => {
        const url = new URL("/ping", baseUrl);
        const req = https.request(
          url,
          { method: "POST", ca: tls.caCertPem, rejectUnauthorized: true },
          (res) => {
            res.resume();
            resolve(res.statusCode);
          },
        );
        req.on("error", reject);
        req.end("{}");
      }),
    ).rejects.toThrow();
  });
});
