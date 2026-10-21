// Realtime Database JSON tree: path utilities, server values, ordering and query filtering.
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export function splitPath(p: string): string[] {
  return p.split("/").filter(Boolean);
}

export function getAt(root: Json, path: string[]): Json {
  let cur: Json = root;
  for (const s of path) {
    if (cur === null || typeof cur !== "object" || Array.isArray(cur)) return null;
    cur = (cur as Record<string, Json>)[s] ?? null;
  }
  return cur ?? null;
}

/** Remove empty objects and nulls the way the RTDB normalizes data. */
export function normalize(v: Json): Json {
  if (v === null || typeof v !== "object") return v;
  const entries = Array.isArray(v) ? v.map((x, i) => [String(i), x] as const) : Object.entries(v);
  const out: Record<string, Json> = {};
  for (const [k, x] of entries) {
    if (k === ".priority") continue;
    if (k === ".value") return normalize(x);
    const n = normalize(x);
    if (n !== null) out[k] = n;
  }
  return Object.keys(out).length ? out : null;
}

export function setAt(root: Json, path: string[], value: Json): Json {
  if (!path.length) return normalize(value);
  const base: Record<string, Json> = root && typeof root === "object" && !Array.isArray(root) ? { ...(root as Record<string, Json>) } : {};
  const [head, ...rest] = path;
  const child = setAt(base[head] ?? null, rest, value);
  if (child === null) delete base[head];
  else base[head] = child;
  return Object.keys(base).length ? base : null;
}

export function resolveServerValues(v: Json, now: number, current: Json): Json {
  if (v === null || typeof v !== "object") return v;
  if (!Array.isArray(v) && ".sv" in v) {
    const sv = (v as Record<string, Json>)[".sv"];
    if (sv === "timestamp") return now;
    if (sv && typeof sv === "object" && "increment" in (sv as object)) {
      const inc = Number((sv as Record<string, Json>).increment);
      return (typeof current === "number" ? current : 0) + inc;
    }
    return null;
  }
  const out: Record<string, Json> = {};
  for (const [k, x] of Object.entries(v)) out[k] = resolveServerValues(x, now, getAt(current, [k]));
  return out;
}

const INT = /^-?\d{1,10}$/;
function isIntKey(k: string) { return INT.test(k) && Number(k) >= -2147483648 && Number(k) <= 2147483647; }

export function compareKeys(a: string, b: string): number {
  if (a === b) return 0;
  const ia = isIntKey(a), ib = isIntKey(b);
  if (ia && ib) return Number(a) - Number(b) || a.length - b.length;
  if (ia) return -1;
  if (ib) return 1;
  return a < b ? -1 : 1;
}

function rank(v: Json): number {
  if (v === null) return 0;
  if (v === false) return 1;
  if (v === true) return 2;
  if (typeof v === "number") return 3;
  if (typeof v === "string") return 4;
  return 5;
}

export function compareValues(a: Json, b: Json): number {
  const ra = rank(a), rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (typeof a === "number") return a - (b as number);
  if (typeof a === "string") return a < (b as string) ? -1 : a > (b as string) ? 1 : 0;
  return 0;
}

export interface QueryParams { i?: string; sp?: Json; sn?: string; sin?: boolean; ep?: Json; en?: string; ein?: boolean; l?: number; vf?: "l" | "r" }

/** Apply an RTDB query (orderBy*, startAt/endAt, limitTo*) to the children of `value`. */
export function applyQuery(value: Json, q: QueryParams | undefined): Json {
  if (!q || !Object.keys(q).length || value === null || typeof value !== "object") return value;
  const index = q.i ?? ".priority";
  const sortVal = (k: string, v: Json): Json => index === ".key" ? k : index === ".value" ? v : index === ".priority" ? null : getAt(v, splitPath(index));
  let entries = Object.entries(value as Record<string, Json>);
  const cmp = (a: [string, Json], b: [string, Json]) => {
    if (index === ".key") return compareKeys(a[0], b[0]);
    return compareValues(sortVal(...a), sortVal(...b)) || compareKeys(a[0], b[0]);
  };
  entries.sort(cmp);
  const startInclusive = q.sin !== false;
  const endInclusive = q.ein !== false;
  if ("sp" in q) {
    entries = entries.filter(([k, v]) => {
      const c = index === ".key" ? compareKeys(k, String(q.sp)) : compareValues(sortVal(k, v), q.sp ?? null) || (q.sn !== undefined ? compareKeys(k, q.sn) : 0);
      return startInclusive ? c >= 0 : c > 0;
    });
  }
  if ("ep" in q) {
    entries = entries.filter(([k, v]) => {
      const c = index === ".key" ? compareKeys(k, String(q.ep)) : compareValues(sortVal(k, v), q.ep ?? null) || (q.en !== undefined ? compareKeys(k, q.en) : 0);
      return endInclusive ? c <= 0 : c < 0;
    });
  }
  if (q.l !== undefined) entries = q.vf === "r" ? entries.slice(-q.l) : entries.slice(0, q.l);
  return entries.length ? Object.fromEntries(entries) : null;
}
