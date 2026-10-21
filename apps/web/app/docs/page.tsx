const sections: [string, string][] = [
  ["Run the server", "docker compose up -d\n# or from source\npnpm install && pnpm build\nnode packages/server/dist/cli.js --port 8787 --project demo-project --data ./data/db.sqlite --rules ./firestore.rules"],
  ["Point the SDK at it", `import { initializeApp } from "firebase/app";
import { getAuth, connectAuthEmulator } from "firebase/auth";
import { getFirestore, connectFirestoreEmulator } from "firebase/firestore";
import { getDatabase, connectDatabaseEmulator } from "firebase/database";
import { getStorage, connectStorageEmulator } from "firebase/storage";

const app = initializeApp({ apiKey: "any", projectId: "demo-project", storageBucket: "demo-project.appspot.com" });
connectAuthEmulator(getAuth(app), "http://localhost:8787");
connectFirestoreEmulator(getFirestore(app), "localhost", 8787);
connectDatabaseEmulator(getDatabase(app), "localhost", 8787);
connectStorageEmulator(getStorage(app), "localhost", 8787);`],
  ["Admin SDK", "FIRESTORE_EMULATOR_HOST=localhost:8787 FIREBASE_AUTH_EMULATOR_HOST=localhost:8787 node admin-script.js"],
];

export default function Docs() {
  return (
    <>
      <h1>Docs</h1>
      <p className="muted">Full documentation (architecture, protocol notes, compatibility matrix, evidence format, limitations) lives in the <a href="https://github.com/devtechedge/firebase-compat/tree/main/docs">repository docs folder</a>.</p>
      {sections.map(([h, code]) => (<section key={h}><h2>{h}</h2><pre>{code}</pre></section>))}
    </>
  );
}
