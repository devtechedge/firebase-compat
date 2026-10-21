import Link from "next/link";
import summary from "@/lib/conformance-summary.json";
import web from "@/lib/conformance-web.json";

const services = [
  { key: "auth", name: "Authentication", text: "Identity Toolkit and Secure Token REST: email and password, anonymous, custom tokens, profile and password updates, refresh, delete. RS256 ID tokens with a JWKS endpoint." },
  { key: "firestore", name: "Cloud Firestore", text: "gRPC for Node, WebChannel for browsers and REST for firestore/lite. Queries with filters, OR, cursors, collection groups, aggregations, transforms, batches, transactions and realtime listeners." },
  { key: "database", name: "Realtime Database", text: "The v5 WebSocket protocol: set, update, push, server values, ordered queries, hash based transactions, onDisconnect, plus the REST .json API." },
  { key: "storage", name: "Cloud Storage", text: "Multipart and resumable uploads, metadata, download URLs with tokens, list with prefixes and pagination, delete." },
];

export default function Home() {
  const s = summary as Record<string, { passed: number; total: number; rate: number }>;
  return (
    <>
      <section className="hero">
        <span className="pill ok">v0.1.0</span>
        <h1>A self-hosted backend for the <span>unmodified Firebase SDK</span></h1>
        <p>firebase-compat speaks the same wire protocols as Firebase. Point <code>connectAuthEmulator</code>, <code>connectFirestoreEmulator</code>, <code>connectDatabaseEmulator</code> and <code>connectStorageEmulator</code> at one port and your app keeps working. Every behaviour is checked against the official Firebase Emulator Suite.</p>
        <div className="row" style={{ marginTop: 18 }}>
          <Link className="btn" href="/demo">Try the demo app</Link>
          <Link href="/dashboard"><button className="ghost">Open the dashboard</button></Link>
          <a href="https://github.com/devtechedge/firebase-compat"><button className="ghost">Source on GitHub</button></a>
        </div>
      </section>
      <h2 style={{ marginTop: 40 }}>Differential conformance vs the Firebase Emulator Suite</h2>
      <p className="muted">Same cases, same unmodified <code>firebase@13</code> SDK, two backends. A case passes only on identical results.</p>
      <div className="grid">
        {services.map((x) => (
          <div className="card" key={x.key}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <h3>{x.name}</h3>
              <span className="pill ok">{s[x.key]?.passed}/{s[x.key]?.total}</span>
            </div>
            <p className="muted">{x.text}</p>
          </div>
        ))}
        <div className="card">
          <div className="row" style={{ justifyContent: "space-between" }}><h3>Browser (WebChannel)</h3><span className="pill ok">{web.passed}/{web.total}</span></div>
          <p className="muted">The same scenario in headless Chrome, where Firestore streams run over WebChannel instead of gRPC.</p>
        </div>
      </div>
      <h2 style={{ marginTop: 40 }}>Quick start</h2>
      <pre>{`docker compose up -d          # or: npx @firebase-compat/server --port 8787

import { connectAuthEmulator, getAuth } from "firebase/auth";
import { connectFirestoreEmulator, getFirestore } from "firebase/firestore";

connectAuthEmulator(getAuth(app), "http://localhost:8787");
connectFirestoreEmulator(getFirestore(app), "localhost", 8787);`}</pre>
      <p className="muted">The behaviour was derived from the Apache-2.0 SDK, public REST references and recorded SDK traffic analyzed with REA. Evidence files and their SHA-256 digests live in the <a href="https://github.com/devtechedge/firebase-compat/tree/main/evidence">evidence folder</a>.</p>
    </>
  );
}
