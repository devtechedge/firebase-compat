// JSON admin API used by the dashboard (and handy for scripts). Mounted under /__admin.
// Protected by ADMIN_TOKEN when it is set; otherwise open, like the official emulators.
import type { IncomingMessage, ServerResponse } from "node:http";
import { readBody, sendJson, bearer } from "../util/http.js";
import { fromPlain, toPlain } from "../firestore/values.js";
import { RulesEngine } from "../rules/index.js";
import type { FirebaseCompatServer } from "../server.js";

export class AdminApi {
  constructor(private s: FirebaseCompatServer, private token?: string) {}

  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const p = url.pathname;
    // Emulator-compatible reset endpoints.
    if (req.method === "DELETE" && /^\/emulator\/v1\/projects\/[^/]+\/accounts$/.test(p)) { this.s.auth.clear(); sendJson(res, 200, {}); return true; }
    if (!p.startsWith("/__admin/")) return false;
    if (this.token && bearer(req) !== this.token) { sendJson(res, 401, { error: "unauthorized" }); return true; }
    const route = p.slice("/__admin/".length);
    const body = req.method === "GET" || req.method === "DELETE" ? {} : JSON.parse((await readBody(req)).toString("utf8") || "{}");
    const fsRoot = `projects/${this.s.projectId}/databases/(default)/documents`;
    const s = this.s;
    let m: RegExpExecArray | null;
    try {
      if (route === "stats") return this.ok(res, {
        projectId: s.projectId, users: s.auth.users.size, documents: s.firestore.docs.size,
        objects: s.storage.objects.size, rtdbConnections: s.database.connectionCount, webchannelSessions: s.webchannel.sessionCount,
        uptimeSeconds: Math.round(process.uptime()),
      });
      if (route === "users" && req.method === "GET") return this.ok(res, { users: [...s.auth.users.values()].map(({ passwordHash, salt, ...u }) => u) });
      if (route === "users" && req.method === "POST") return this.ok(res, s.auth.signUp(body, true));
      if ((m = /^users\/([^/]+)$/.exec(route))) {
        if (req.method === "DELETE") return this.ok(res, s.auth.delete({ localId: m[1] }, true));
        if (req.method === "PATCH") return this.ok(res, s.auth.update({ ...body, localId: m[1] }, true));
      }
      if (route === "firestore/collections") {
        const parent = url.searchParams.get("parent");
        return this.ok(res, { collections: s.firestore.listCollectionIds(parent ? `${fsRoot}/${parent}` : fsRoot) });
      }
      if (route === "firestore/documents" && req.method === "GET") {
        const col = url.searchParams.get("collection") ?? "";
        const segs = col.split("/");
        const parent = segs.length > 1 ? `${fsRoot}/${segs.slice(0, -1).join("/")}` : fsRoot;
        const docs = s.firestore.query(parent, { from: [{ collectionId: segs[segs.length - 1] }] }, { auth: null, admin: true });
        return this.ok(res, { documents: docs.map((d) => ({ path: d.name.slice(fsRoot.length + 1), id: d.name.split("/").pop(), data: toPlain({ mapValue: { fields: d.fields } }), createTime: d.createTime, updateTime: d.updateTime })) });
      }
      if (route === "firestore/document") {
        const path = url.searchParams.get("path") ?? "";
        const name = `${fsRoot}/${path}`;
        if (req.method === "DELETE") return this.ok(res, s.firestore.commit([{ delete: name }], { auth: null, admin: true }));
        if (req.method === "PUT") return this.ok(res, s.firestore.commit([{ update: { name, fields: fromPlain(body).mapValue?.fields ?? {} } }], { auth: null, admin: true }));
      }
      if (route === "firestore/rules") {
        if (req.method === "GET") return this.ok(res, { source: s.rulesSource });
        if (req.method === "PUT") { new RulesEngine(body.source); s.setRules(body.source); return this.ok(res, { ok: true }); }
      }
      if (route === "database") {
        const path = url.searchParams.get("path") ?? "/";
        const ns = url.searchParams.get("ns") ?? s.projectId;
        if (req.method === "GET") return this.ok(res, { value: s.database.get(ns, path), namespaces: s.database.namespaces() });
        if (req.method === "PUT") { s.database.set(ns, path, body.value ?? null); return this.ok(res, { ok: true }); }
        if (req.method === "DELETE") { s.database.set(ns, path, null); return this.ok(res, { ok: true }); }
      }
      if (route === "storage") {
        if (req.method === "GET") return this.ok(res, { objects: [...s.storage.objects.values()] });
        if (req.method === "DELETE") return this.ok(res, { deleted: s.storage.remove(url.searchParams.get("bucket")!, url.searchParams.get("name")!) });
      }
      if (route === "reset" && req.method === "POST") {
        s.auth.clear(); s.firestore.clear(); for (const ns of s.database.namespaces()) s.database.clear(ns);
        for (const o of [...s.storage.objects.values()]) s.storage.remove(o.bucket, o.name);
        return this.ok(res, { ok: true });
      }
    } catch (e) {
      sendJson(res, 400, { error: String((e as Error).message ?? e) });
      return true;
    }
    sendJson(res, 404, { error: `unknown admin route ${route}` });
    return true;
  }

  private ok(res: ServerResponse, body: unknown) { sendJson(res, 200, body); return true; }
}
