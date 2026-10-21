// Parser for a practical subset of the Firestore Security Rules language.
// Supported: rules_version, service, nested match blocks with {var} and {var=**} wildcards,
// allow statements for read/write/get/list/create/update/delete, functions with a return
// expression, and expressions with literals, lists, maps, member access, indexing, calls,
// unary/binary/ternary operators, `in`, `is` and $(...) path interpolation.

export type Expr =
  | { k: "lit"; v: unknown }
  | { k: "id"; name: string }
  | { k: "list"; items: Expr[] }
  | { k: "map"; entries: [string, Expr][] }
  | { k: "member"; obj: Expr; name: string }
  | { k: "index"; obj: Expr; index: Expr }
  | { k: "call"; fn: Expr; args: Expr[] }
  | { k: "unary"; op: string; e: Expr }
  | { k: "bin"; op: string; l: Expr; r: Expr }
  | { k: "cond"; c: Expr; t: Expr; f: Expr }
  | { k: "path"; parts: (string | Expr)[] };

export interface FnDef { name: string; params: string[]; lets: [string, Expr][]; body: Expr }
export interface Allow { methods: string[]; cond: Expr | null }
export interface MatchBlock { segments: string[]; allows: Allow[]; functions: FnDef[]; children: MatchBlock[] }
export interface Ruleset { service: string; functions: FnDef[]; matches: MatchBlock[] }

type Tok = { t: "id" | "num" | "str" | "op" | "path"; v: string; pos: number };

export class RulesSyntaxError extends Error {}

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const ops = ["==", "!=", "<=", ">=", "&&", "||", "$(", "{", "}", "(", ")", "[", "]", ";", ",", ".", ":", "?", "!", "<", ">", "+", "-", "*", "/", "%", "="];
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (src.startsWith("//", i)) { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (src.startsWith("/*", i)) { i = src.indexOf("*/", i + 2) + 2; if (i < 2) i = src.length; continue; }
    if (ch === "'" || ch === '"') {
      let j = i + 1, s = "";
      while (j < src.length && src[j] !== ch) { if (src[j] === "\\") { s += src[j + 1]; j += 2; } else s += src[j++]; }
      toks.push({ t: "str", v: s, pos: i }); i = j + 1; continue;
    }
    if (/[0-9]/.test(ch)) {
      const m = /^\d+(\.\d+)?/.exec(src.slice(i))!;
      toks.push({ t: "num", v: m[0], pos: i }); i += m[0].length; continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      toks.push({ t: "id", v: m[0], pos: i }); i += m[0].length; continue;
    }
    const op = ops.find((o) => src.startsWith(o, i));
    if (!op) throw new RulesSyntaxError(`Unexpected character '${ch}' at ${i}`);
    toks.push({ t: "op", v: op, pos: i }); i += op.length;
  }
  return toks;
}

export function parseRules(src: string): Ruleset {
  const toks = tokenize(src);
  let p = 0;
  const peek = (o = 0) => toks[p + o];
  const is = (v: string, o = 0) => toks[p + o]?.v === v && toks[p + o]?.t !== "str";
  const eat = (v?: string): Tok => {
    const t = toks[p];
    if (!t) throw new RulesSyntaxError(`Unexpected end of rules, expected ${v ?? "token"}`);
    if (v !== undefined && (t.v !== v || t.t === "str")) throw new RulesSyntaxError(`Expected '${v}' at ${t.pos} but found '${t.v}'`);
    p++;
    return t;
  };

  // --- match paths ----------------------------------------------------------------------
  function matchPath(): string[] {
    const segs: string[] = [];
    while (is("/")) {
      eat("/");
      if (is("{")) {
        eat("{");
        let name = eat().v;
        if (is("=")) { eat("="); eat("*"); eat("*"); name += "=**"; }
        eat("}");
        segs.push(`{${name}}`);
      } else segs.push(eat().v);
    }
    return segs;
  }

  // --- expressions ------------------------------------------------------------------------
  function expr(): Expr { return ternary(); }
  function ternary(): Expr {
    const c = or();
    if (is("?")) { eat("?"); const t = expr(); eat(":"); const f = expr(); return { k: "cond", c, t, f }; }
    return c;
  }
  const binLevel = (ops: string[], next: () => Expr) => (): Expr => {
    let l = next();
    while (peek() && peek().t === "op" && ops.includes(peek().v) || (ops.includes("in") && is("in")) || (ops.includes("is") && is("is"))) {
      const op = eat().v;
      l = { k: "bin", op, l, r: next() };
    }
    return l;
  };
  const mul: () => Expr = binLevel(["*", "/", "%"], () => unary());
  const add = binLevel(["+", "-"], mul);
  const rel = binLevel(["<", "<=", ">", ">=", "in", "is"], add);
  const eq = binLevel(["==", "!="], rel);
  const and = binLevel(["&&"], eq);
  const or = binLevel(["||"], and);
  function unary(): Expr {
    if (is("!")) { eat("!"); return { k: "unary", op: "!", e: unary() }; }
    if (is("-")) { eat("-"); return { k: "unary", op: "-", e: unary() }; }
    return postfix(primary());
  }
  function postfix(e: Expr): Expr {
    for (;;) {
      if (is(".")) { eat("."); e = { k: "member", obj: e, name: eat().v }; }
      else if (is("[")) { eat("["); const index = expr(); eat("]"); e = { k: "index", obj: e, index }; }
      else if (is("(")) { eat("("); const args: Expr[] = []; while (!is(")")) { args.push(expr()); if (is(",")) eat(","); } eat(")"); e = { k: "call", fn: e, args }; }
      else return e;
    }
  }
  function primary(): Expr {
    const t = peek();
    if (!t) throw new RulesSyntaxError("Unexpected end of expression");
    if (t.t === "str") { p++; return { k: "lit", v: t.v }; }
    if (t.t === "num") { p++; return { k: "lit", v: Number(t.v) }; }
    if (is("(")) { eat("("); const e = expr(); eat(")"); return e; }
    if (is("[")) { eat("["); const items: Expr[] = []; while (!is("]")) { items.push(expr()); if (is(",")) eat(","); } eat("]"); return { k: "list", items }; }
    if (is("{")) {
      eat("{"); const entries: [string, Expr][] = [];
      while (!is("}")) { const key = eat().v; eat(":"); entries.push([key, expr()]); if (is(",")) eat(","); }
      eat("}"); return { k: "map", entries };
    }
    if (is("/")) {
      // path literal such as /databases/$(database)/documents/users/$(request.auth.uid)
      const parts: (string | Expr)[] = [];
      while (is("/")) {
        eat("/");
        if (is("$(")) { eat("$("); parts.push(expr()); eat(")"); }
        else parts.push(eat().v);
      }
      return { k: "path", parts };
    }
    if (t.t === "id") {
      p++;
      if (t.v === "true") return { k: "lit", v: true };
      if (t.v === "false") return { k: "lit", v: false };
      if (t.v === "null") return { k: "lit", v: null };
      return { k: "id", name: t.v };
    }
    throw new RulesSyntaxError(`Unexpected '${t.v}' at ${t.pos}`);
  }

  function fnDef(): FnDef {
    eat("function");
    const name = eat().v;
    eat("(");
    const params: string[] = [];
    while (!is(")")) { params.push(eat().v); if (is(",")) eat(","); }
    eat(")"); eat("{");
    const lets: [string, Expr][] = [];
    while (is("let")) { eat("let"); const n = eat().v; eat("="); lets.push([n, expr()]); eat(";"); }
    eat("return");
    const body = expr();
    if (is(";")) eat(";");
    eat("}");
    return { name, params, lets, body };
  }

  function block(segments: string[]): MatchBlock {
    const b: MatchBlock = { segments, allows: [], functions: [], children: [] };
    eat("{");
    while (!is("}")) {
      if (is("match")) { eat("match"); b.children.push(block(matchPath())); }
      else if (is("function")) b.functions.push(fnDef());
      else if (is("allow")) {
        eat("allow");
        const methods: string[] = [eat().v];
        while (is(",")) { eat(","); methods.push(eat().v); }
        let cond: Expr | null = null;
        if (is(":")) { eat(":"); eat("if"); cond = expr(); }
        eat(";");
        b.allows.push({ methods, cond });
      } else throw new RulesSyntaxError(`Unexpected '${peek().v}' at ${peek().pos}`);
    }
    eat("}");
    return b;
  }

  if (is("rules_version")) { eat("rules_version"); eat("="); eat(); if (is(";")) eat(";"); }
  eat("service");
  let service = eat().v;
  while (is(".")) { eat("."); service += "." + eat().v; }
  const root = block([]);
  return { service, functions: root.functions, matches: root.children };
}
