// Firestore storage engine: documents, atomic commits with preconditions and transforms,
// queries, aggregations and change notification for realtime listeners.
import { randomBytes } from "node:crypto";
import type { Store } from "../util/db.js";
import { RpcError } from "../util/status.js";
import { runQuery, relPath, type Doc, type StructuredQuery } from "./query.js";
import { clone, compareValues, formatTimestamp, getField, isNumeric, parseTimestamp, setField, toNumber, valuesEqual, type Fields, type Value } from "./values.js";

export interface Precondition { exists?: boolean; updateTime?: string }
export interface FieldTransform {
  fieldPath: string;
  setToServerValue?: string;
  increment?: Value;
  maximum?: Value;
  minimum?: Value;
  appendMissingElements?: { values?: Value[] };
  removeAllFromArray?: { values?: Value[] };
}
export interface Write {
  update?: { name: string; fields?: Fields };
  delete?: string;
  verify?: string;
  transform?: { document: string; fieldTransforms?: FieldTransform[] };
  updateMask?: { fieldPaths?: string[] };
  updateTransforms?: FieldTransform[];
  currentDocument?: Precondition;
}
export interface WriteResult { updateTime?: string; transformResults?: Value[] }
export interface CommitResult { writeResults: WriteResult[]; commitTime: string }

export interface AccessContext {
  /** Decoded ID token claims, or null for unauthenticated requests. */
  auth: Record<string, unknown> | null;
  /** Admin and owner credentials bypass security rules. */
  admin: boolean;
}

export type Authorizer = (op: "get" | "list" | "create" | "update" | "delete", name: string, ctx: AccessContext, existing: Doc | undefined, incoming: Doc | undefined, query?: StructuredQuery) => boolean;

export type ChangeListener = (changed: Map<string, Doc | null>, readTime: string) => void;

export class Clock {
  private last = 0;
  /** Strictly increasing microsecond clock. */
  nowMicros(): number {
    const t = Math.max(Date.now() * 1000, this.last + 1);
    this.last = t;
    return t;
  }
  now(): string {
    const us = this.nowMicros();
    return formatTimestamp(Math.floor(us / 1e6), (us % 1e6) * 1000);
  }
}

export function timestampMicros(ts: string): number {
  const [s, n] = parseTimestamp(ts);
  return s * 1e6 + Math.floor(n / 1000);
}

export class FirestoreEngine {
  readonly docs = new Map<string, Doc>();
  readonly clock = new Clock();
  private listeners = new Set<ChangeListener>();
  private transactions = new Map<string, { readOnly: boolean; readTime: string }>();
  authorize: Authorizer = () => true;

  constructor(private store?: Store, readonly projectId = "demo-project") {
    for (const [name, doc] of store?.all<Doc>("firestore") ?? []) this.docs.set(name, doc);
  }

  onChange(l: ChangeListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  get(name: string): Doc | undefined {
    return this.docs.get(name);
  }

  checkRead(name: string, ctx: AccessContext): Doc | undefined {
    const d = this.docs.get(name);
    if (!ctx.admin && !this.authorize("get", name, ctx, d, undefined)) throw new RpcError("PERMISSION_DENIED", "Missing or insufficient permissions.");
    return d;
  }

  query(parent: string, q: StructuredQuery, ctx: AccessContext): Doc[] {
    const parentRel = relPath(parent.endsWith("/documents") ? parent + "/" : parent);
    const prefix = parent.endsWith("/documents") ? parent : parent.slice(0, parent.indexOf("/documents") + "/documents".length);
    const docs = [...this.docs.values()].filter((d) => d.name.startsWith(prefix + "/"));
    const out = runQuery(docs, parentRel, q);
    if (!ctx.admin) {
      for (const d of out) {
        if (!this.authorize("list", d.name, ctx, d, undefined, q)) throw new RpcError("PERMISSION_DENIED", "Missing or insufficient permissions.");
      }
      if (out.length === 0) {
        const probe = `${parent}/${q.from?.[0]?.collectionId ?? "_"}/__probe__`;
        if (!this.authorize("list", probe, ctx, undefined, undefined, q)) throw new RpcError("PERMISSION_DENIED", "Missing or insufficient permissions.");
      }
    }
    return out;
  }

  aggregate(parent: string, q: StructuredQuery, aggs: { alias?: string; count?: { upTo?: unknown }; sum?: { field: { fieldPath: string } }; avg?: { field: { fieldPath: string } } }[], ctx: AccessContext): Record<string, Value> {
    const base = { ...q, limit: undefined, offset: undefined };
    let docs = this.query(parent, base, ctx);
    if (q.offset) docs = docs.slice(q.offset);
    const lim = typeof q.limit === "number" ? q.limit : q.limit?.value;
    if (lim !== undefined) docs = docs.slice(0, lim);
    const out: Record<string, Value> = {};
    aggs.forEach((a, i) => {
      const alias = a.alias || `field_${i + 1}`;
      if (a.count) {
        const upTo = a.count.upTo as { value?: string | number } | string | number | undefined;
        const cap = upTo === undefined ? Infinity : Number(typeof upTo === "object" ? upTo.value : upTo);
        out[alias] = { integerValue: String(Math.min(docs.length, cap)) };
      } else if (a.sum || a.avg) {
        const path = (a.sum ?? a.avg)!.field.fieldPath;
        const nums = docs.map((d) => getField(d.fields, path)).filter((v): v is Value => isNumeric(v));
        if (a.avg) {
          out[alias] = nums.length ? { doubleValue: nums.reduce((s, v) => s + toNumber(v), 0) / nums.length } : { nullValue: null };
        } else if (nums.every((v) => "integerValue" in v)) {
          out[alias] = { integerValue: String(nums.reduce((s, v) => s + BigInt(v.integerValue!), 0n)) };
        } else out[alias] = { doubleValue: nums.reduce((s, v) => s + toNumber(v), 0) };
      }
    });
    return out;
  }

  listCollectionIds(parent: string): string[] {
    const prefix = parent.endsWith("/documents") ? parent + "/" : parent + "/";
    const ids = new Set<string>();
    for (const name of this.docs.keys()) {
      if (!name.startsWith(prefix)) continue;
      ids.add(name.slice(prefix.length).split("/")[0]);
    }
    return [...ids].sort();
  }

  beginTransaction(readOnly = false): string {
    const id = randomBytes(16).toString("base64");
    this.transactions.set(id, { readOnly, readTime: this.clock.now() });
    return id;
  }

  rollback(id: string): void {
    this.transactions.delete(id);
  }

  commit(writes: Write[], ctx: AccessContext, transaction?: string): CommitResult {
    if (transaction) {
      if (!this.transactions.has(transaction)) throw new RpcError("INVALID_ARGUMENT", "Transaction is invalid or has expired.");
      this.transactions.delete(transaction);
    }
    const commitTime = this.clock.now();
    // Stage writes against a scratch view so the commit is all-or-nothing.
    const staged = new Map<string, Doc | null>();
    const view = (name: string) => (staged.has(name) ? staged.get(name) ?? undefined : this.docs.get(name));
    const results: WriteResult[] = [];
    for (const w of writes) {
      const name = w.update?.name ?? w.delete ?? w.verify ?? w.transform?.document;
      if (!name) throw new RpcError("INVALID_ARGUMENT", "Write has no target document.");
      validateName(name);
      const existing = view(name);
      checkPrecondition(name, existing, w.currentDocument);
      if (w.verify) { results.push({}); continue; }
      if (w.delete) {
        if (!ctx.admin && !this.authorize("delete", name, ctx, existing, undefined)) throw denied();
        staged.set(name, null);
        results.push({ updateTime: commitTime });
        continue;
      }
      let fields: Fields;
      if (w.update) {
        if (w.updateMask) {
          fields = clone(existing?.fields ?? {});
          for (const p of w.updateMask.fieldPaths ?? []) setField(fields, p, clone(getField(w.update.fields ?? {}, p)));
        } else fields = clone(w.update.fields ?? {});
      } else fields = clone(existing?.fields ?? {});
      const transforms = w.updateTransforms ?? w.transform?.fieldTransforms ?? [];
      const transformResults = transforms.map((t) => applyTransform(fields, t, commitTime));
      const doc: Doc = { name, fields, createTime: existing?.createTime ?? commitTime, updateTime: commitTime };
      const op = existing ? "update" : "create";
      if (!ctx.admin && !this.authorize(op, name, ctx, existing, doc)) throw denied();
      staged.set(name, doc);
      results.push(transforms.length ? { updateTime: commitTime, transformResults } : { updateTime: commitTime });
    }
    // Writes that did not change a document keep its previous updateTime.
    for (const [name, doc] of staged) {
      const before = this.docs.get(name);
      if (doc && before && fieldsEqual(before.fields, doc.fields)) staged.set(name, before);
    }
    const changed = new Map<string, Doc | null>();
    const apply = () => {
      for (const [name, doc] of staged) {
        const before = this.docs.get(name);
        if (doc === null) {
          if (!before) continue;
          this.docs.delete(name);
          this.store?.delete("firestore", name);
        } else {
          if (before === doc) continue;
          this.docs.set(name, doc);
          this.store?.put("firestore", name, doc);
        }
        changed.set(name, doc);
      }
    };
    if (this.store) this.store.transaction(apply); else apply();
    if (changed.size) for (const l of this.listeners) l(changed, commitTime);
    return { writeResults: results, commitTime };
  }

  /** Remove every document (used by the emulator-compatible DELETE endpoint and tests). */
  clear(): void {
    const changed = new Map<string, Doc | null>();
    for (const name of this.docs.keys()) changed.set(name, null);
    this.docs.clear();
    this.store?.clear("firestore");
    const t = this.clock.now();
    if (changed.size) for (const l of this.listeners) l(changed, t);
  }

  newDocumentId(): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    const bytes = randomBytes(20);
    let id = "";
    for (const b of bytes) id += chars[b % chars.length];
    return id;
  }
}

function denied() {
  return new RpcError("PERMISSION_DENIED", "Missing or insufficient permissions.");
}

function validateName(name: string) {
  const rel = relPath(name);
  if (!rel || rel.split("/").length % 2 !== 0) throw new RpcError("INVALID_ARGUMENT", `Document name "${name}" has invalid trailing "/".`);
}

function fieldsEqual(a: Fields, b: Fields): boolean {
  return valuesEqual({ mapValue: { fields: a } }, { mapValue: { fields: b } }) && JSON.stringify(a) === JSON.stringify(b);
}

function checkPrecondition(name: string, existing: Doc | undefined, pre?: Precondition) {
  if (!pre) return;
  if (pre.exists === true && !existing) throw new RpcError("NOT_FOUND", `No document to update: ${name}`);
  if (pre.exists === false && existing) throw new RpcError("ALREADY_EXISTS", `Document already exists: ${name}`);
  if (pre.updateTime !== undefined) {
    if (!existing || timestampMicros(existing.updateTime) !== timestampMicros(pre.updateTime)) {
      throw new RpcError("FAILED_PRECONDITION", "the stored version does not match the required base version");
    }
  }
}

function applyTransform(fields: Fields, t: FieldTransform, commitTime: string): Value {
  const cur = getField(fields, t.fieldPath);
  let next: Value;
  if (t.setToServerValue) next = { timestampValue: commitTime };
  else if (t.increment) next = numericOp(cur, t.increment, (a, b) => a + b, (a, b) => a + b);
  else if (t.maximum) next = isNumeric(cur) ? (compareValues(cur!, t.maximum) >= 0 ? cur! : t.maximum) : t.maximum;
  else if (t.minimum) next = isNumeric(cur) ? (compareValues(cur!, t.minimum) <= 0 ? cur! : t.minimum) : t.minimum;
  else if (t.appendMissingElements) {
    const vals = [...(cur?.arrayValue?.values ?? [])];
    for (const v of t.appendMissingElements.values ?? []) if (!vals.some((x) => valuesEqual(x, v))) vals.push(v);
    next = { arrayValue: { values: vals } };
  } else if (t.removeAllFromArray) {
    const rm = t.removeAllFromArray.values ?? [];
    next = { arrayValue: { values: (cur?.arrayValue?.values ?? []).filter((x) => !rm.some((r) => valuesEqual(x, r))) } };
  } else throw new RpcError("INVALID_ARGUMENT", "Unknown field transform");
  setField(fields, t.fieldPath, next);
  return t.setToServerValue ? { timestampValue: commitTime } : next;
}

function numericOp(cur: Value | undefined, operand: Value, ints: (a: bigint, b: bigint) => bigint, dbl: (a: number, b: number) => number): Value {
  if (!isNumeric(cur)) return operand;
  if ("integerValue" in cur! && "integerValue" in operand) {
    const r = ints(BigInt(cur!.integerValue!), BigInt(operand.integerValue!));
    const max = 2n ** 63n - 1n, min = -(2n ** 63n);
    return { integerValue: String(r > max ? max : r < min ? min : r) };
  }
  return { doubleValue: dbl(toNumber(cur!), toNumber(operand)) };
}
