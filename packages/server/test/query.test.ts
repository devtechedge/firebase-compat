import { describe, expect, it } from "vitest";
import { runQuery, type Doc } from "../src/firestore/query.js";
import { fromPlain } from "../src/firestore/values.js";

const root = "projects/p/databases/(default)/documents";
const mk = (path: string, data: Record<string, unknown>): Doc => ({ name: `${root}/${path}`, fields: fromPlain(data).mapValue!.fields!, createTime: "", updateTime: "" });
const docs = [
  mk("cities/sf", { name: "SF", pop: 870, tags: ["west", "coast"], state: "CA" }),
  mk("cities/la", { name: "LA", pop: 3900, tags: ["west"], state: "CA" }),
  mk("cities/ny", { name: "NY", pop: 8400, tags: ["east", "coast"], state: "NY" }),
  mk("cities/bj", { name: "Beijing", pop: 21500, state: null }),
  mk("cities/sf/landmarks/gg", { name: "Golden Gate", type: "bridge" }),
  mk("cities/ny/landmarks/sol", { name: "Statue", type: "monument" }),
];
const ids = (r: Doc[]) => r.map((d) => d.name.split("/").pop());
const ff = (fieldPath: string, op: string, value: unknown) => ({ fieldFilter: { field: { fieldPath }, op, value: fromPlain(value) } });

describe("structured queries", () => {
  it("lists a collection ordered by document id", () => {
    expect(ids(runQuery(docs, "", { from: [{ collectionId: "cities" }] }))).toEqual(["bj", "la", "ny", "sf"]);
  });
  it("filters with equality and range", () => {
    expect(ids(runQuery(docs, "", { from: [{ collectionId: "cities" }], where: ff("state", "EQUAL", "CA") }))).toEqual(["la", "sf"]);
    expect(ids(runQuery(docs, "", { from: [{ collectionId: "cities" }], where: ff("pop", "GREATER_THAN", 1000) }))).toEqual(["la", "ny", "bj"]);
  });
  it("supports array-contains, in and not-in", () => {
    expect(ids(runQuery(docs, "", { from: [{ collectionId: "cities" }], where: ff("tags", "ARRAY_CONTAINS", "coast") }))).toEqual(["ny", "sf"]);
    expect(ids(runQuery(docs, "", { from: [{ collectionId: "cities" }], where: ff("state", "IN", ["NY", "CA"]) }))).toEqual(["la", "ny", "sf"]);
    expect(ids(runQuery(docs, "", { from: [{ collectionId: "cities" }], where: ff("state", "NOT_IN", ["NY"]) }))).toEqual(["la", "sf"]);
  });
  it("supports OR composite filters", () => {
    const where = { compositeFilter: { op: "OR", filters: [ff("name", "EQUAL", "SF"), ff("pop", "GREATER_THAN", 10000)] } };
    expect(ids(runQuery(docs, "", { from: [{ collectionId: "cities" }], where }))).toEqual(["sf", "bj"]);
  });
  it("orders, limits and applies cursors", () => {
    const q = { from: [{ collectionId: "cities" }], orderBy: [{ field: { fieldPath: "pop" }, direction: "DESCENDING" }] };
    expect(ids(runQuery(docs, "", { ...q, limit: 2 }))).toEqual(["bj", "ny"]);
    expect(ids(runQuery(docs, "", { ...q, startAt: { values: [fromPlain(3900)], before: true } }))).toEqual(["la", "sf"]);
    expect(ids(runQuery(docs, "", { ...q, startAt: { values: [fromPlain(3900)], before: false } }))).toEqual(["sf"]);
    expect(ids(runQuery(docs, "", { ...q, endAt: { values: [fromPlain(8400)], before: false } }))).toEqual(["bj", "ny"]);
  });
  it("excludes documents missing an ordered field", () => {
    expect(ids(runQuery(docs, "", { from: [{ collectionId: "cities" }], orderBy: [{ field: { fieldPath: "tags" } }] }))).toHaveLength(3);
  });
  it("runs collection group queries", () => {
    expect(ids(runQuery(docs, "", { from: [{ collectionId: "landmarks", allDescendants: true }] }))).toEqual(["sol", "gg"]);
    expect(ids(runQuery(docs, "cities/sf", { from: [{ collectionId: "landmarks" }] }))).toEqual(["gg"]);
  });
  it("projects selected fields", () => {
    const r = runQuery(docs, "", { from: [{ collectionId: "cities" }], select: { fields: [{ fieldPath: "name" }] }, limit: 1 });
    expect(Object.keys(r[0].fields)).toEqual(["name"]);
  });
  it("is-null and not-equal semantics", () => {
    expect(ids(runQuery(docs, "", { from: [{ collectionId: "cities" }], where: { unaryFilter: { field: { fieldPath: "state" }, op: "IS_NULL" } } }))).toEqual(["bj"]);
    expect(ids(runQuery(docs, "", { from: [{ collectionId: "cities" }], where: ff("state", "NOT_EQUAL", "CA") }))).toEqual(["ny"]);
  });
});
