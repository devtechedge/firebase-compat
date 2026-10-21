// Realtime Database: the v5 WebSocket wire protocol used by the SDK plus the REST (.json) API.
// Message shapes come from evidence/raw/emulator-database.har; see docs/protocol/database.md.
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { AuthService } from "../auth/service.js";
import type { Store } from "../util/db.js";
import { bearer, readBody, sendJson } from "../util/http.js";
import { hashOf } from "./hash.js";
import { applyQuery, getAt, resolveServerValues, setAt, splitPath, type Json, type QueryParams } from "./tree.js";

interface Listen { path: string; segs: string[]; query?: QueryParams; tag?: number; lastHash?: string }
interface Conn { ws: WebSocket; ns: string; listens: Map<string, Listen>; onDisconnect: { action: string; path: string; data: Json }[]; auth: Record<string, unknown> | null }

const listenKey = (path: string, q?: QueryParams) => `${path}|${JSON.stringify(q ?? {})}`;
const overlaps = (a: string[], b: string[]) => a.slice(0, Math.min(a.length, b.length)).every((s, i) => s === b[i]);

export class DatabaseService {
  private trees = new Map<string, Json>();
  private conns = new Set<Conn>();
  private wss = new WebSocketServer({ noServer: true });
  private saveTimers = new Map<string, NodeJS.Timeout>();

  constructor(private store: Store | undefined, private auth: AuthService, readonly defaultNs: string) {
    for (const [ns, tree] of store?.all<Json>("rtdb") ?? []) this.trees.set(ns, tree);
  }

  get connectionCount() { return this.conns.size; }
  namespaces() { return [...new Set([this.defaultNs, ...this.trees.keys()])]; }

  get(ns: string, path: string): Json {
    return getAt(this.trees.get(ns) ?? null, splitPath(path));
  }

  /** Write `value` at `path` (resolving server values) and notify listeners. */
  set(ns: string, path: string, value: Json): void {
    const segs = splitPath(path);
    const root = this.trees.get(ns) ?? null;
    const resolved = resolveServerValues(value, Date.now(), getAt(root, segs));
    this.trees.set(ns, setAt(root, segs, resolved));
    this.persist(ns);
    this.notify(ns, segs);
  }

  update(ns: string, path: string, children: Record<string, Json>): void {
    const segs = splitPath(path);
    let root = this.trees.get(ns) ?? null;
    const now = Date.now();
    for (const [k, v] of Object.entries(children)) {
      const p = [...segs, ...splitPath(k)];
      root = setAt(root, p, resolveServerValues(v, now, getAt(root, p)));
    }
    this.trees.set(ns, root);
    this.persist(ns);
    this.notify(ns, segs);
  }

  clear(ns: string) {
    this.trees.set(ns, null);
    this.persist(ns);
    this.notify(ns, []);
  }

  private persist(ns: string) {
    if (!this.store) return;
    clearTimeout(this.saveTimers.get(ns));
    this.saveTimers.set(ns, setTimeout(() => this.store!.put("rtdb", ns, this.trees.get(ns) ?? null), 50));
  }

  private notify(ns: string, changed: string[]) {
    for (const c of this.conns) {
      if (c.ns !== ns) continue;
      for (const l of c.listens.values()) if (overlaps(changed, l.segs)) this.sendListenData(c, l);
    }
  }

  private sendListenData(c: Conn, l: Listen) {
    const value = applyQuery(this.get(c.ns, l.path), l.query);
    const h = JSON.stringify(value);
    if (h === l.lastHash) return;
    l.lastHash = h;
    const body: Record<string, unknown> = { p: l.segs.join("/"), d: value };
    if (l.tag !== undefined) body.t = l.tag;
    this.sendRaw(c, { t: "d", d: { b: body, a: "d" } });
  }

  private sendRaw(c: Conn, msg: unknown) {
    if (c.ws.readyState !== 1) return;
    const s = JSON.stringify(msg);
    // The client accepts a frame count followed by fragments for large messages.
    if (s.length <= 16384) { c.ws.send(s); return; }
    const parts = Math.ceil(s.length / 16384);
    c.ws.send(String(parts));
    for (let i = 0; i < parts; i++) c.ws.send(s.slice(i * 16384, (i + 1) * 16384));
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/.ws") return false;
    const ns = url.searchParams.get("ns") ?? this.defaultNs;
    this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws, ns, req.headers.host ?? "localhost"));
    return true;
  }

  private accept(ws: WebSocket, ns: string, host: string) {
    const c: Conn = { ws, ns, listens: new Map(), onDisconnect: [], auth: null };
    this.conns.add(c);
    this.sendRaw(c, { t: "c", d: { t: "h", d: { ts: Date.now(), v: "5", h: host, s: randomBytes(16).toString("base64url") } } });
    let frames: string[] = [];
    let expected = 0;
    ws.on("message", (raw) => {
      const text = raw.toString();
      if (expected) {
        frames.push(text);
        if (frames.length < expected) return;
        const joined = frames.join("");
        frames = []; expected = 0;
        return this.onMessage(c, joined);
      }
      if (/^\d+$/.test(text)) {
        if (text === "0") return; // keepalive
        expected = Number(text);
        return;
      }
      this.onMessage(c, text);
    });
    ws.on("close", () => {
      this.conns.delete(c);
      for (const op of c.onDisconnect) {
        if (op.action === "m") this.update(c.ns, op.path, op.data as Record<string, Json>);
        else this.set(c.ns, op.path, op.data);
      }
    });
    ws.on("error", () => {});
  }

  private onMessage(c: Conn, text: string) {
    let msg: { t: string; d: { r?: number; a?: string; b?: any } };
    try { msg = JSON.parse(text); } catch { return; }
    if (msg.t !== "d" || !msg.d) return;
    const { r, a, b = {} } = msg.d;
    const reply = (status: string, data: unknown = "") => r !== undefined && this.sendRaw(c, { t: "d", d: { r, b: { s: status, d: data } } });
    switch (a) {
      case "s": return reply("ok");
      case "auth":
      case "gauth": {
        const cred = String(b.cred ?? "");
        if (cred === "owner") { c.auth = { admin: true }; return reply("ok", { auth: null, expires: null }); }
        const claims = this.auth.verifyIdToken(cred);
        if (!claims) return reply("invalid_token", "Invalid claim 'kid' in auth header.");
        c.auth = claims;
        return reply("ok", { auth: { provider: (claims.firebase as any)?.sign_in_provider, user_id: claims.uid, token: claims }, expires: claims.exp });
      }
      case "unauth": c.auth = null; return reply("ok");
      case "q": {
        const l: Listen = { path: b.p, segs: splitPath(b.p), query: b.q && Object.keys(b.q).length ? b.q : undefined, tag: b.t };
        c.listens.set(listenKey(b.p, l.query), l);
        this.sendListenData(c, l);
        return reply("ok", {});
      }
      case "n": c.listens.delete(listenKey(b.p, b.q && Object.keys(b.q).length ? b.q : undefined)); return reply("ok");
      case "g": return reply("ok", applyQuery(this.get(c.ns, b.p), b.q));
      case "p": {
        if (b.h !== undefined && hashOf(this.get(c.ns, b.p)) !== b.h) return reply("datastale", "Transaction ETag does not match");
        this.set(c.ns, b.p, b.d ?? null);
        return reply("ok", "");
      }
      case "m": this.update(c.ns, b.p, b.d ?? {}); return reply("ok", "");
      case "o": c.onDisconnect.push({ action: "p", path: b.p, data: b.d ?? null }); return reply("ok");
      case "om": c.onDisconnect.push({ action: "m", path: b.p, data: b.d ?? {} }); return reply("ok");
      case "oc": c.onDisconnect = c.onDisconnect.filter((o) => !splitPath(o.path).join("/").startsWith(splitPath(b.p).join("/"))); return reply("ok");
      default: return reply("ok");
    }
  }

  // --- REST: /path.json?ns=... -----------------------------------------------------------
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (!url.pathname.endsWith(".json") || url.pathname.startsWith("/v")) return false;
    const ns = url.searchParams.get("ns") ?? this.defaultNs;
    const path = decodeURIComponent(url.pathname.slice(0, -".json".length));
    void bearer(req);
    const body = req.method === "GET" || req.method === "DELETE" ? undefined : (await readBody(req)).toString("utf8");
    const parsed = body ? (JSON.parse(body) as Json) : null;
    switch (req.method) {
      case "GET": {
        const q: QueryParams = {};
        const orderBy = url.searchParams.get("orderBy");
        if (orderBy) q.i = JSON.parse(orderBy) === "$key" ? ".key" : JSON.parse(orderBy) === "$value" ? ".value" : JSON.parse(orderBy);
        if (url.searchParams.has("startAt")) q.sp = JSON.parse(url.searchParams.get("startAt")!);
        if (url.searchParams.has("endAt")) q.ep = JSON.parse(url.searchParams.get("endAt")!);
        if (url.searchParams.has("limitToFirst")) q.l = Number(url.searchParams.get("limitToFirst"));
        if (url.searchParams.has("limitToLast")) { q.l = Number(url.searchParams.get("limitToLast")); q.vf = "r"; }
        let v = applyQuery(this.get(ns, path), Object.keys(q).length ? q : undefined);
        if (url.searchParams.get("shallow") === "true" && v && typeof v === "object") v = Object.fromEntries(Object.keys(v).map((k) => [k, true]));
        sendJson(res, 200, v);
        return true;
      }
      case "PUT": this.set(ns, path, parsed); sendJson(res, 200, this.get(ns, path)); return true;
      case "PATCH": this.update(ns, path, (parsed ?? {}) as Record<string, Json>); sendJson(res, 200, parsed); return true;
      case "POST": {
        const key = pushId();
        this.set(ns, `${path}/${key}`, parsed);
        sendJson(res, 200, { name: key });
        return true;
      }
      case "DELETE": this.set(ns, path, null); sendJson(res, 200, null); return true;
    }
    return false;
  }
}

const PUSH_CHARS = "-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz";
export function pushId(now = Date.now()): string {
  let t = "";
  for (let i = 0; i < 8; i++) { t = PUSH_CHARS[now % 64] + t; now = Math.floor(now / 64); }
  for (const b of randomBytes(12)) t += PUSH_CHARS[b % 64];
  return t;
}
