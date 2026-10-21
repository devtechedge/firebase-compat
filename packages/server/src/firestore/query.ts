// Evaluation of Firestore StructuredQuery objects against an in-memory document set.
import { compareReferences, compareValues, getField, isNaNValue, typeOf, valuesEqual, type Fields, type Value } from "./values.js";

export interface Doc {
  name: string; // full resource name: projects/p/databases/d/documents/a/b
  fields: Fields;
  createTime: string;
  updateTime: string;
}

export interface FieldReference { fieldPath: string }
export interface FieldFilter { field: FieldReference; op: string; value: Value }
export interface UnaryFilter { field: FieldReference; op: string }
export interface Filter {
  fieldFilter?: FieldFilter;
  unaryFilter?: UnaryFilter;
  compositeFilter?: { op: string; filters: Filter[] };
}
export interface Order { field: FieldReference; direction?: string }
export interface Cursor { values?: Value[]; before?: boolean }
export interface StructuredQuery {
  select?: { fields?: FieldReference[] };
  from?: { collectionId?: string; allDescendants?: boolean }[];
  where?: Filter;
  orderBy?: Order[];
  startAt?: Cursor;
  endAt?: Cursor;
  offset?: number;
  limit?: number | { value?: number };
}

export class QueryError extends Error {
  constructor(message: string, public code = "INVALID_ARGUMENT") { super(message); }
}

const INEQUALITY = new Set(["LESS_THAN", "LESS_THAN_OR_EQUAL", "GREATER_THAN", "GREATER_THAN_OR_EQUAL", "NOT_EQUAL", "NOT_IN"]);

export function fieldValue(doc: Doc, path: string): Value | undefined {
  if (path === "__name__") return { referenceValue: doc.name };
  return getField(doc.fields, path);
}

export function matchesFilter(doc: Doc, f: Filter): boolean {
  if (f.compositeFilter) {
    const subs = f.compositeFilter.filters ?? [];
    return f.compositeFilter.op === "OR" ? subs.some((s) => matchesFilter(doc, s)) : subs.every((s) => matchesFilter(doc, s));
  }
  if (f.unaryFilter) {
    const v = fieldValue(doc, f.unaryFilter.field.fieldPath);
    switch (f.unaryFilter.op) {
      case "IS_NULL": return !!v && typeOf(v) === "null";
      case "IS_NAN": return !!v && isNaNValue(v);
      case "IS_NOT_NULL": return !!v && typeOf(v) !== "null";
      case "IS_NOT_NAN": return !!v && typeOf(v) === "number" && !isNaNValue(v);
    }
    return false;
  }
  if (f.fieldFilter) {
    const { field, op, value } = f.fieldFilter;
    const v = fieldValue(doc, field.fieldPath);
    if (v === undefined) return false;
    const values = value.arrayValue?.values ?? [];
    switch (op) {
      case "EQUAL": return valuesEqual(v, value);
      case "NOT_EQUAL": return typeOf(v) !== "null" && !valuesEqual(v, value);
      case "IN": return values.some((x) => valuesEqual(v, x));
      case "NOT_IN": return typeOf(v) !== "null" && !values.some((x) => valuesEqual(v, x));
      case "ARRAY_CONTAINS": return (v.arrayValue?.values ?? []).some((x) => valuesEqual(x, value));
      case "ARRAY_CONTAINS_ANY": return (v.arrayValue?.values ?? []).some((x) => values.some((y) => valuesEqual(x, y)));
    }
    // Range comparisons only match values of the same type, and never NaN.
    if (typeOf(v) !== typeOf(value) || isNaNValue(v) || isNaNValue(value)) return false;
    const c = compareValues(v, value);
    switch (op) {
      case "LESS_THAN": return c < 0;
      case "LESS_THAN_OR_EQUAL": return c <= 0;
      case "GREATER_THAN": return c > 0;
      case "GREATER_THAN_OR_EQUAL": return c >= 0;
    }
    throw new QueryError(`Unsupported operator ${op}`);
  }
  return true;
}

function inequalityFields(f: Filter | undefined, out: string[] = []): string[] {
  if (!f) return out;
  if (f.compositeFilter) for (const s of f.compositeFilter.filters ?? []) inequalityFields(s, out);
  if (f.fieldFilter && INEQUALITY.has(f.fieldFilter.op) && !out.includes(f.fieldFilter.field.fieldPath)) out.push(f.fieldFilter.field.fieldPath);
  return out;
}

/** Explicit orderBy plus the implicit orders Firestore adds (inequality fields, then __name__). */
export function normalizedOrderBy(q: StructuredQuery): Order[] {
  const orders = [...(q.orderBy ?? [])];
  const seen = new Set(orders.map((o) => o.field.fieldPath));
  if (orders.length === 0) {
    for (const f of inequalityFields(q.where).sort()) {
      if (!seen.has(f)) { orders.push({ field: { fieldPath: f }, direction: "ASCENDING" }); seen.add(f); }
    }
  }
  if (!seen.has("__name__")) {
    const lastDir = orders.length ? orders[orders.length - 1].direction ?? "ASCENDING" : "ASCENDING";
    orders.push({ field: { fieldPath: "__name__" }, direction: lastDir });
  }
  return orders;
}

export function compareDocs(a: Doc, b: Doc, orders: Order[]): number {
  for (const o of orders) {
    const va = fieldValue(a, o.field.fieldPath)!;
    const vb = fieldValue(b, o.field.fieldPath)!;
    let c = o.field.fieldPath === "__name__" ? compareReferences(a.name, b.name) : compareValues(va, vb);
    if (o.direction === "DESCENDING") c = -c;
    if (c) return c;
  }
  return 0;
}

function cursorCompare(doc: Doc, cursor: Cursor, orders: Order[]): number {
  const values = cursor.values ?? [];
  for (let i = 0; i < values.length && i < orders.length; i++) {
    const o = orders[i];
    let c: number;
    if (o.field.fieldPath === "__name__") {
      const ref = values[i].referenceValue ?? "";
      c = compareReferences(doc.name, ref);
    } else c = compareValues(fieldValue(doc, o.field.fieldPath)!, values[i]);
    if (o.direction === "DESCENDING") c = -c;
    if (c) return c;
  }
  return 0;
}

export function limitOf(q: StructuredQuery): number | undefined {
  if (q.limit === undefined || q.limit === null) return undefined;
  return typeof q.limit === "number" ? q.limit : q.limit.value;
}

/** Path of a document relative to the documents root, e.g. "rooms/r1/messages/m1". */
export function relPath(name: string): string {
  const i = name.indexOf("/documents/");
  return i < 0 ? "" : name.slice(i + "/documents/".length);
}

export function docInScope(doc: Doc, parentRel: string, q: StructuredQuery): boolean {
  const rel = relPath(doc.name);
  const segs = rel.split("/");
  const from = q.from ?? [];
  if (from.length === 0) return false;
  return from.some((sel) => {
    const collectionId = segs[segs.length - 2];
    if (sel.collectionId && sel.collectionId !== collectionId) return false;
    const parent = segs.slice(0, -2).join("/");
    if (sel.allDescendants) return parentRel === "" || parent === parentRel || parent.startsWith(parentRel + "/");
    return parent === parentRel;
  });
}

/** Run a structured query; `parentRel` is the parent document path relative to the root ("" for root). */
export function runQuery(docs: Iterable<Doc>, parentRel: string, q: StructuredQuery): Doc[] {
  const orders = normalizedOrderBy(q);
  let out: Doc[] = [];
  for (const d of docs) {
    if (!docInScope(d, parentRel, q)) continue;
    if (q.where && !matchesFilter(d, q.where)) continue;
    // Documents missing an ordered field are excluded from results.
    if (orders.some((o) => fieldValue(d, o.field.fieldPath) === undefined)) continue;
    out.push(d);
  }
  out.sort((a, b) => compareDocs(a, b, orders));
  if (q.startAt) out = out.filter((d) => { const c = cursorCompare(d, q.startAt!, orders); return q.startAt!.before ? c >= 0 : c > 0; });
  if (q.endAt) out = out.filter((d) => { const c = cursorCompare(d, q.endAt!, orders); return q.endAt!.before ? c < 0 : c <= 0; });
  if (q.offset) out = out.slice(q.offset);
  const lim = limitOf(q);
  if (lim !== undefined) out = out.slice(0, lim);
  if (q.select?.fields) {
    const keep = q.select.fields.map((f) => f.fieldPath).filter((p) => p !== "__name__");
    out = out.map((d) => {
      const fields: Fields = {};
      for (const p of keep) { const v = getField(d.fields, p); if (v !== undefined) setNested(fields, p, v); }
      return { ...d, fields };
    });
  }
  return out;
}

function setNested(fields: Fields, path: string, v: Value) {
  const segs = path.split(".");
  let t = fields;
  for (let i = 0; i < segs.length - 1; i++) {
    t[segs[i]] ??= { mapValue: { fields: {} } };
    t = t[segs[i]].mapValue!.fields!;
  }
  t[segs[segs.length - 1]] = v;
}
