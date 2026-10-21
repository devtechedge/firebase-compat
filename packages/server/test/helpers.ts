import { initializeApp, deleteApp, type FirebaseApp } from "firebase/app";
import { FirebaseCompatServer, type ServerOptions } from "../src/index.js";

let counter = 0;

export async function startServer(opts: ServerOptions = {}) {
  const server = new FirebaseCompatServer({ port: 0, host: "127.0.0.1", quiet: true, ...opts });
  const port = await server.start();
  return { server, port };
}

export function newApp(projectId = "demo-project"): FirebaseApp {
  return initializeApp({ apiKey: "fake-api-key", projectId, storageBucket: `${projectId}.appspot.com`, databaseURL: `http://127.0.0.1?ns=${projectId}` }, `app-${process.pid}-${++counter}`);
}

export { deleteApp };
