// Node hashes compatible with the Realtime Database client SDK's transaction compare-and-set.
// A leaf hashes "<type>:<value>" (numbers as big-endian IEEE 754 hex); an object hashes
// ":<key>:<childHash>" for each child in key order. Hashes are base64 SHA-1, "" for null.
// Verified against evidence/raw/emulator-database.har (value 1 -> YPVfR2bXt/lcDjiQZ8pOkAd3qkQ=).
import { createHash } from "node:crypto";
import { compareKeys, type Json } from "./tree.js";

const sha1 = (s: string) => createHash("sha1").update(s, "utf8").digest("base64");

export function doubleToHex(n: number): string {
  const b = Buffer.alloc(8);
  b.writeDoubleBE(n);
  return b.toString("hex");
}

export function hashOf(v: Json): string {
  if (v === null) return "";
  if (typeof v === "object") {
    let s = "";
    for (const k of Object.keys(v).sort(compareKeys)) {
      const h = hashOf((v as Record<string, Json>)[k]);
      if (h !== "") s += `:${k}:${h}`;
    }
    return s === "" ? "" : sha1(s);
  }
  if (typeof v === "number") return sha1(`number:${doubleToHex(v)}`);
  return sha1(`${typeof v}:${v}`);
}
