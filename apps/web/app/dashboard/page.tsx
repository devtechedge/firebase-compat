"use client";
import { useCallback, useEffect, useState } from "react";
import { admin, useServerUrl } from "@/lib/server";

type Tab = "overview" | "users" | "firestore" | "database" | "storage" | "rules";

export default function Dashboard() {
  const [url, setUrl] = useServerUrl();
  const [draft, setDraft] = useState(url);
  const [tab, setTab] = useState<Tab>("overview");
  const [stats, setStats] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setDraft(url), [url]);
  const refresh = useCallback(() => {
    admin(url, "stats").then((s) => { setStats(s); setError(null); }).catch((e) => { setStats(null); setError(`Cannot reach ${url}: ${e.message}`); });
  }, [url]);
  useEffect(() => { refresh(); const t = setInterval(refresh, 5000); return () => clearInterval(t); }, [refresh]);
  return (
    <>
      <h1>Dashboard</h1>
      <div className="row">
        <input style={{ minWidth: 320 }} value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="Server URL" />
        <button onClick={() => setUrl(draft)}>Connect</button>
        {stats ? <span className="pill ok">connected to {stats.projectId}</span> : <span className="pill bad">offline</span>}
      </div>
      {error && <p className="err">{error}. Start one with <code>docker compose up</code> or <code>pnpm dev</code>.</p>}
      <div className="tabs">
        {(["overview", "users", "firestore", "database", "storage", "rules"] as Tab[]).map((t) => (
          <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>{t}</button>
        ))}
      </div>
      {stats && tab === "overview" && <Overview stats={stats} url={url} onReset={refresh} />}
      {stats && tab === "users" && <Users url={url} />}
      {stats && tab === "firestore" && <Firestore url={url} />}
      {stats && tab === "database" && <Database url={url} />}
      {stats && tab === "storage" && <Storage url={url} />}
      {stats && tab === "rules" && <Rules url={url} />}
    </>
  );
}

function Overview({ stats, url, onReset }: { stats: any; url: string; onReset: () => void }) {
  const items = [["Users", stats.users], ["Firestore documents", stats.documents], ["Storage objects", stats.objects], ["Realtime DB connections", stats.rtdbConnections], ["WebChannel sessions", stats.webchannelSessions], ["Uptime (s)", stats.uptimeSeconds]];
  return (
    <>
      <div className="grid">{items.map(([k, v]) => <div className="card" key={k}><div className="muted">{k}</div><h2 style={{ margin: 0 }}>{v}</h2></div>)}</div>
      <p><button className="ghost" onClick={async () => { if (confirm("Delete all data on this server?")) { await admin(url, "reset", { method: "POST" }); onReset(); } }}>Reset all data</button></p>
    </>
  );
}

function Users({ url }: { url: string }) {
  const [users, setUsers] = useState<any[]>([]);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const load = useCallback(() => admin(url, "users").then((r) => setUsers(r.users)), [url]);
  useEffect(() => { void load(); }, [load]);
  return (
    <div className="card">
      <div className="row">
        <input placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input placeholder="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <button onClick={async () => { await admin(url, "users", { method: "POST", body: JSON.stringify({ email, password }) }); setEmail(""); setPassword(""); void load(); }}>Add user</button>
      </div>
      <table style={{ marginTop: 12 }}>
        <thead><tr><th>UID</th><th>Email</th><th>Name</th><th>Providers</th><th>Created</th><th /></tr></thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.localId}>
              <td className="mono">{u.localId}</td><td>{u.email ?? <span className="muted">anonymous</span>}</td><td>{u.displayName ?? ""}</td>
              <td>{(u.providerUserInfo ?? []).map((p: any) => p.providerId).join(", ") || "anonymous"}</td>
              <td>{new Date(Number(u.createdAt)).toLocaleString()}</td>
              <td><button className="ghost" onClick={async () => { await admin(url, `users/${u.localId}`, { method: "DELETE" }); void load(); }}>Delete</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      {!users.length && <p className="muted">No users yet.</p>}
    </div>
  );
}

function Firestore({ url }: { url: string }) {
  const [path, setPath] = useState<string>("");
  const [collections, setCollections] = useState<string[]>([]);
  const [docs, setDocs] = useState<any[]>([]);
  const [selected, setSelected] = useState<any>(null);
  const [edit, setEdit] = useState("");
  const parent = path.split("/").length % 2 === 0 && path ? path : "";
  useEffect(() => { admin(url, `firestore/collections${parent ? `?parent=${encodeURIComponent(parent)}` : ""}`).then((r) => setCollections(r.collections)); }, [url, parent]);
  const openCollection = useCallback((c: string) => { setPath(c); setSelected(null); admin(url, `firestore/documents?collection=${encodeURIComponent(c)}`).then((r) => setDocs(r.documents)); }, [url]);
  return (
    <div className="split">
      <div className="card list">
        <div className="muted">Collections {parent && <>under <code>{parent}</code></>}</div>
        {parent && <button onClick={() => setPath("")}>.. root</button>}
        {collections.map((c) => { const full = parent ? `${parent}/${c}` : c; return <button key={c} className={path === full ? "active" : ""} onClick={() => openCollection(full)}>{c}</button>; })}
      </div>
      <div className="card">
        {!docs.length && <p className="muted">Choose a collection.</p>}
        <table><tbody>
          {docs.map((d) => (
            <tr key={d.path}>
              <td className="mono"><a href="#" onClick={(e) => { e.preventDefault(); setSelected(d); setEdit(JSON.stringify(d.data, null, 2)); }}>{d.id}</a></td>
              <td className="mono muted">{d.missing ? <i>no document, has subcollections</i> : JSON.stringify(d.data).slice(0, 90)}</td>
              <td><button className="ghost" onClick={async () => { await admin(url, `firestore/document?path=${encodeURIComponent(d.path)}`, { method: "DELETE" }); openCollection(path); }}>Delete</button></td>
            </tr>
          ))}
        </tbody></table>
        {selected && (
          <>
            <h3 className="mono">{selected.path}</h3>
            <p className="muted">updated {selected.updateTime}</p>
            <textarea value={edit} onChange={(e) => setEdit(e.target.value)} />
            <div className="row">
              <button onClick={async () => { await admin(url, `firestore/document?path=${encodeURIComponent(selected.path)}`, { method: "PUT", body: edit }); openCollection(path); }}>Save</button>
              <button className="ghost" onClick={async () => { const sub = await admin(url, `firestore/collections?parent=${encodeURIComponent(selected.path)}`); if (sub.collections.length) setPath(selected.path); else alert("No subcollections"); }}>Subcollections</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Database({ url }: { url: string }) {
  const [path, setPath] = useState("/");
  const [value, setValue] = useState("");
  const load = useCallback(() => admin(url, `database?path=${encodeURIComponent(path)}`).then((r) => setValue(JSON.stringify(r.value, null, 2))), [url, path]);
  useEffect(() => { void load(); }, [load]);
  return (
    <div className="card">
      <div className="row"><input value={path} onChange={(e) => setPath(e.target.value)} /><button className="ghost" onClick={() => void load()}>Load</button></div>
      <textarea value={value} onChange={(e) => setValue(e.target.value)} />
      <div className="row">
        <button onClick={async () => { await admin(url, `database?path=${encodeURIComponent(path)}`, { method: "PUT", body: JSON.stringify({ value: JSON.parse(value) }) }); void load(); }}>Set value</button>
        <button className="ghost" onClick={async () => { await admin(url, `database?path=${encodeURIComponent(path)}`, { method: "DELETE" }); void load(); }}>Remove</button>
      </div>
    </div>
  );
}

function Storage({ url }: { url: string }) {
  const [objects, setObjects] = useState<any[]>([]);
  const load = useCallback(() => admin(url, "storage").then((r) => setObjects(r.objects)), [url]);
  useEffect(() => { void load(); }, [load]);
  return (
    <div className="card">
      <table>
        <thead><tr><th>Object</th><th>Type</th><th>Size</th><th>Updated</th><th /></tr></thead>
        <tbody>{objects.map((o) => (
          <tr key={o.bucket + o.name}>
            <td className="mono"><a href={`${url}/v0/b/${o.bucket}/o/${encodeURIComponent(o.name)}?alt=media&token=${o.downloadTokens}`} target="_blank" rel="noreferrer">{o.name}</a></td>
            <td>{o.contentType}</td><td>{o.size}</td><td>{new Date(o.updated).toLocaleString()}</td>
            <td><button className="ghost" onClick={async () => { await admin(url, `storage?bucket=${encodeURIComponent(o.bucket)}&name=${encodeURIComponent(o.name)}`, { method: "DELETE" }); void load(); }}>Delete</button></td>
          </tr>
        ))}</tbody>
      </table>
      {!objects.length && <p className="muted">No objects yet.</p>}
    </div>
  );
}

function Rules({ url }: { url: string }) {
  const [source, setSource] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  useEffect(() => { admin(url, "firestore/rules").then((r) => setSource(r.source)); }, [url]);
  return (
    <div className="card">
      <p className="muted">Firestore security rules. Changes apply immediately to SDK clients; the owner credential bypasses rules.</p>
      <textarea style={{ minHeight: 380 }} value={source} onChange={(e) => setSource(e.target.value)} />
      <div className="row">
        <button onClick={async () => { try { await admin(url, "firestore/rules", { method: "PUT", body: JSON.stringify({ source }) }); setStatus("Rules published."); } catch (e: any) { setStatus(`Error: ${e.message}`); } }}>Publish</button>
        {status && <span className={status.startsWith("Error") ? "err" : "muted"}>{status}</span>}
      </div>
    </div>
  );
}
