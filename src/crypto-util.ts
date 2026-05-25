import { createPublicKey } from "node:crypto";

export function base64UrlToBytes(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  return Buffer.from(b64, "base64");
}

export function bytesToBase64Url(buf: Buffer): string {
  return buf.toString("base64url");
}

export function ed25519PublicKeyFromBase64Url(ed25519PublicBase64Url: string) {
  const pub = base64UrlToBytes(ed25519PublicBase64Url);
  if (pub.length !== 32) throw new Error("invalid_ed25519_public_length");
  const derPrefix = Buffer.from("302a300506032b6570032100", "hex");
  return createPublicKey({
    key: Buffer.concat([derPrefix, pub]),
    format: "der",
    type: "spki",
  });
}
