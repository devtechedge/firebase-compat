import { describe, expect, it } from "vitest";
import { hashOf } from "../src/database/hash.js";
import { applyQuery, compareKeys, normalize, resolveServerValues, setAt } from "../src/database/tree.js";
import { pushId } from "../src/database/service.js";

describe("realtime database tree", () => {
  it("hashes like the SDK (value from recorded emulator traffic)", () => {
    expect(hashOf(1)).toBe("YPVfR2bXt/lcDjiQZ8pOkAd3qkQ=");
    expect(hashOf(null)).toBe("");
    expect(hashOf({ a: null })).toBe("");
  });
  it("normalizes arrays, nulls and empty objects", () => {
    expect(normalize({ a: null, b: {}, c: [1, 2] })).toEqual({ c: { 0: 1, 1: 2 } });
  });
  it("sets and prunes nested paths", () => {
    let t = setAt(null, ["a", "b"], 1);
    expect(t).toEqual({ a: { b: 1 } });
    t = setAt(t, ["a", "b"], null);
    expect(t).toBeNull();
  });
  it("resolves server timestamps and increments", () => {
    expect(resolveServerValues({ t: { ".sv": "timestamp" } }, 42, null)).toEqual({ t: 42 });
    expect(resolveServerValues({ ".sv": { increment: 2 } }, 0, 5)).toBe(7);
  });
  it("orders integer keys before string keys", () => {
    expect(["b", "10", "2", "a"].sort(compareKeys)).toEqual(["2", "10", "a", "b"]);
  });
  it("applies orderByChild with limits", () => {
    const v = { a: { s: 3 }, b: { s: 1 }, c: { s: 2 } };
    expect(Object.keys(applyQuery(v, { i: "s", l: 2, vf: "l" }) as object)).toEqual(["b", "c"]);
    expect(Object.keys(applyQuery(v, { i: "s", l: 1, vf: "r" }) as object)).toEqual(["a"]);
    expect(Object.keys(applyQuery(v, { i: "s", sp: 2 }) as object)).toEqual(["c", "a"]);
  });
  it("generates chronologically sortable push ids", () => {
    const a = pushId(1000), b = pushId(2000);
    expect(a.length).toBe(20);
    expect(a.slice(0, 8) < b.slice(0, 8)).toBe(true);
  });
});
