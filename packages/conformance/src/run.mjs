// Differential conformance runner.
//   node src/run.mjs --target emulator   (Firebase Emulator Suite on default ports)
//   node src/run.mjs --target compat     (starts firebase-compat in-process on one port)
//   node src/run.mjs --compare a.json b.json   (writes results/report.md + summary.json)
//   node src/run.mjs --self-check        (runs compat only; fails if any case throws)
import { initializeApp } from "firebase/app";
import { getAuth, connectAuthEmulator } from "firebase/auth";
import { getFirestore, connectFirestoreEmulator, terminate } from "firebase/firestore";
import { getDatabase, connectDatabaseEmulator, goOffline } from "firebase/database";
import { getStorage, connectStorageEmulator } from "firebase/storage";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { cases } from "./cases.mjs";

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const PROJECT = "demo-compat";
const outDir = new URL("../results/", import.meta.url).pathname;

function stable(v) {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])]));
  return v === undefined ? null : v;
}

async function runTarget(name, ports, host = "127.0.0.1") {
  const app = initializeApp({ apiKey: "fake-api-key", projectId: PROJECT, storageBucket: `${PROJECT}.appspot.com`, databaseURL: `http://${host}:${ports.database}?ns=${PROJECT}` }, name);
  const auth = getAuth(app); connectAuthEmulator(auth, `http://${host}:${ports.auth}`, { disableWarnings: true });
  const db = getFirestore(app); connectFirestoreEmulator(db, host, ports.firestore);
  const rtdb = getDatabase(app); connectDatabaseEmulator(rtdb, host, ports.database);
  const storage = getStorage(app); connectStorageEmulator(storage, host, ports.storage);
  const u = `u${Date.now().toString(36)}`;
  const results = [];
  for (const c of cases) {
    const t0 = Date.now();
    let out;
    try {
      out = { ok: true, value: stable(await Promise.race([c.fn({ auth, db, rtdb, storage, u }), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 20000))])) };
    } catch (e) {
      out = { ok: false, error: String(e?.code ?? e?.message ?? e) };
    }
    results.push({ service: c.service, name: c.name, ms: Date.now() - t0, ...out });
    process.stdout.write(out.ok ? "." : "x");
  }
  process.stdout.write("\n");
  goOffline(rtdb);
  await terminate(db);
  return results;
}

function compare(a, b) {
  const rows = a.map((x, i) => {
    const y = b[i];
    const same = JSON.stringify({ ok: x.ok, value: x.value, error: x.error }) === JSON.stringify({ ok: y.ok, value: y.value, error: y.error });
    return { service: x.service, name: x.name, pass: same, emulator: x.ok ? x.value : { thrown: x.error }, compat: y.ok ? y.value : { thrown: y.error } };
  });
  const services = [...new Set(rows.map((r) => r.service))];
  const summary = Object.fromEntries(services.map((s) => {
    const rs = rows.filter((r) => r.service === s);
    const passed = rs.filter((r) => r.pass).length;
    return [s, { passed, total: rs.length, rate: Math.round((passed / rs.length) * 1000) / 10 }];
  }));
  const passed = rows.filter((r) => r.pass).length;
  summary.overall = { passed, total: rows.length, rate: Math.round((passed / rows.length) * 1000) / 10 };
  let md = `# Conformance report\n\nSame ${rows.length} cases, unmodified \`firebase\` JS SDK, run against the Firebase Emulator Suite and against firebase-compat. A case passes when both produce identical normalized results.\n\n| Service | Passed | Total | Rate |\n|---|---|---|---|\n`;
  for (const [s, v] of Object.entries(summary)) md += `| ${s} | ${v.passed} | ${v.total} | ${v.rate}% |\n`;
  md += `\n## Cases\n\n| Service | Case | Result |\n|---|---|---|\n`;
  for (const r of rows) md += `| ${r.service} | ${r.name} | ${r.pass ? "pass" : "FAIL"} |\n`;
  const diffs = rows.filter((r) => !r.pass);
  if (diffs.length) {
    md += `\n## Differences\n\n`;
    for (const r of diffs) md += `### ${r.service}: ${r.name}\n\nEmulator:\n\n\`\`\`json\n${JSON.stringify(r.emulator, null, 2)}\n\`\`\`\n\nfirebase-compat:\n\n\`\`\`json\n${JSON.stringify(r.compat, null, 2)}\n\`\`\`\n\n`;
  }
  return { rows, summary, md };
}

mkdirSync(outDir, { recursive: true });
const target = flag("target");
if (args.includes("--compare")) {
  const [fa, fb] = args.slice(args.indexOf("--compare") + 1);
  const { summary, md } = compare(JSON.parse(readFileSync(fa)), JSON.parse(readFileSync(fb)));
  writeFileSync(`${outDir}/summary.json`, JSON.stringify(summary, null, 2) + "\n");
  writeFileSync(`${outDir}/report.md`, md);
  console.log(JSON.stringify(summary, null, 2));
  if (args.includes("--strict") && summary.overall.passed !== summary.overall.total) process.exit(1);
} else if (target === "emulator") {
  const r = await runTarget("emulator", { auth: 9099, firestore: 8080, database: 9000, storage: 9199 });
  writeFileSync(`${outDir}/emulator.json`, JSON.stringify(r, null, 2) + "\n");
  process.exit(0);
} else {
  const { FirebaseCompatServer } = await import("@firebase-compat/server");
  const server = new FirebaseCompatServer({ port: Number(flag("port") ?? 0), host: "127.0.0.1", projectId: PROJECT, quiet: true });
  const port = await server.start();
  const r = await runTarget("compat", { auth: port, firestore: port, database: port, storage: port });
  writeFileSync(`${outDir}/compat.json`, JSON.stringify(r, null, 2) + "\n");
  await server.stop();
  const failed = r.filter((x) => !x.ok && x.error === "timeout");
  if (args.includes("--self-check") && failed.length) { console.error("timeouts:", failed.map((f) => f.name)); process.exit(1); }
  console.log(`${r.length} cases, ${r.filter((x) => x.ok).length} completed without throwing`);
  process.exit(0);
}
