// Cloud Storage for Firebase (v0 REST API used by the web SDK): multipart and resumable uploads,
// metadata, download URLs with tokens, listing and delete. See docs/protocol/storage.md.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Store } from "../util/db.js";
import { readBody, sendJson } from "../util/http.js";

export interface ObjectMeta {
  name: string; bucket: string; generation: string; metageneration: string; contentType: string;
  timeCreated: string; updated: string; storageClass: string; size: string; md5Hash: string;
  crc32c: string; etag: string; downloadTokens: string; contentEncoding: string; contentDisposition: string;
  cacheControl?: string; contentLanguage?: string; metadata: Record<string, string>;
}

interface Upload { bucket: string; name: string; meta: Record<string, any>; chunks: Buffer[]; size: number }

function crc32c(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const b of buf) {
    crc ^= b;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0x82f63b78 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const err = (res: ServerResponse, code: number, message: string) => sendJson(res, code, { error: { code, message } });

export class StorageService {
  readonly objects = new Map<string, ObjectMeta>();
  private uploads = new Map<string, Upload>();

  constructor(private store?: Store) {
    for (const [k, m] of store?.all<ObjectMeta>("storage") ?? []) this.objects.set(k, m);
  }

  private key(bucket: string, name: string) { return `${bucket}/${name}`; }

  put(bucket: string, name: string, data: Buffer, meta: Record<string, any> = {}): ObjectMeta {
    const now = new Date().toISOString();
    const prev = this.objects.get(this.key(bucket, name));
    const m: ObjectMeta = {
      name, bucket, generation: String(Date.now() * 1000 + Math.floor(Math.random() * 1000)), metageneration: "1",
      contentType: meta.contentType ?? "application/octet-stream", timeCreated: now, updated: now, storageClass: "STANDARD",
      size: String(data.length), md5Hash: createHash("md5").update(data).digest("base64"), crc32c: String(crc32c(data)),
      etag: randomBytes(20).toString("base64url"), downloadTokens: prev?.downloadTokens ?? randomUUID(),
      contentEncoding: meta.contentEncoding ?? "identity", contentDisposition: meta.contentDisposition ?? "inline",
      ...(meta.cacheControl ? { cacheControl: meta.cacheControl } : {}),
      ...(meta.contentLanguage ? { contentLanguage: meta.contentLanguage } : {}),
      metadata: meta.metadata ?? {},
    };
    this.objects.set(this.key(bucket, name), m);
    this.store?.put("storage", this.key(bucket, name), m);
    this.store?.putBlob(this.key(bucket, name), data);
    return m;
  }

  read(bucket: string, name: string): Buffer | undefined {
    return this.store?.getBlob(this.key(bucket, name));
  }

  remove(bucket: string, name: string): boolean {
    const k = this.key(bucket, name);
    if (!this.objects.delete(k)) return false;
    this.store?.delete("storage", k);
    this.store?.deleteBlob(k);
    return true;
  }

  list(bucket: string, prefix = "", delimiter?: string) {
    const items: { name: string; bucket: string }[] = [];
    const prefixes = new Set<string>();
    for (const m of this.objects.values()) {
      if (m.bucket !== bucket || !m.name.startsWith(prefix)) continue;
      const rest = m.name.slice(prefix.length);
      const i = delimiter ? rest.indexOf(delimiter) : -1;
      if (i >= 0) prefixes.add(prefix + rest.slice(0, i + 1));
      else items.push({ name: m.name, bucket });
    }
    items.sort((a, b) => a.name.localeCompare(b.name));
    return { prefixes: [...prefixes].sort(), items };
  }

  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const m = /^\/v0\/b\/([^/]+)\/o(?:\/(.+))?$/.exec(url.pathname);
    if (!m) return false;
    const bucket = decodeURIComponent(m[1]);
    const objName = m[2] ? decodeURIComponent(m[2]) : undefined;
    const method = req.method ?? "GET";
    if (method === "POST" && !objName) {
      await this.upload(req, res, url, bucket);
      return true;
    }
    if (!objName && method === "GET") {
      const out = this.list(bucket, url.searchParams.get("prefix") ?? "", url.searchParams.get("delimiter") ?? undefined);
      const max = Number(url.searchParams.get("maxResults") ?? 0);
      const start = Number(url.searchParams.get("pageToken") ?? 0);
      if (max) {
        const page = out.items.slice(start, start + max);
        sendJson(res, 200, { prefixes: out.prefixes, items: page, ...(start + max < out.items.length ? { nextPageToken: String(start + max) } : {}) });
      } else sendJson(res, 200, out);
      return true;
    }
    if (!objName) return false;
    const meta = this.objects.get(this.key(bucket, objName));
    if (method === "GET") {
      if (!meta) return err(res, 404, "Not Found."), true;
      if (url.searchParams.get("alt") === "media") {
        const data = this.read(bucket, objName) ?? Buffer.alloc(0);
        res.writeHead(200, { "content-type": meta.contentType, "content-length": data.length, "content-disposition": meta.contentDisposition, ...(meta.cacheControl ? { "cache-control": meta.cacheControl } : {}) });
        res.end(data);
      } else sendJson(res, 200, meta);
      return true;
    }
    if (method === "DELETE") {
      if (!this.remove(bucket, objName)) return err(res, 404, "Not Found."), true;
      res.writeHead(204); res.end();
      return true;
    }
    if (method === "PATCH" || method === "PUT") {
      if (!meta) return err(res, 404, "Not Found."), true;
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      for (const k of ["contentType", "cacheControl", "contentDisposition", "contentEncoding", "contentLanguage"] as const) {
        if (k in body) { if (body[k] === null) delete (meta as any)[k]; else (meta as any)[k] = body[k]; }
      }
      if (body.metadata !== undefined) {
        meta.metadata = { ...meta.metadata, ...body.metadata };
        for (const [k, v] of Object.entries(body.metadata ?? {})) if (v === null) delete meta.metadata[k];
      }
      meta.metageneration = String(Number(meta.metageneration) + 1);
      meta.updated = new Date().toISOString();
      this.store?.put("storage", this.key(bucket, objName), meta);
      sendJson(res, 200, meta);
      return true;
    }
    return false;
  }

  private async upload(req: IncomingMessage, res: ServerResponse, url: URL, bucket: string) {
    const protocol = String(req.headers["x-goog-upload-protocol"] ?? "");
    const command = String(req.headers["x-goog-upload-command"] ?? "");
    const uploadId = url.searchParams.get("upload_id");
    const body = await readBody(req);
    if (uploadId) {
      const up = this.uploads.get(uploadId);
      if (!up) return err(res, 404, "Upload not found");
      if (command.includes("cancel")) { this.uploads.delete(uploadId); res.writeHead(200, { "x-goog-upload-status": "cancelled" }); res.end(); return; }
      if (command.includes("query")) {
        res.writeHead(200, { "x-goog-upload-status": "active", "x-goog-upload-size-received": String(up.size) });
        res.end();
        return;
      }
      if (command.includes("upload")) { up.chunks.push(body); up.size += body.length; }
      if (command.includes("finalize")) {
        this.uploads.delete(uploadId);
        const meta = this.put(bucket, up.name, Buffer.concat(up.chunks), up.meta);
        sendJson(res, 200, meta, { "x-goog-upload-status": "final" });
        return;
      }
      res.writeHead(200, { "x-goog-upload-status": "active", "x-goog-upload-size-received": String(up.size) });
      res.end();
      return;
    }
    if (protocol === "resumable" && command.includes("start")) {
      const meta = body.length ? JSON.parse(body.toString("utf8")) : {};
      const name = url.searchParams.get("name") ?? meta.name;
      const id = randomBytes(16).toString("hex");
      this.uploads.set(id, { bucket, name, meta: { ...meta, contentType: meta.contentType ?? req.headers["x-goog-upload-header-content-type"] }, chunks: [], size: 0 });
      const host = req.headers.host ?? "localhost";
      const uploadUrl = `http://${host}/v0/b/${encodeURIComponent(bucket)}/o?name=${encodeURIComponent(name)}&upload_id=${id}&upload_protocol=resumable`;
      res.writeHead(200, { "x-goog-upload-status": "active", "x-goog-upload-url": uploadUrl, "x-goog-upload-chunk-granularity": "262144" });
      res.end();
      return;
    }
    if (protocol === "multipart") {
      const ct = String(req.headers["content-type"] ?? "");
      const boundary = /boundary=([^;]+)/.exec(ct)?.[1];
      if (!boundary) return err(res, 400, "Missing multipart boundary");
      const parts = splitMultipart(body, boundary);
      const meta = JSON.parse(parts[0]?.body.toString("utf8") || "{}");
      const contentType = meta.contentType ?? parts[1]?.headers["content-type"];
      const name = url.searchParams.get("name") ?? meta.name;
      sendJson(res, 200, this.put(bucket, name, parts[1]?.body ?? Buffer.alloc(0), { ...meta, contentType }));
      return;
    }
    const name = url.searchParams.get("name");
    if (!name) return err(res, 400, "Missing object name");
    sendJson(res, 200, this.put(bucket, name, body, { contentType: req.headers["content-type"] }));
  }
}

function splitMultipart(body: Buffer, boundary: string): { headers: Record<string, string>; body: Buffer }[] {
  const delim = Buffer.from(`--${boundary}`);
  const out: { headers: Record<string, string>; body: Buffer }[] = [];
  let pos = body.indexOf(delim);
  while (pos >= 0) {
    const start = pos + delim.length;
    if (body.subarray(start, start + 2).toString() === "--") break;
    const next = body.indexOf(delim, start);
    if (next < 0) break;
    const part = body.subarray(start + 2, next - 2); // strip leading CRLF and trailing CRLF
    const sep = part.indexOf("\r\n\r\n");
    const headers: Record<string, string> = {};
    for (const line of part.subarray(0, sep).toString("utf8").split("\r\n")) {
      const i = line.indexOf(":");
      if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
    out.push({ headers, body: part.subarray(sep + 4) });
    pos = next;
  }
  return out;
}
