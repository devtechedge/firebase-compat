// Evaluates parsed Firestore Security Rules for a request. Any evaluation error makes the
// individual allow condition false, mirroring how Firestore treats errors as denials.
import { parseRules, type Expr, type FnDef, type MatchBlock, type Ruleset } from "./parser.js";
import { parseTimestamp, toPlain, type Fields, type Value } from "../firestore/values.js";

export type Method = "get" | "list" | "create" | "update" | "delete";

export interface RulesRequest {
  method: Method;
  /** Document path relative to /databases/{database}/documents, e.g. "rooms/r1". */
  path: string;
  database?: string;
  auth: Record<string, unknown> | null;
  resource?: { id: string; name: string; data: Fields } | null;
  incoming?: { id: string; name: string; data: Fields } | null;
  getDocument?: (path: string) => Fields | undefined;
}

class RulesPath {
  constructor(readonly segments: string[]) {}
  toString() { return "/" + this.segments.join("/"); }
}

class EvalError extends Error {}

function convert(v: Value): unknown {
  if ("timestampValue" in v) { const [s, n] = parseTimestamp(v.timestampValue!); return new Date(s * 1000 + n / 1e6); }
  if ("referenceValue" in v) return new RulesPath(v.referenceValue!.split("/documents/")[1]?.split("/") ?? []);
  if ("mapValue" in v) return convertFields(v.mapValue?.fields ?? {});
  if ("arrayValue" in v) return (v.arrayValue?.values ?? []).map(convert);
  return toPlain(v);
}
function convertFields(f: Fields): Record<string, unknown> {
  return Object.fromEntries(Object.entries(f).map(([k, v]) => [k, convert(v)]));
}

function deepEq(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof RulesPath || b instanceof RulesPath) return String(a) === String(b);
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEq(x, b[i]));
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => deepEq((a as any)[k], (b as any)[k]));
  }
  return a === b;
}

const METHOD_GROUPS: Record<string, Method[]> = {
  read: ["get", "list"], write: ["create", "update", "delete"],
  get: ["get"], list: ["list"], create: ["create"], update: ["update"], delete: ["delete"],
};

export class RulesEngine {
  readonly ruleset: Ruleset;
  constructor(readonly source: string) {
    this.ruleset = parseRules(source);
    if (this.ruleset.service !== "cloud.firestore") throw new Error(`Unsupported service ${this.ruleset.service}`);
  }

  allows(req: RulesRequest): boolean {
    const segs = req.path.split("/").filter(Boolean);
    const database = req.database ?? "(default)";
    const full = ["databases", database, "documents", ...segs];
    return this.ruleset.matches.some((m) => this.walk(m, full, 0, {}, [this.ruleset.functions], req));
  }

  private walk(b: MatchBlock, segs: string[], pos: number, vars: Record<string, unknown>, fns: FnDef[][], req: RulesRequest): boolean {
    const bound = { ...vars };
    let i = pos;
    for (const pat of b.segments) {
      const wild = /^\{(.+)\}$/.exec(pat);
      if (wild && wild[1].endsWith("=**")) {
        bound[wild[1].slice(0, -3)] = new RulesPath(segs.slice(i));
        i = segs.length;
        break;
      }
      if (i >= segs.length) return false;
      if (wild) bound[wild[1]] = segs[i];
      else if (pat !== segs[i]) return false;
      i++;
    }
    const scope = [...fns, b.functions];
    if (i === segs.length) {
      for (const a of b.allows) {
        if (!a.methods.some((m) => METHOD_GROUPS[m]?.includes(req.method))) continue;
        if (a.cond === null) return true;
        try { if (this.eval(a.cond, bound, scope, req) === true) return true; } catch { /* error = deny */ }
      }
    }
    return b.children.some((c) => this.walk(c, segs, i, bound, scope, req));
  }

  private env(req: RulesRequest) {
    const auth = req.auth ? { uid: req.auth.uid ?? req.auth.sub, token: req.auth } : null;
    const now = new Date();
    const resource = req.resource ? { data: convertFields(req.resource.data), id: req.resource.id, __name__: new RulesPath(req.resource.name.split("/documents/")[1]?.split("/") ?? []) } : null;
    const incoming = req.incoming ? { data: convertFields(req.incoming.data), id: req.incoming.id, __name__: new RulesPath(req.incoming.name.split("/documents/")[1]?.split("/") ?? []) } : null;
    return {
      request: { auth, time: now, method: req.method, path: new RulesPath(req.path.split("/")), resource: incoming },
      resource,
    };
  }

  private eval(e: Expr, vars: Record<string, unknown>, fns: FnDef[][], req: RulesRequest): unknown {
    const ev = (x: Expr) => this.eval(x, vars, fns, req);
    switch (e.k) {
      case "lit": return e.v;
      case "list": return e.items.map(ev);
      case "map": return Object.fromEntries(e.entries.map(([k, v]) => [k, ev(v)]));
      case "path": return new RulesPath(e.parts.map((p) => (typeof p === "string" ? p : String(ev(p)))));
      case "id": {
        if (e.name in vars) return vars[e.name];
        const env = this.env(req) as Record<string, unknown>;
        if (e.name in env) return env[e.name];
        if (e.name === "math" || e.name === "timestamp" || e.name === "duration") return { __ns: e.name };
        throw new EvalError(`Unknown identifier ${e.name}`);
      }
      case "member": {
        const o = ev(e.obj);
        if (o === null || o === undefined) throw new EvalError(`Null value error accessing ${e.name}`);
        if (o instanceof Date && e.name === "seconds") return () => Math.floor(o.getTime() / 1000);
        const v = (o as Record<string, unknown>)[e.name];
        if (v === undefined && !(typeof o === "object" && e.name in (o as object))) {
          if (typeof o === "object" && !Array.isArray(o) && !(o instanceof RulesPath) && !("__ns" in (o as object))) throw new EvalError(`Property ${e.name} is undefined`);
        }
        return v;
      }
      case "index": {
        const o = ev(e.obj); const k = ev(e.index);
        if (o instanceof RulesPath) return o.segments[Number(k)];
        if (Array.isArray(o)) return o[Number(k)];
        if (o && typeof o === "object" && String(k) in o) return (o as any)[String(k)];
        throw new EvalError("Index out of range");
      }
      case "unary": {
        const v = ev(e.e);
        if (e.op === "!") { if (typeof v !== "boolean") throw new EvalError("! on non-bool"); return !v; }
        return -(v as number);
      }
      case "cond": return ev(e.c) === true ? ev(e.t) : ev(e.f);
      case "bin": return this.binary(e, ev);
      case "call": return this.call(e, vars, fns, req, ev);
    }
  }

  private binary(e: Extract<Expr, { k: "bin" }>, ev: (x: Expr) => unknown): unknown {
    if (e.op === "&&") { const l = ev(e.l); if (l !== true) return false; return ev(e.r) === true; }
    if (e.op === "||") {
      let l: unknown; try { l = ev(e.l); } catch { l = false; }
      if (l === true) return true; return ev(e.r) === true;
    }
    if (e.op === "is") {
      const v = ev(e.l); const t = (e.r as { name?: string }).name;
      const types: Record<string, (x: unknown) => boolean> = {
        string: (x) => typeof x === "string", int: (x) => Number.isInteger(x), float: (x) => typeof x === "number",
        number: (x) => typeof x === "number", bool: (x) => typeof x === "boolean", list: Array.isArray,
        map: (x) => !!x && typeof x === "object" && !Array.isArray(x) && !(x instanceof Date), timestamp: (x) => x instanceof Date,
        path: (x) => x instanceof RulesPath, null: (x) => x === null,
      };
      return types[t ?? ""]?.(v) ?? false;
    }
    const l = ev(e.l), r = ev(e.r);
    const num = (x: unknown) => (x instanceof Date ? x.getTime() : x) as number;
    switch (e.op) {
      case "==": return deepEq(l, r);
      case "!=": return !deepEq(l, r);
      case "<": return num(l) < num(r);
      case "<=": return num(l) <= num(r);
      case ">": return num(l) > num(r);
      case ">=": return num(l) >= num(r);
      case "+": return (l as number) + (r as number);
      case "-": return (l as number) - (r as number);
      case "*": return (l as number) * (r as number);
      case "/": return (l as number) / (r as number);
      case "%": return (l as number) % (r as number);
      case "in":
        if (Array.isArray(r)) return r.some((x) => deepEq(x, l));
        if (r && typeof r === "object") return String(l) in r;
        throw new EvalError("in on non-collection");
    }
    throw new EvalError(`Unknown operator ${e.op}`);
  }

  private call(e: Extract<Expr, { k: "call" }>, vars: Record<string, unknown>, fns: FnDef[][], req: RulesRequest, ev: (x: Expr) => unknown): unknown {
    const args = () => e.args.map(ev);
    if (e.fn.k === "id") {
      const name = e.fn.name;
      for (let i = fns.length - 1; i >= 0; i--) {
        const f = fns[i].find((x) => x.name === name);
        if (f) {
          const a = args();
          const local: Record<string, unknown> = { ...vars };
          f.params.forEach((p, j) => (local[p] = a[j]));
          for (const [n, x] of f.lets) local[n] = this.eval(x, local, fns, req);
          return this.eval(f.body, local, fns, req);
        }
      }
      if (name === "get" || name === "exists") {
        const p = args()[0];
        if (!(p instanceof RulesPath)) throw new EvalError(`${name}() requires a path`);
        const rel = p.segments.slice(p.segments.indexOf("documents") + 1).join("/");
        const doc = req.getDocument?.(rel);
        if (name === "exists") return !!doc;
        if (!doc) throw new EvalError("get() on missing document");
        return { data: convertFields(doc), id: p.segments[p.segments.length - 1] };
      }
      if (name === "string") return String(args()[0]);
      if (name === "int") return Math.trunc(Number(args()[0]));
      if (name === "float") return Number(args()[0]);
      throw new EvalError(`Unknown function ${name}`);
    }
    if (e.fn.k === "member") {
      const target = this.eval(e.fn.obj, vars, fns, req);
      const m = e.fn.name;
      const a = args();
      if (target && typeof target === "object" && "__ns" in (target as object)) {
        const ns = (target as { __ns: string }).__ns;
        if (ns === "math") return (Math as any)[m === "abs" ? "abs" : m](...(a as number[]));
        if (ns === "timestamp" && m === "date") return new Date(Date.UTC(a[0] as number, (a[1] as number) - 1, a[2] as number));
        if (ns === "duration" && m === "value") return (a[0] as number) * ({ s: 1000, m: 60000, h: 3600000, d: 86400000 } as any)[a[1] as string];
      }
      if (typeof target === "function" && a.length === 0) return (target as () => unknown)();
      if (typeof target === "string") {
        if (m === "size") return target.length;
        if (m === "matches") return new RegExp(`^(?:${a[0]})$`).test(target);
        if (m === "lower") return target.toLowerCase();
        if (m === "upper") return target.toUpperCase();
        if (m === "trim") return target.trim();
        if (m === "split") return target.split(a[0] as string);
      }
      if (Array.isArray(target)) {
        if (m === "size") return target.length;
        if (m === "hasAll") return (a[0] as unknown[]).every((x) => target.some((y) => deepEq(x, y)));
        if (m === "hasAny") return (a[0] as unknown[]).some((x) => target.some((y) => deepEq(x, y)));
        if (m === "hasOnly") return target.every((x) => (a[0] as unknown[]).some((y) => deepEq(x, y)));
        if (m === "toSet") return [...new Set(target)];
        if (m === "join") return target.join(a[0] as string);
      }
      if (target instanceof Date) {
        if (m === "toMillis") return target.getTime();
        if (m === "seconds") return Math.floor(target.getTime() / 1000);
        if (m === "year") return target.getUTCFullYear();
      }
      if (target && typeof target === "object") {
        const obj = target as Record<string, unknown>;
        if (m === "keys") return Object.keys(obj);
        if (m === "values") return Object.values(obj);
        if (m === "size") return Object.keys(obj).length;
        if (m === "get") {
          const keys = Array.isArray(a[0]) ? (a[0] as string[]) : [a[0] as string];
          let cur: unknown = obj;
          for (const k of keys) { if (!cur || typeof cur !== "object" || !(k in (cur as object))) return a[1]; cur = (cur as any)[k]; }
          return cur;
        }
        if (m === "diff") {
          const other = a[0] as Record<string, unknown>;
          const added = Object.keys(other).filter((k) => !(k in obj));
          const removed = Object.keys(obj).filter((k) => !(k in other));
          const changed = Object.keys(obj).filter((k) => k in other && !deepEq(obj[k], other[k]));
          return {
            addedKeys: () => added, removedKeys: () => removed, changedKeys: () => changed,
            affectedKeys: () => [...added, ...removed, ...changed],
            unchangedKeys: () => Object.keys(obj).filter((k) => k in other && deepEq(obj[k], other[k])),
          };
        }
        const fn = obj[m];
        if (typeof fn === "function") return (fn as (...x: unknown[]) => unknown)(...a);
      }
      throw new EvalError(`Unknown method ${m}`);
    }
    throw new EvalError("Invalid call");
  }
}

export const OPEN_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if true;
    }
  }
}`;
