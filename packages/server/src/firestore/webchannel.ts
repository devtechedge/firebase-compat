// Server side of the WebChannel (BrowserChannel v8) transport that the Firestore web SDK uses
// for its Listen and Write streams. Derived from recorded SDK traffic, see
// evidence/raw/emulator-firestore.har and docs/protocol/firestore-webchannel.md.
//
//   POST  .../channel?VER=8&RID=n            open session, body carries reqN___data__
//   GET   .../channel?RID=rpc&SID=s&AID=a    streaming backchannel (length prefixed chunks)
//   POST  .../channel?SID=s&RID=n&AID=a      forward channel with more requests
//   *     .../channel?SID=s&TYPE=terminate   close session
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthService } from "../auth/service.js";
import { readBody } from "../util/http.js";
import { RpcError } from "../util/status.js";
import { accessFromToken } from "./context.js";
import type { AccessContext, FirestoreEngine } from "./engine.js";
import { WatchSession } from "./watch.js";
import { WriteSession } from "./writestream.js";

interface Session {
  id: string;
  kind: "Listen" | "Write";
  nextArrayId: number;
  queue: [number, unknown][];
  acked: number;
  sentUpTo: number;
  back?: ServerResponse;
  backBuffered?: boolean;
  nextReq: number;
  ctx: AccessContext;
  handle: (msg: any) => void;
  close: () => void;
  closed: boolean;
  lastSeen: number;
}

function frame(arrays: [number, unknown][]): string {
  const payload = JSON.stringify(arrays);
  return `${payload.length}\n${payload}`;
}

export class WebChannelServer {
  private sessions = new Map<string, Session>();
  private timer: NodeJS.Timeout;

  constructor(private engine: FirestoreEngine, private auth: AuthService) {
    this.timer = setInterval(() => this.keepAlive(), 15000);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
    for (const s of this.sessions.values()) this.closeSession(s);
  }

  get sessionCount() { return this.sessions.size; }

  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const m = /^\/google\.firestore\.v1\.Firestore\/(Listen|Write)\/channel$/.exec(url.pathname);
    if (!m) return false;
    const q = url.searchParams;
    const sid = q.get("SID");
    if (q.get("TYPE") === "terminate") {
      const s = sid ? this.sessions.get(sid) : undefined;
      if (s) this.closeSession(s);
      res.writeHead(200, { "content-type": "text/plain" });
      res.end();
      return true;
    }
    if (req.method === "GET") {
      const s = sid ? this.sessions.get(sid) : undefined;
      if (!s || s.closed) return this.unknownSid(res), true;
      this.attachBackchannel(s, res, Number(q.get("AID") ?? 0), q.get("CI") === "1" || q.get("TYPE") === "html");
      return true;
    }
    const form = new URLSearchParams((await readBody(req)).toString("utf8"));
    if (!sid) {
      const s = this.openSession(m[1] as "Listen" | "Write", form);
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "x-http-session-id": s.id.slice(0, 8), "cache-control": "no-cache, no-store" });
      res.end(frame([[0, ["c", s.id, "", 8, 12, 30000]]]));
      this.processForm(s, form);
      return true;
    }
    const s = this.sessions.get(sid);
    if (!s || s.closed) return this.unknownSid(res), true;
    s.acked = Math.max(s.acked, Number(q.get("AID") ?? s.acked));
    s.queue = s.queue.filter(([id]) => id > s.acked);
    this.processForm(s, form);
    const outstanding = s.queue.reduce((n, [, m]) => n + JSON.stringify(m).length, 0);
    const body = JSON.stringify([s.back ? 1 : 0, s.nextArrayId - 1, outstanding]);
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-cache, no-store" });
    res.end(`${body.length}\n${body}`);
    return true;
  }

  private unknownSid(res: ServerResponse) {
    res.writeHead(400, { "content-type": "text/plain" });
    res.end("Unknown SID");
  }

  private openSession(kind: "Listen" | "Write", form: URLSearchParams): Session {
    const headers = parseHeaderBlock(form.get("headers") ?? "");
    const authz = headers["authorization"];
    const token = authz ? authz.replace(/^Bearer\s+/i, "") : undefined;
    const s: Session = {
      id: randomBytes(16).toString("base64url"), kind, nextArrayId: 1, queue: [], acked: 0, sentUpTo: 0, nextReq: 0,
      ctx: accessFromToken(this.auth, token), handle: () => {}, close: () => {}, closed: false, lastSeen: Date.now(),
    };
    if (kind === "Listen") {
      const watch = new WatchSession(this.engine, () => s.ctx, (msg) => this.push(s, msg));
      s.handle = (msg) => watch.handle(msg);
      s.close = () => watch.close();
    } else {
      const ws = new WriteSession(this.engine, () => s.ctx);
      s.handle = (msg) => this.push(s, ws.handle(msg));
    }
    this.sessions.set(s.id, s);
    return s;
  }

  private processForm(s: Session, form: URLSearchParams) {
    s.lastSeen = Date.now();
    const count = Number(form.get("count") ?? 0);
    const ofs = Number(form.get("ofs") ?? 0);
    for (let i = 0; i < count; i++) {
      const idx = ofs + i;
      if (idx < s.nextReq) continue; // already processed (retransmission)
      s.nextReq = idx + 1;
      const raw = form.get(`req${i}___data__`);
      if (!raw) continue;
      try {
        s.handle(JSON.parse(raw));
      } catch (e) {
        const err = e instanceof RpcError ? e : new RpcError("INTERNAL", String(e));
        this.push(s, { error: { code: err.code, message: err.message, status: err.status } });
        s.closed = true;
        s.close();
        setTimeout(() => this.closeSession(s), 2000).unref();
        return;
      }
    }
  }

  private push(s: Session, msg: unknown) {
    if (s.closed && !(msg as { error?: unknown })?.error) return;
    const entry: [number, unknown] = [s.nextArrayId++, [msg]];
    s.queue.push(entry);
    if (s.back) this.flush(s);
  }

  private attachBackchannel(s: Session, res: ServerResponse, aid: number, buffered: boolean) {
    if (s.back) s.back.end();
    s.acked = Math.max(s.acked, aid);
    s.queue = s.queue.filter(([id]) => id > s.acked);
    s.sentUpTo = s.acked;
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-cache, no-store", "x-content-type-options": "nosniff" });
    res.flushHeaders();
    s.back = res;
    s.backBuffered = buffered;
    res.on("close", () => { if (s.back === res) s.back = undefined; });
    if (s.queue.length) this.flush(s);
  }

  private flush(s: Session) {
    const res = s.back;
    if (!res || !s.queue.length) return;
    const pending = s.queue.filter(([id]) => id > s.sentUpTo);
    if (!pending.length) return;
    res.write(frame(pending));
    s.sentUpTo = pending[pending.length - 1][0];
    // Keep a bounded replay window in case the client reconnects with an older AID.
    if (s.queue.length > 2000) s.queue = s.queue.slice(-1000);
    if (s.backBuffered) { res.end(); s.back = undefined; }
  }

  private keepAlive() {
    const now = Date.now();
    for (const s of this.sessions.values()) {
      if (s.back) this.push(s, "noop");
      else if (now - s.lastSeen > 120000) this.closeSession(s);
    }
  }

  private closeSession(s: Session) {
    s.closed = true;
    s.close();
    s.back?.end();
    s.back = undefined;
    this.sessions.delete(s.id);
  }
}

function parseHeaderBlock(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of block.split(/\r\n/)) {
    const i = line.indexOf(":");
    if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}
