// Records HAR traffic between the unmodified Firebase web SDK (in headless Chrome) and a backend.
// Usage: node capture.mjs <out.har> [host] [authPort fsPort dbPort storagePort]
import { build } from "esbuild";
import { chromium } from "playwright-core";
import http from "node:http";
import { readFileSync, writeFileSync } from "node:fs";

const [out = "capture.har", host = "127.0.0.1", a = "9099", f = "8080", d = "9000", s = "9199"] = process.argv.slice(2);
const services = (process.env.SERVICES || "auth,firestore,database,storage").split(",");
await build({ entryPoints: ["scenario.js"], bundle: true, format: "iife", outfile: "dist/scenario.js", logLevel: "error" });
const js = readFileSync("dist/scenario.js");
const srv = http.createServer((req, res) => {
  if (req.url === "/scenario.js") { res.setHeader("content-type", "text/javascript"); return res.end(js); }
  res.setHeader("content-type", "text/html"); res.end('<!doctype html><script src="/scenario.js"></script>');
}).listen(0);
const port = srv.address().port;
const browser = await chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const ctx = await browser.newContext({ recordHar: { path: out, content: "embed" } });
const page = await ctx.newPage();
await page.goto(`http://localhost:${port}/`);
const log = await page.evaluate((cfg) => window.runScenario(cfg), { host, projectId: process.env.PROJECT || "demo-compat", services, ports: { auth: +a, firestore: +f, database: +d, storage: +s } });
await ctx.close(); await browser.close(); srv.close();
writeFileSync(out.replace(/\.har$/, ".results.json"), JSON.stringify(log, null, 2));
console.log(JSON.stringify(log, null, 1));
