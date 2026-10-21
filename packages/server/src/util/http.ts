// Small HTTP helpers shared by the REST surfaces.
import type { IncomingMessage, ServerResponse } from "node:http";

export async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

export function parseJsonOrForm(buf: Buffer, contentType = ""): Record<string, any> {
  const text = buf.toString("utf8");
  if (!text) return {};
  if (contentType.includes("application/x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(text));
  try {
    return JSON.parse(text);
  } catch {
    return Object.fromEntries(new URLSearchParams(text));
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  res.end(data);
}

export function cors(req: IncomingMessage, res: ServerResponse): void {
  res.setHeader("access-control-allow-origin", (req.headers.origin as string) || "*");
  res.setHeader("access-control-allow-credentials", "true");
  res.setHeader("access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader("access-control-allow-headers", (req.headers["access-control-request-headers"] as string) || "*");
  res.setHeader("access-control-expose-headers", "x-goog-upload-url,x-goog-upload-status,x-goog-upload-size-received,x-goog-upload-chunk-granularity,x-goog-upload-control-url,x-http-session-id,content-type,content-length");
  res.setHeader("access-control-max-age", "3600");
  // Lets the hosted dashboard (https) reach a server on localhost under Private Network Access.
  if (req.headers["access-control-request-private-network"]) res.setHeader("access-control-allow-private-network", "true");
}

export function bearer(req: IncomingMessage): string | undefined {
  const h = req.headers.authorization;
  if (!h) return undefined;
  const m = /^(?:Bearer|Firebase)\s+(.+)$/i.exec(h);
  return m ? m[1] : undefined;
}
