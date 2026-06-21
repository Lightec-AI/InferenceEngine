import { createPublicKey } from "node:crypto";

import { base64UrlToBytes } from "./base64url.js";

export { base64UrlToBytes, bytesToBase64Url } from "./base64url.js";

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
