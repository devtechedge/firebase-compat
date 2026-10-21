// Firestore typed values in their proto3 JSON form (the shape used on the REST and WebChannel
// wire). Ordering follows the documented Firestore cross-type value order.

export type Value = {
  nullValue?: null | "NULL_VALUE";
  booleanValue?: boolean;
  integerValue?: string | number;
  doubleValue?: number | string;
  timestampValue?: string;
  stringValue?: string;
  bytesValue?: string;
  referenceValue?: string;
  geoPointValue?: { latitude?: number; longitude?: number };
  arrayValue?: { values?: Value[] };
  mapValue?: { fields?: Record<string, Value> };
};
export type Fields = Record<string, Value>;

const TYPE_ORDER = ["null", "boolean", "number", "timestamp", "string", "bytes", "reference", "geopoint", "array", "vector", "map"];

export function typeOf(v: Value): string {
  if ("nullValue" in v) return "null";
  if ("booleanValue" in v) return "boolean";
  if ("integerValue" in v || "doubleValue" in v) return "number";
  if ("timestampValue" in v) return "timestamp";
  if ("stringValue" in v) return "string";
  if ("bytesValue" in v) return "bytes";
  if ("referenceValue" in v) return "reference";
  if ("geoPointValue" in v) return "geopoint";
  if ("arrayValue" in v) return "array";
  if ("mapValue" in v) {
    const t = v.mapValue?.fields?.["__type__"];
    if (t?.stringValue === "__vector__") return "vector";
    return "map";
  }
  return "null";
}

export function toNumber(v: Value): number {
  if ("integerValue" in v) return Number(v.integerValue);
  const d = v.doubleValue;
  if (d === "NaN") return NaN;
  if (d === "Infinity") return Infinity;
  if (d === "-Infinity") return -Infinity;
  return Number(d);
}

export function isNaNValue(v: Value): boolean {
  return "doubleValue" in v && Number.isNaN(toNumber(v));
}

/** Parse an RFC 3339 timestamp into [seconds, nanos] keeping nanosecond precision. */
export function parseTimestamp(s: string): [number, number] {
  const m = /^(.*T\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?(Z|[+-]\d\d:\d\d)$/.exec(s);
  if (!m) { const ms = Date.parse(s); return [Math.floor(ms / 1000), (ms % 1000) * 1e6]; }
  const secs = Math.floor(Date.parse(m[1] + m[3]) / 1000);
  const nanos = m[2] ? Number(m[2].padEnd(9, "0")) : 0;
  return [secs, nanos];
}

export function formatTimestamp(seconds: number, nanos: number): string {
  const iso = new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "");
  const frac = nanos % 1000 === 0 ? String(nanos / 1000).padStart(6, "0") : String(nanos).padStart(9, "0");
  return `${iso}.${frac}Z`;
}

function cmp<T>(a: T, b: T): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareNumbers(a: number, b: number): number {
  if (Number.isNaN(a)) return Number.isNaN(b) ? 0 : -1;
  if (Number.isNaN(b)) return 1;
  return cmp(a, b);
}

function compareUtf8(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

export function compareReferences(a: string, b: string): number {
  const sa = a.split("/");
  const sb = b.split("/");
  for (let i = 0; i < Math.min(sa.length, sb.length); i++) {
    const c = compareSegments(sa[i], sb[i]);
    if (c) return c;
  }
  return cmp(sa.length, sb.length);
}

function compareSegments(a: string, b: string): number {
  const na = /^__id-?\d+__$/.test(a);
  const nb = /^__id-?\d+__$/.test(b);
  if (na && nb) return cmp(Number(a.slice(4, -2)), Number(b.slice(4, -2)));
  if (na) return -1;
  if (nb) return 1;
  return compareUtf8(a, b);
}

export function compareValues(a: Value, b: Value): number {
  const ta = typeOf(a);
  const tb = typeOf(b);
  if (ta !== tb) return cmp(TYPE_ORDER.indexOf(ta), TYPE_ORDER.indexOf(tb));
  switch (ta) {
    case "null": return 0;
    case "boolean": return cmp(Number(a.booleanValue), Number(b.booleanValue));
    case "number": {
      if ("integerValue" in a && "integerValue" in b) return cmp(BigInt(a.integerValue!), BigInt(b.integerValue!));
      return compareNumbers(toNumber(a), toNumber(b));
    }
    case "timestamp": {
      const [s1, n1] = parseTimestamp(a.timestampValue!);
      const [s2, n2] = parseTimestamp(b.timestampValue!);
      return cmp(s1, s2) || cmp(n1, n2);
    }
    case "string": return compareUtf8(a.stringValue!, b.stringValue!);
    case "bytes": return Buffer.compare(Buffer.from(a.bytesValue!, "base64"), Buffer.from(b.bytesValue!, "base64"));
    case "reference": return compareReferences(a.referenceValue!, b.referenceValue!);
    case "geopoint": return cmp(a.geoPointValue!.latitude ?? 0, b.geoPointValue!.latitude ?? 0) || cmp(a.geoPointValue!.longitude ?? 0, b.geoPointValue!.longitude ?? 0);
    case "array": {
      const xa = a.arrayValue?.values ?? [];
      const xb = b.arrayValue?.values ?? [];
      for (let i = 0; i < Math.min(xa.length, xb.length); i++) {
        const c = compareValues(xa[i], xb[i]);
        if (c) return c;
      }
      return cmp(xa.length, xb.length);
    }
    case "vector": {
      const va = a.mapValue!.fields!["value"]?.arrayValue?.values ?? [];
      const vb = b.mapValue!.fields!["value"]?.arrayValue?.values ?? [];
      return cmp(va.length, vb.length) || compareValues({ arrayValue: { values: va } }, { arrayValue: { values: vb } });
    }
    default: {
      const fa = a.mapValue?.fields ?? {};
      const fb = b.mapValue?.fields ?? {};
      const ka = Object.keys(fa).sort(compareUtf8);
      const kb = Object.keys(fb).sort(compareUtf8);
      for (let i = 0; i < Math.min(ka.length, kb.length); i++) {
        const c = compareUtf8(ka[i], kb[i]) || compareValues(fa[ka[i]], fb[kb[i]]);
        if (c) return c;
      }
      return cmp(ka.length, kb.length);
    }
  }
}

export function valuesEqual(a: Value, b: Value): boolean {
  const ta = typeOf(a);
  if (ta !== typeOf(b)) return false;
  if (ta === "number") {
    const x = toNumber(a), y = toNumber(b);
    if (Number.isNaN(x) && Number.isNaN(y)) return true;
    if ("integerValue" in a && "integerValue" in b) return BigInt(a.integerValue!) === BigInt(b.integerValue!);
    return x === y;
  }
  return compareValues(a, b) === 0;
}

/** Split a field path ("a.b", "`odd.key`.c") into segments. */
export function parseFieldPath(path: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < path.length; i++) {
    const ch = path[i];
    if (quoted) {
      if (ch === "\\") { cur += path[++i]; continue; }
      if (ch === "`") { quoted = false; continue; }
      cur += ch;
    } else if (ch === "`") quoted = true;
    else if (ch === ".") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

export function getField(fields: Fields | undefined, path: string): Value | undefined {
  let cur: Value | undefined = { mapValue: { fields } };
  for (const seg of parseFieldPath(path)) {
    if (!cur || !("mapValue" in cur)) return undefined;
    cur = cur.mapValue?.fields?.[seg];
  }
  return cur;
}

export function setField(fields: Fields, path: string, value: Value | undefined): void {
  const segs = parseFieldPath(path);
  let target = fields;
  for (let i = 0; i < segs.length - 1; i++) {
    let next = target[segs[i]];
    if (!next || !("mapValue" in next)) {
      if (value === undefined) return;
      next = target[segs[i]] = { mapValue: { fields: {} } };
    }
    next.mapValue!.fields ??= {};
    target = next.mapValue!.fields!;
  }
  const last = segs[segs.length - 1];
  if (value === undefined) delete target[last];
  else target[last] = value;
}

export function clone<T>(v: T): T {
  return structuredClone(v);
}

export function isNumeric(v: Value | undefined): boolean {
  return !!v && ("integerValue" in v || "doubleValue" in v);
}

/** Convert a JSON-ish JavaScript value (used by the admin API) into a Firestore Value. */
export function fromPlain(x: unknown): Value {
  if (x === null || x === undefined) return { nullValue: null };
  if (typeof x === "boolean") return { booleanValue: x };
  if (typeof x === "number") return Number.isInteger(x) ? { integerValue: String(x) } : { doubleValue: x };
  if (typeof x === "string") return { stringValue: x };
  if (Array.isArray(x)) return { arrayValue: { values: x.map(fromPlain) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(x as object).map(([k, v]) => [k, fromPlain(v)])) } };
}

/** Convert a Firestore Value into a readable plain JavaScript value (used by the dashboard). */
export function toPlain(v: Value): unknown {
  switch (typeOf(v)) {
    case "null": return null;
    case "boolean": return v.booleanValue;
    case "number": return "integerValue" in v ? Number(v.integerValue) : toNumber(v);
    case "timestamp": return { __timestamp: v.timestampValue };
    case "string": return v.stringValue;
    case "bytes": return { __bytes: v.bytesValue };
    case "reference": return { __ref: v.referenceValue };
    case "geopoint": return { __geo: v.geoPointValue };
    case "array": return (v.arrayValue?.values ?? []).map(toPlain);
    default: return Object.fromEntries(Object.entries(v.mapValue?.fields ?? {}).map(([k, x]) => [k, toPlain(x)]));
  }
}
