// Minimal JWT support: RS256 signing for ID tokens and lenient decoding for custom tokens.
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify, type KeyObject } from "node:crypto";
import type { Store } from "../util/db.js";

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export function decodeJwt(token: string): { header: Record<string, unknown>; payload: Record<string, unknown>; signature: string } | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    return {
      header: JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")),
      payload: JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")),
      signature: parts[2] ?? "",
    };
  } catch {
    return null;
  }
}

export class KeyRing {
  readonly kid: string;
  private privateKey: KeyObject;
  readonly publicKey: KeyObject;

  constructor(store?: Store) {
    let saved = store?.get<{ kid: string; pem: string }>("meta", "signing-key");
    if (!saved) {
      const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
      saved = { kid: randomBytes(20).toString("hex"), pem: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
      store?.put("meta", "signing-key", saved);
    }
    this.kid = saved.kid;
    this.privateKey = createPrivateKey(saved.pem);
    this.publicKey = createPublicKey(this.privateKey);
  }

  sign(payload: Record<string, unknown>): string {
    const head = b64url(JSON.stringify({ alg: "RS256", kid: this.kid, typ: "JWT" }));
    const body = b64url(JSON.stringify(payload));
    const sig = sign("RSA-SHA256", Buffer.from(`${head}.${body}`), this.privateKey);
    return `${head}.${body}.${b64url(sig)}`;
  }

  verify(token: string): boolean {
    const [h, p, s] = token.split(".");
    if (!s) return false;
    return verify("RSA-SHA256", Buffer.from(`${h}.${p}`), this.publicKey, Buffer.from(s, "base64url"));
  }

  jwks() {
    return { keys: [{ ...this.publicKey.export({ format: "jwk" }), kid: this.kid, alg: "RS256", use: "sig" }] };
  }
}
