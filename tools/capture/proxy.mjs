// Recording reverse proxy: forwards HTTP and WebSocket traffic to an upstream and writes a HAR 1.2
// file that includes streamed response chunks (with timings) and WebSocket frames.
// Usage: node proxy.mjs <listenPort> <upstreamPort> <out.har>
import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { writeFileSync } from "node:fs";

const [listen, upstream, out] = process.argv.slice(2);
const entries = [];
const flush = () => writeFileSync(out, JSON.stringify({ log: { version: "1.2", creator: { name: "firebase-compat-recorder", version: "0.1.0" }, entries } }, null, 1));
const hdrs = (h) => Object.entries(h).map(([name, value]) => ({ name, value: String(value) }));

const server = http.createServer((req, res) => {
  const started = Date.now();
  const body = [];
  req.on("data", (c) => body.push(c));
  req.on("end", () => {
    const up = http.request({ host: "127.0.0.1", port: upstream, method: req.method, path: req.url, headers: req.headers }, (ur) => {
      res.writeHead(ur.statusCode, ur.headers);
      const chunks = [];
      const entry = {};
      entries.push(entry);
      const record = () => {
        Object.assign(entry, {
          startedDateTime: new Date(started).toISOString(), time: Date.now() - started,
          request: { method: req.method, url: `http://${req.headers.host}${req.url}`, httpVersion: "HTTP/1.1", headers: hdrs(req.headers), postData: body.length ? { mimeType: req.headers["content-type"] || "", text: Buffer.concat(body).toString("utf8") } : undefined },
          response: { status: ur.statusCode, headers: hdrs(ur.headers), content: { mimeType: ur.headers["content-type"] || "", text: chunks.map((c) => c.text).join("") } },
          _chunks: chunks,
        });
        flush();
      };
      ur.on("data", (c) => { chunks.push({ t: Date.now() - started, text: c.toString("utf8") }); res.write(c); record(); });
      ur.on("end", () => { res.end(); record(); });
      res.on("close", () => { record(); ur.destroy(); });
    });
    up.on("error", (e) => { res.writeHead(502); res.end(String(e)); });
    up.end(Buffer.concat(body));
  });
});
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, sock, head) => {
  wss.handleUpgrade(req, sock, head, (client) => {
    const started = Date.now();
    const msgs = [];
    const entry = { startedDateTime: new Date(started).toISOString(), time: 0, request: { method: "GET", url: `ws://${req.headers.host}${req.url}`, headers: hdrs(req.headers) }, response: { status: 101, content: { text: "" } }, _resourceType: "websocket", _webSocketMessages: msgs };
    entries.push(entry);
    const up = new WebSocket(`ws://127.0.0.1:${upstream}${req.url}`);
    const pending = [];
    up.on("open", () => pending.splice(0).forEach((m) => up.send(m)));
    up.on("message", (m) => { msgs.push({ type: "receive", time: (Date.now() - started) / 1000, opcode: 1, data: m.toString() }); client.send(m.toString()); flush(); });
    client.on("message", (m) => { msgs.push({ type: "send", time: (Date.now() - started) / 1000, opcode: 1, data: m.toString() }); up.readyState === 1 ? up.send(m.toString()) : pending.push(m.toString()); flush(); });
    client.on("close", () => up.close()); up.on("close", () => client.close());
  });
});
server.listen(+listen, () => console.log(`recording :${listen} -> :${upstream} into ${out}`));
