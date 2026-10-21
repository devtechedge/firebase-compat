"use client";
// Demo chat app built with the official, unmodified Firebase JS SDK. The only difference from a
// production Firebase app is that the SDK is pointed at a firebase-compat server.
import { useEffect, useMemo, useState } from "react";
import { initializeApp, deleteApp, type FirebaseApp } from "firebase/app";
import { connectAuthEmulator, createUserWithEmailAndPassword, getAuth, onAuthStateChanged, signInAnonymously, signInWithEmailAndPassword, signOut, updateProfile, type User } from "firebase/auth";
import { addDoc, collection, connectFirestoreEmulator, deleteDoc, doc, getFirestore, limit, onSnapshot, orderBy, query, serverTimestamp, updateDoc, increment } from "firebase/firestore";
import { useServerUrl } from "@/lib/server";

interface Message { id: string; text: string; uid: string; name: string; createdAt?: { toDate(): Date }; likes?: number }

function useFirebase(serverUrl: string) {
  const [app, setApp] = useState<FirebaseApp | null>(null);
  useEffect(() => {
    const u = new URL(serverUrl);
    const a = initializeApp({ apiKey: "demo-api-key", projectId: "demo-project", authDomain: "demo-project.firebaseapp.com" }, `demo-${Date.now()}`);
    connectAuthEmulator(getAuth(a), u.origin, { disableWarnings: true });
    connectFirestoreEmulator(getFirestore(a), u.hostname, Number(u.port || (u.protocol === "https:" ? 443 : 80)), u.protocol === "https:" ? { ssl: true } as never : undefined);
    setApp(a);
    return () => { void deleteApp(a); };
  }, [serverUrl]);
  return app;
}

export default function Demo() {
  const [serverUrl, setServerUrl] = useServerUrl();
  const [draftUrl, setDraftUrl] = useState(serverUrl);
  useEffect(() => setDraftUrl(serverUrl), [serverUrl]);
  const app = useFirebase(serverUrl);
  const auth = useMemo(() => (app ? getAuth(app) : null), [app]);
  const db = useMemo(() => (app ? getFirestore(app) : null), [app]);
  const [user, setUser] = useState<User | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => (auth ? onAuthStateChanged(auth, setUser) : undefined), [auth]);
  useEffect(() => {
    if (!db || !user) return;
    const q = query(collection(db, "rooms", "lobby", "messages"), orderBy("createdAt", "desc"), limit(50));
    return onSnapshot(q, (s) => setMessages(s.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Message, "id">) })).reverse()), (e) => setError(e.message));
  }, [db, user]);

  const run = async (fn: () => Promise<unknown>) => { try { setError(null); await fn(); } catch (e: any) { setError(e.code ?? e.message); } };

  return (
    <>
      <h1>Demo: realtime chat</h1>
      <p className="muted">Built with the unmodified <code>firebase</code> npm package (Auth + Firestore over WebChannel). Open it in two windows to see realtime sync.</p>
      <div className="row">
        <input style={{ minWidth: 320 }} value={draftUrl} onChange={(e) => setDraftUrl(e.target.value)} aria-label="Server URL" />
        <button className="ghost" onClick={() => setServerUrl(draftUrl)}>Use server</button>
      </div>
      {error && <p className="err">{error}</p>}
      {!user ? (
        <div className="card" style={{ marginTop: 16, maxWidth: 520 }}>
          <h3>Sign in</h3>
          <div className="row"><input placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} /><input placeholder="password (6+ chars)" type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></div>
          <div className="row" style={{ marginTop: 10 }}>
            <button disabled={!auth} onClick={() => run(() => signInWithEmailAndPassword(auth!, email, password))}>Sign in</button>
            <button className="ghost" disabled={!auth} onClick={() => run(() => createUserWithEmailAndPassword(auth!, email, password))}>Create account</button>
            <button className="ghost" disabled={!auth} onClick={() => run(() => signInAnonymously(auth!))}>Continue anonymously</button>
          </div>
        </div>
      ) : (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span>Signed in as <b>{user.displayName || user.email || "anonymous"}</b> <span className="mono muted">{user.uid}</span></span>
            <span className="row">
              <input placeholder="display name" value={name} onChange={(e) => setName(e.target.value)} />
              <button className="ghost" onClick={() => run(async () => { await updateProfile(user, { displayName: name }); await user.reload(); setUser({ ...user } as User); })}>Set name</button>
              <button className="ghost" onClick={() => run(() => signOut(auth!))}>Sign out</button>
            </span>
          </div>
          <div className="chat">
            {messages.map((m) => (
              <div key={m.id} className={`msg ${m.uid === user.uid ? "me" : ""}`}>
                <small>{m.name} {m.createdAt ? m.createdAt.toDate().toLocaleTimeString() : "sending..."}</small>
                {m.text}
                <div className="row" style={{ marginTop: 4 }}>
                  <a href="#" onClick={(e) => { e.preventDefault(); void run(() => updateDoc(doc(db!, "rooms", "lobby", "messages", m.id), { likes: increment(1) })); }}>like {m.likes ?? 0}</a>
                  {m.uid === user.uid && <a href="#" onClick={(e) => { e.preventDefault(); void run(() => deleteDoc(doc(db!, "rooms", "lobby", "messages", m.id))); }}>delete</a>}
                </div>
              </div>
            ))}
            {!messages.length && <p className="muted">No messages yet. Say hello.</p>}
          </div>
          <form className="row" onSubmit={(e) => { e.preventDefault(); if (!text.trim()) return; const t = text; setText(""); void run(() => addDoc(collection(db!, "rooms", "lobby", "messages"), { text: t, uid: user.uid, name: user.displayName || user.email || "anon", createdAt: serverTimestamp(), likes: 0 })); }}>
            <input style={{ flex: 1 }} placeholder="Message" value={text} onChange={(e) => setText(e.target.value)} />
            <button type="submit">Send</button>
          </form>
        </div>
      )}
    </>
  );
}
