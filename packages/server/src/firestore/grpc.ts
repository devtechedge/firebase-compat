// gRPC transport for google.firestore.v1.Firestore, used by the Firebase JS SDK in Node.js and by
// the Admin SDK. Messages are converted between protobufjs objects and the proto3 JSON form that
// the engine uses internally.
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { AuthService } from "../auth/service.js";
import { RpcError } from "../util/status.js";
import { accessFromToken } from "./context.js";
import type { AccessContext, FirestoreEngine } from "./engine.js";
import { formatTimestamp, parseTimestamp } from "./values.js";
import { WatchSession } from "./watch.js";
import { WriteSession } from "./writestream.js";

const TIMESTAMP_KEYS = new Set(["readTime", "updateTime", "createTime", "commitTime", "timestampValue", "expireTime"]);

/** protobufjs object -> proto3 JSON shape. */
export function fromGrpc(x: any, key = ""): any {
  if (x === null || x === undefined) return x;
  if (Buffer.isBuffer(x) || x instanceof Uint8Array) return Buffer.from(x).toString("base64");
  if (Array.isArray(x)) return x.map((v) => fromGrpc(v));
  if (typeof x !== "object") return x;
  if (TIMESTAMP_KEYS.has(key) && "seconds" in x) return formatTimestamp(Number(x.seconds ?? 0), Number(x.nanos ?? 0));
  const out: any = {};
  for (const [k, v] of Object.entries(x)) {
    // protobufjs adds a virtual property per oneof whose value names the populated member.
    if (typeof v === "string" && v !== k && Object.prototype.hasOwnProperty.call(x, v) && /Type$|Selector$|^operation$|^operator$|^result$|^consistency/.test(k)) continue;
    if (k === "nullValue") { out[k] = null; continue; }
    if (k === "limit" && v && typeof v === "object" && "value" in (v as object)) { out[k] = (v as { value: number }).value; continue; }
    out[k] = fromGrpc(v, k);
  }
  return out;
}

/** proto3 JSON shape -> object accepted by protobufjs fromObject. */
export function toGrpc(x: any, key = ""): any {
  if (x === null || x === undefined) return key === "nullValue" ? 0 : x;
  if (Array.isArray(x)) return x.map((v) => toGrpc(v));
  if (TIMESTAMP_KEYS.has(key) && typeof x === "string") {
    const [seconds, nanos] = parseTimestamp(x);
    return { seconds: String(seconds), nanos };
  }
  if (typeof x !== "object") return x;
  const out: any = {};
  for (const [k, v] of Object.entries(x)) out[k] = toGrpc(v, k);
  return out;
}

const here = dirname(fileURLToPath(import.meta.url));

export function loadFirestoreService() {
  const protoRoot = join(here, "..", "..", "protos");
  const def = protoLoader.loadSync("google/firestore/v1/firestore.proto", {
    includeDirs: [protoRoot], keepCase: false, longs: String, enums: String, defaults: false, oneofs: true,
  });
  const pkg = grpc.loadPackageDefinition(def) as any;
  return pkg.google.firestore.v1.Firestore.service as grpc.ServiceDefinition;
}

function ctxOf(auth: AuthService, md: grpc.Metadata): AccessContext {
  const h = String(md.get("authorization")[0] ?? "");
  const token = h.replace(/^Bearer\s+/i, "") || undefined;
  return accessFromToken(auth, token);
}

function toStatus(e: unknown): grpc.ServiceError {
  const err = e instanceof RpcError ? e : new RpcError("INTERNAL", String((e as Error)?.stack ?? e));
  return Object.assign(new Error(err.message), { code: err.code, details: err.message, metadata: new grpc.Metadata() }) as grpc.ServiceError;
}

export function createGrpcServer(engine: FirestoreEngine, auth: AuthService): grpc.Server {
  const server = new grpc.Server({ "grpc.max_receive_message_length": 64 * 1024 * 1024 });
  const unary = (fn: (req: any, ctx: AccessContext) => any) => (call: grpc.ServerUnaryCall<any, any>, cb: grpc.sendUnaryData<any>) => {
    try { cb(null, toGrpc(fn(fromGrpc(call.request), ctxOf(auth, call.metadata)))); } catch (e) { cb(toStatus(e)); }
  };
  const stream = (fn: (req: any, ctx: AccessContext) => any[]) => (call: grpc.ServerWritableStream<any, any>) => {
    try {
      for (const m of fn(fromGrpc(call.request), ctxOf(auth, call.metadata))) call.write(toGrpc(m));
      call.end();
    } catch (e) { call.destroy(toStatus(e)); }
  };
  const impl: grpc.UntypedServiceImplementation = {
    GetDocument: unary((r, ctx) => {
      const d = engine.checkRead(r.name, ctx);
      if (!d) throw new RpcError("NOT_FOUND", `Document "${r.name}" not found.`);
      return d;
    }),
    Commit: unary((r, ctx) => engine.commit(r.writes ?? [], ctx, r.transaction)),
    BeginTransaction: unary((r) => ({ transaction: engine.beginTransaction(!!r.options?.readOnly) })),
    Rollback: unary((r) => { engine.rollback(r.transaction); return {}; }),
    ListCollectionIds: unary((r) => ({ collectionIds: engine.listCollectionIds(r.parent) })),
    ListDocuments: unary((r, ctx) => ({ documents: engine.query(r.parent, { from: [{ collectionId: r.collectionId }] }, ctx) })),
    DeleteDocument: unary((r, ctx) => { engine.commit([{ delete: r.name, currentDocument: r.currentDocument }], ctx); return {}; }),
    BatchWrite: unary((r, ctx) => {
      const writeResults: unknown[] = [];
      const status: unknown[] = [];
      for (const w of r.writes ?? []) {
        try { writeResults.push(engine.commit([w], ctx).writeResults[0]); status.push({ code: 0 }); }
        catch (e) { const err = e as RpcError; writeResults.push({}); status.push({ code: err.code, message: err.message }); }
      }
      return { writeResults, status };
    }),
    BatchGetDocuments: stream((r, ctx) => {
      const tx = r.newTransaction ? engine.beginTransaction() : undefined;
      const readTime = engine.clock.now();
      return (r.documents ?? []).map((name: string, i: number) => {
        const d = engine.checkRead(name, ctx);
        return { ...(d ? { found: d } : { missing: name }), readTime, ...(tx && i === 0 ? { transaction: tx } : {}) };
      });
    }),
    RunQuery: stream((r, ctx) => {
      const tx = r.newTransaction ? engine.beginTransaction() : undefined;
      const docs = engine.query(r.parent, r.structuredQuery ?? {}, ctx);
      const readTime = engine.clock.now();
      const rows: any[] = docs.map((document) => ({ document, readTime }));
      if (!rows.length) rows.push({ readTime });
      if (tx) rows[0].transaction = tx;
      rows[rows.length - 1].done = true;
      return rows;
    }),
    RunAggregationQuery: stream((r, ctx) => {
      const saq = r.structuredAggregationQuery ?? {};
      return [{ result: { aggregateFields: engine.aggregate(r.parent, saq.structuredQuery ?? {}, saq.aggregations ?? [], ctx) }, readTime: engine.clock.now() }];
    }),
    Listen: (call: grpc.ServerDuplexStream<any, any>) => {
      const ctx = ctxOf(auth, call.metadata);
      const watch = new WatchSession(engine, () => ctx, (m) => { if (!call.writableEnded && !call.destroyed) call.write(toGrpc(m)); });
      call.on("data", (req) => { try { watch.handle(fromGrpc(req)); } catch (e) { call.destroy(toStatus(e)); } });
      call.on("end", () => { watch.close(); call.end(); });
      call.on("error", () => watch.close());
      call.on("cancelled", () => watch.close());
    },
    Write: (call: grpc.ServerDuplexStream<any, any>) => {
      const ctx = ctxOf(auth, call.metadata);
      const ws = new WriteSession(engine, () => ctx);
      call.on("data", (req) => {
        try { call.write(toGrpc(ws.handle(fromGrpc(req)))); } catch (e) { call.destroy(toStatus(e)); }
      });
      call.on("end", () => call.end());
      call.on("error", () => {});
    },
  };
  for (const name of ["CreateDocument", "UpdateDocument", "PartitionQuery", "ExecutePipeline"]) {
    impl[name] = (_c: unknown, cb: grpc.sendUnaryData<unknown>) => cb(toStatus(new RpcError("UNIMPLEMENTED", `${name} is not implemented`)));
  }
  impl.CreateDocument = unary((r, ctx) => {
    const name = `${r.parent}/${r.collectionId}/${r.documentId || engine.newDocumentId()}`;
    engine.commit([{ update: { name, fields: r.document?.fields ?? {} }, currentDocument: { exists: false } }], ctx);
    return engine.get(name);
  });
  impl.UpdateDocument = unary((r, ctx) => {
    engine.commit([{ update: r.document, updateMask: r.updateMask, currentDocument: r.currentDocument }], ctx);
    return engine.get(r.document.name);
  });
  server.addService(loadFirestoreService(), impl);
  return server;
}
