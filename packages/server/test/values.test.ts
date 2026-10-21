import { describe, expect, it } from "vitest";
import { compareValues, formatTimestamp, fromPlain, getField, parseFieldPath, parseTimestamp, setField, toPlain, valuesEqual } from "../src/firestore/values.js";

describe("firestore values", () => {
  it("orders values across types", () => {
    const ordered = [{ nullValue: null }, { booleanValue: false }, { booleanValue: true }, { doubleValue: "NaN" }, { integerValue: "-1" }, { doubleValue: 0.5 },
      { timestampValue: "2020-01-01T00:00:00Z" }, { stringValue: "a" }, { stringValue: "b" }, { bytesValue: "AA==" },
      { referenceValue: "projects/p/databases/d/documents/a/b" }, { geoPointValue: { latitude: 1, longitude: 2 } },
      { arrayValue: { values: [] } }, { mapValue: { fields: {} } }];
    for (let i = 1; i < ordered.length; i++) expect(compareValues(ordered[i - 1] as never, ordered[i] as never)).toBeLessThan(0);
  });
  it("treats integers and doubles as one numeric type", () => {
    expect(valuesEqual({ integerValue: "1" }, { doubleValue: 1 })).toBe(true);
    expect(compareValues({ integerValue: "2" }, { doubleValue: 1.5 })).toBeGreaterThan(0);
  });
  it("compares large integers exactly", () => {
    expect(compareValues({ integerValue: "9007199254740993" }, { integerValue: "9007199254740992" })).toBeGreaterThan(0);
  });
  it("parses quoted field paths", () => {
    expect(parseFieldPath("a.b")).toEqual(["a", "b"]);
    expect(parseFieldPath("`x.y`.z")).toEqual(["x.y", "z"]);
  });
  it("gets and sets nested fields", () => {
    const f = {};
    setField(f, "a.b.c", { integerValue: "1" });
    expect(getField(f, "a.b.c")).toEqual({ integerValue: "1" });
    setField(f, "a.b.c", undefined);
    expect(getField(f, "a.b.c")).toBeUndefined();
  });
  it("round trips timestamps with microseconds", () => {
    const [s, n] = parseTimestamp("2026-10-21T16:06:32.726615Z");
    expect(formatTimestamp(s, n)).toBe("2026-10-21T16:06:32.726615Z");
    expect(parseTimestamp("2026-10-21T16:06:32.760933000Z")[1]).toBe(760933000);
  });
  it("converts plain values both ways", () => {
    const plain = { a: 1, b: "x", c: [true, null], d: { e: 1.5 } };
    expect(toPlain(fromPlain(plain))).toEqual(plain);
  });
});
