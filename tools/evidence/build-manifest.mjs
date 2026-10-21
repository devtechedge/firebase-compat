// Builds evidence/manifest.json and evidence/SUMMARY.md from REA outputs and raw captures.
// REA JSON results are gzipped (they are large) and every artifact is recorded with its SHA-256.
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { readFileSync, writeFileSync, readdirSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../../evidence/", import.meta.url).pathname;
const sha = (b) => createHash("sha256").update(b).digest("hex");
const artifacts = [];
const summary = {};

for (const f of readdirSync(join(root, "rea")).filter((f) => f.endsWith(".json"))) {
  const buf = readFileSync(join(root, "rea", f));
  const j = JSON.parse(buf);
  const gz = gzipSync(buf, { level: 9 });
  writeFileSync(join(root, "rea", f + ".gz"), gz);
  unlinkSync(join(root, "rea", f));
  const n = j.normalized_result ?? {};
  const s = { evidence_id: j.evidence_id, operation: j.operation, subject_sha256: j.subject?.digest?.sha256 ?? n.root_artifact_sha256 };
  if (j.operation === "inspect_web_network_capture") {
    s.records = n.total_records;
    s.endpoints = [...new Set(n.records.map((r) => { const q = r.reported.request; const u = new URL(q.url); return `${q.method} ${u.pathname.replace(/cap\d+/g, "{col}").replace(/\/o\/.+$/, "/o/{object}")}`; }))].sort();
  } else {
    s.statistics = n.statistics;
    s.semantic_nodes = n.semantic_graph?.nodes?.length;
    s.semantic_relations = n.semantic_graph?.relations?.length;
    s.unknowns = n.semantic_graph?.unknowns?.length;
    s.function_fingerprints = n.semantic_graph?.fingerprints?.length;
  }
  summary[f.replace(/\.json$/, "")] = s;
  artifacts.push({ path: `rea/${f}.gz`, sha256: sha(gz), uncompressed_sha256: sha(buf), bytes: gz.length });
}
for (const f of readdirSync(join(root, "rea")).filter((f) => f.endsWith(".gz") && !artifacts.some((a) => a.path === `rea/${f}`))) {
  const gz = readFileSync(join(root, "rea", f));
  artifacts.push({ path: `rea/${f}`, sha256: sha(gz), bytes: gz.length });
}
for (const f of readdirSync(join(root, "raw"))) {
  const b = readFileSync(join(root, "raw", f));
  artifacts.push({ path: `raw/${f}`, sha256: sha(b), bytes: b.length });
}
const prev = existsSync(join(root, "summary.json")) ? JSON.parse(readFileSync(join(root, "summary.json"))) : {};
const merged = { ...prev, ...summary };
artifacts.sort((a, b) => a.path.localeCompare(b.path));
writeFileSync(join(root, "summary.json"), JSON.stringify(merged, null, 2) + "\n");
writeFileSync(join(root, "manifest.json"), JSON.stringify({ generated: new Date().toISOString(), tool: "rea-agents@6.7.0", artifacts }, null, 2) + "\n");
console.log(`${artifacts.length} artifacts`);
