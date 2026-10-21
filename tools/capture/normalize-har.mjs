// Fill in HAR 1.2 required fields so strict validators (such as REA) accept recorder output.
// Usage: node normalize-har.mjs <in.har> <out.har>
import { readFileSync, writeFileSync } from "node:fs";
const [inp, out] = process.argv.slice(2);
const har = JSON.parse(readFileSync(inp, "utf8"));
har.log.pages ??= [];
for (const e of har.log.entries) {
  e.cache ??= {};
  e.timings ??= { send: 0, wait: e.time ?? 0, receive: 0 };
  e.time ??= 0;
  const u = new URL(e.request.url);
  Object.assign(e.request, { httpVersion: e.request.httpVersion ?? "HTTP/1.1", cookies: [], headers: e.request.headers ?? [], queryString: [...u.searchParams].map(([name, value]) => ({ name, value })), headersSize: -1, bodySize: e.request.postData ? Buffer.byteLength(e.request.postData.text) : 0 });
  if (!e.request.postData) delete e.request.postData;
  const c = e.response.content ?? {};
  e.response = { status: e.response.status, statusText: "", httpVersion: "HTTP/1.1", cookies: [], headers: e.response.headers ?? [], content: { size: Buffer.byteLength(c.text ?? ""), mimeType: c.mimeType ?? "", text: c.text ?? "" }, redirectURL: "", headersSize: -1, bodySize: Buffer.byteLength(c.text ?? "") };
}
writeFileSync(out, JSON.stringify(har, null, 1));
