// Firestore v1 REST surface (used by firestore/lite, by the web SDK for transactions, and by
// tools such as curl and the dashboard).
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthService } from "../auth/service.js";
import { bearer, parseJsonOrForm, readBody, sendJson } from "../util/http.js";
import { RpcError } from "../util/status.js";
import { accessFromToken } from "./context.js";
import type { FirestoreEngine, Write } from "./engine.js";
import type { Doc } from "./query.js";

export class FirestoreRest {
  constructor(private engine: FirestoreEngine, private auth: AuthService) {}

  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const p = decodeURIComponent(url.pathname);
    if (p.startsWith("/emulator/v1/projects/") && p.endsWith("/documents") && req.method === "DELETE") {
      this.engine.clear();
      sendJson(res, 200, {});
      return true;
    }
    if (!p.startsWith("/v1/projects/") && !p.startsWith("/v1beta1/projects/")) return false;
    const resource = p.replace(/^\/v1(beta1)?\//, "");
    if (!/^projects\/[^/]+\/databases\/[^/]+\/documents/.test(resource)) return false;
    const body = req.method === "GET" || req.method === "DELETE" ? {} : parseJsonOrForm(await readBody(req), "application/json");
    const ctx = accessFromToken(this.auth, bearer(req));
    try {
      const out = this.route(req.method ?? "GET", resource, url, body, ctx);
      sendJson(res, 200, out);
    } catch (e) {
      const err = e instanceof RpcError ? e : new RpcError("INTERNAL", String((e as Error)?.stack ?? e));
      sendJson(res, err.httpStatus, err.toJSON());
    }
    return true;
  }

  private route(method: string, resource: string, url: URL, body: Record<string, any>, ctx: ReturnType<typeof accessFromToken>): unknown {
    const colon = resource.lastIndexOf(":");
    const action = colon > resource.lastIndexOf("/") ? resource.slice(colon + 1) : undefined;
    const target = action ? resource.slice(0, colon) : resource;
    const database = target.split("/documents")[0];
    const now = () => this.engine.clock.now();
    switch (action) {
      case "commit":
        return this.engine.commit(body.writes ?? [], ctx, body.transaction);
      case "beginTransaction":
        return { transaction: this.engine.beginTransaction(!!body.options?.readOnly) };
      case "rollback":
        this.engine.rollback(body.transaction);
        return {};
      case "batchGet": {
        const tx = body.newTransaction ? this.engine.beginTransaction() : undefined;
        const readTime = now();
        return (body.documents ?? []).map((name: string, i: number) => {
          const d = this.engine.checkRead(name, ctx);
          return { ...(d ? { found: d } : { missing: name }), readTime, ...(tx && i === 0 ? { transaction: tx } : {}) };
        });
      }
      case "runQuery": {
        const tx = body.newTransaction ? this.engine.beginTransaction() : undefined;
        const docs = this.engine.query(target, body.structuredQuery ?? {}, ctx);
        const readTime = now();
        const rows: Record<string, unknown>[] = docs.map((document) => ({ document, readTime }));
        if (!rows.length) rows.push({ readTime });
        if (tx) rows[0].transaction = tx;
        return rows;
      }
      case "runAggregationQuery": {
        const saq = body.structuredAggregationQuery ?? {};
        const fields = this.engine.aggregate(target, saq.structuredQuery ?? {}, saq.aggregations ?? [], ctx);
        return [{ result: { aggregateFields: fields }, readTime: now() }];
      }
      case "listCollectionIds":
        return { collectionIds: this.engine.listCollectionIds(target) };
      case "batchWrite": {
        const writeResults: unknown[] = [];
        const status: unknown[] = [];
        for (const w of (body.writes ?? []) as Write[]) {
          try {
            const r = this.engine.commit([w], ctx);
            writeResults.push(r.writeResults[0]);
            status.push({});
          } catch (e) {
            const err = e as RpcError;
            writeResults.push({});
            status.push({ code: err.code, message: err.message });
          }
        }
        return { writeResults, status };
      }
      case undefined:
        break;
      default:
        throw new RpcError("UNIMPLEMENTED", `Unsupported action ${action}`);
    }
    const rel = target.split("/documents")[1]?.replace(/^\//, "") ?? "";
    const segs = rel ? rel.split("/") : [];
    const isDoc = segs.length > 0 && segs.length % 2 === 0;
    if (method === "GET" && isDoc) {
      const d = this.engine.checkRead(target, ctx);
      if (!d) throw new RpcError("NOT_FOUND", `Document "${target}" not found.`);
      return d;
    }
    if (method === "GET") {
      const parent = segs.length > 1 ? `${database}/documents/${segs.slice(0, -1).join("/")}` : `${database}/documents`;
      const docs = this.engine.query(parent, { from: [{ collectionId: segs[segs.length - 1] }] }, ctx);
      const pageSize = Number(url.searchParams.get("pageSize") ?? 0) || docs.length;
      return { documents: docs.slice(0, pageSize) };
    }
    if (method === "POST" && !isDoc) {
      const id = url.searchParams.get("documentId") || this.engine.newDocumentId();
      const name = `${target}/${id}`;
      this.engine.commit([{ update: { name, fields: body.fields ?? {} }, currentDocument: { exists: false } }], ctx);
      return this.engine.get(name) as Doc;
    }
    if (method === "PATCH" && isDoc) {
      const mask = url.searchParams.getAll("updateMask.fieldPaths");
      const exists = url.searchParams.get("currentDocument.exists");
      const w: Write = { update: { name: target, fields: body.fields ?? {} } };
      if (mask.length) w.updateMask = { fieldPaths: mask };
      if (exists !== null) w.currentDocument = { exists: exists === "true" };
      this.engine.commit([w], ctx);
      return this.engine.get(target);
    }
    if (method === "DELETE" && isDoc) {
      this.engine.commit([{ delete: target }], ctx);
      return {};
    }
    throw new RpcError("INVALID_ARGUMENT", `Unsupported request ${method} ${resource}`);
  }
}
