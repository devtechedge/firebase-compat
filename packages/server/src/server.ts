// firebase-compat server: one port that speaks every protocol the Firebase JS SDK uses.
// HTTP/1.1 requests are routed by path (Auth, Firestore REST + WebChannel, Realtime Database,
// Storage, admin API) while HTTP/2 connections (gRPC from the Node.js SDK) are detected by the
// connection preface and handed to an internal gRPC server.
import http from "node:http";
import net from "node:net";
import * as grpc from "@grpc/grpc-js";
import { AuthService } from "./auth/service.js";
import { FirestoreEngine } from "./firestore/engine.js";
import { createGrpcServer } from "./firestore/grpc.js";
import { FirestoreRest } from "./firestore/rest.js";
import { WebChannelServer } from "./firestore/webchannel.js";
import { Store } from "./util/db.js";
import { cors, sendJson } from "./util/http.js";
import { RpcError } from "./util/status.js";

export interface ServerOptions {
  port?: number;
  host?: string;
  projectId?: string;
  /** SQLite file path, or ":memory:" (default). */
  dataFile?: string;
  quiet?: boolean;
}

export interface Handler { handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> }

export class FirebaseCompatServer {
  readonly store: Store;
  readonly auth: AuthService;
  readonly firestore: FirestoreEngine;
  readonly webchannel: WebChannelServer;
  readonly handlers: Handler[] = [];
  private http: http.Server;
  private tcp: net.Server;
  private grpc: grpc.Server;
  private grpcPort = 0;
  readonly projectId: string;
  port = 0;

  constructor(readonly options: ServerOptions = {}) {
    this.projectId = options.projectId ?? "demo-project";
    this.store = new Store(options.dataFile ?? ":memory:");
    this.auth = new AuthService(this.store, this.projectId);
    this.firestore = new FirestoreEngine(this.store, this.projectId);
    this.webchannel = new WebChannelServer(this.firestore, this.auth);
    this.handlers.push(this.auth, this.webchannel, new FirestoreRest(this.firestore, this.auth));
    this.grpc = createGrpcServer(this.firestore, this.auth);
    this.http = http.createServer((req, res) => void this.route(req, res));
    this.http.keepAliveTimeout = 65000;
    this.tcp = net.createServer((sock) => this.demux(sock));
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse) {
    cors(req, res);
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname === "/" || url.pathname === "/healthz") {
        sendJson(res, 200, { name: "firebase-compat", ok: true, projectId: this.projectId });
        return;
      }
      for (const h of this.handlers) if (await h.handle(req, res, url)) return;
      sendJson(res, 404, { error: { code: 404, message: `Not found: ${url.pathname}`, status: "NOT_FOUND" } });
    } catch (e) {
      if (!this.options.quiet) console.error(e);
      const err = e instanceof RpcError ? e : new RpcError("INTERNAL", String(e));
      if (!res.headersSent) sendJson(res, err.httpStatus, err.toJSON());
      else res.end();
    }
  }

  private demux(sock: net.Socket) {
    sock.once("data", (buf: Buffer) => {
      sock.pause();
      if (buf.subarray(0, 4).toString() === "PRI ") {
        const up = net.connect(this.grpcPort, "127.0.0.1", () => {
          up.write(buf);
          sock.pipe(up).pipe(sock);
          sock.resume();
        });
        const kill = () => { sock.destroy(); up.destroy(); };
        up.on("error", kill); sock.on("error", kill); up.on("close", kill); sock.on("close", kill);
      } else {
        sock.unshift(buf);
        this.http.emit("connection", sock);
        sock.resume();
      }
    });
    sock.on("error", () => {});
  }

  async start(): Promise<number> {
    this.grpcPort = await new Promise<number>((resolve, reject) =>
      this.grpc.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (err, port) => (err ? reject(err) : resolve(port))));
    await new Promise<void>((resolve) => this.tcp.listen(this.options.port ?? 8787, this.options.host ?? "0.0.0.0", resolve));
    this.port = (this.tcp.address() as net.AddressInfo).port;
    return this.port;
  }

  async stop(): Promise<void> {
    this.webchannel.stop();
    this.grpc.forceShutdown();
    this.http.closeAllConnections();
    await new Promise<void>((r) => this.tcp.close(() => r()));
    this.store.close();
  }
}
