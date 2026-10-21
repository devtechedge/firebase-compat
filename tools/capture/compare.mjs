// Runs the browser scenario (headless Chrome, unmodified web SDK, WebChannel transport) against
// the Firebase emulators and against firebase-compat, then compares step results.
// Usage: node compare.mjs <compatPort> [outJson]
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const [port = "9500", out = "../../packages/conformance/results/web.json"] = process.argv.slice(2);
const run = (file, ports) => {
  execFileSync("node", ["capture.mjs", file, "127.0.0.1", ...ports], { env: { ...process.env, PROJECT: "demo-compat" }, stdio: "ignore" });
  return JSON.parse(readFileSync(file.replace(/\.har$/, ".results.json"), "utf8"));
};
const norm = (r) => r.map((s) => ({ name: s.name, ok: s.ok, v: typeof s.value === "string" ? s.value.replace(/u\d+@/, "U@") : s.value ?? null, e: s.error ?? null }));
const emu = norm(run("/tmp/web-emulator.har", ["9099", "8080", "9000", "9199"]));
const compat = norm(run("/tmp/web-compat.har", [port, port, port, port]));
const rows = emu.map((e, i) => ({ name: e.name, pass: JSON.stringify(e) === JSON.stringify(compat[i]) }));
const passed = rows.filter((r) => r.pass).length;
writeFileSync(out, JSON.stringify({ transport: "webchannel (headless Chrome)", passed, total: rows.length, rows }, null, 2) + "\n");
console.log(`${passed}/${rows.length}`);
for (const r of rows) if (!r.pass) console.log("FAIL", r.name);
