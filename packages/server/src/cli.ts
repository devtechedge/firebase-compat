#!/usr/bin/env node
// Command line entry point: firebase-compat [--port 8787] [--project demo-project] [--data ./data/db.sqlite]
import { FirebaseCompatServer } from "./server.js";

const args = process.argv.slice(2);
const opt = (name: string, env: string, def?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : process.env[env] ?? def;
};
const server = new FirebaseCompatServer({
  port: Number(opt("port", "PORT", "8787")),
  host: opt("host", "HOST", "0.0.0.0"),
  projectId: opt("project", "FIREBASE_PROJECT", "demo-project"),
  dataFile: opt("data", "DATA_FILE", ":memory:"),
  rulesFile: opt("rules", "FIRESTORE_RULES"),
  adminToken: opt("admin-token", "ADMIN_TOKEN"),
});
const port = await server.start();
console.log(`firebase-compat listening on :${port} (project ${server.projectId})`);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => void server.stop().then(() => process.exit(0)));
