// Browser scenario run with the unmodified Firebase JS SDK. Used both for evidence capture
// (against the official emulator) and for smoke testing firebase-compat.
import { initializeApp } from "firebase/app";
import { getAuth, connectAuthEmulator, createUserWithEmailAndPassword, signInWithEmailAndPassword, signInAnonymously, signOut } from "firebase/auth";
import { getFirestore, connectFirestoreEmulator, doc, setDoc, getDoc, collection, addDoc, query, where, orderBy, limit, getDocs, onSnapshot, writeBatch, runTransaction, deleteDoc } from "firebase/firestore";
import { getDatabase, connectDatabaseEmulator, ref, set, get, push, onValue, update, runTransaction as rtdbTx } from "firebase/database";
import { getStorage, connectStorageEmulator, ref as sref, uploadString, getDownloadURL, getMetadata, deleteObject } from "firebase/storage";

window.runScenario = async (cfg) => {
  const log = [];
  const step = async (name, fn) => {
    try { log.push({ name, ok: true, value: await fn() }); }
    catch (e) { log.push({ name, ok: false, error: String(e && e.code || e) }); }
  };
  const app = initializeApp({ apiKey: "fake-api-key", projectId: cfg.projectId, databaseURL: `http://${cfg.host}:${cfg.ports.database}?ns=${cfg.projectId}`, storageBucket: `${cfg.projectId}.appspot.com` }, "s" + Date.now());
  const auth = getAuth(app); connectAuthEmulator(auth, `http://${cfg.host}:${cfg.ports.auth}`, { disableWarnings: true });
  const db = getFirestore(app); connectFirestoreEmulator(db, cfg.host, cfg.ports.firestore);
  const rtdb = getDatabase(app); connectDatabaseEmulator(rtdb, cfg.host, cfg.ports.database);
  const st = getStorage(app); connectStorageEmulator(st, cfg.host, cfg.ports.storage);
  const email = `u${Date.now()}@example.com`;
  if (cfg.services.includes("auth")) {
    await step("auth.signUp", async () => (await createUserWithEmailAndPassword(auth, email, "secret123")).user.email);
    await step("auth.signOut", () => signOut(auth).then(() => auth.currentUser));
    await step("auth.signIn", async () => (await signInWithEmailAndPassword(auth, email, "secret123")).user.email);
    await step("auth.wrongPassword", () => signInWithEmailAndPassword(auth, email, "nope"));
    await step("auth.anonymous", async () => (await signInAnonymously(auth)).user.isAnonymous);
  }
  if (cfg.services.includes("firestore")) {
    const col = "cap" + Date.now();
    await step("fs.set", () => setDoc(doc(db, col, "a"), { n: 1, tag: "x" }));
    await step("fs.get", async () => (await getDoc(doc(db, col, "a"))).data());
    await step("fs.add", async () => typeof (await addDoc(collection(db, col), { n: 2, tag: "y" })).id);
    await step("fs.query", async () => (await getDocs(query(collection(db, col), where("n", ">", 0), orderBy("n"), limit(5)))).docs.map(d => d.data().n));
    await step("fs.batch", async () => { const b = writeBatch(db); b.set(doc(db, col, "b"), { n: 3 }); b.update(doc(db, col, "a"), { n: 10 }); await b.commit(); });
    await step("fs.tx", () => runTransaction(db, async (tx) => { const s = await tx.get(doc(db, col, "a")); tx.update(doc(db, col, "a"), { n: s.data().n + 1 }); return s.data().n + 1; }));
    await step("fs.onSnapshot", () => new Promise((res, rej) => { const u = onSnapshot(collection(db, col), (s) => { if (s.size >= 3) { u(); res(s.size); } }, rej); setTimeout(() => rej(new Error("timeout")), 10000); }));
    await step("fs.delete", () => deleteDoc(doc(db, col, "b")));
  }
  if (cfg.services.includes("database")) {
    const p = "cap" + Date.now();
    await step("db.set", () => set(ref(rtdb, p + "/a"), { n: 1 }));
    await step("db.get", async () => (await get(ref(rtdb, p + "/a"))).val());
    await step("db.push", async () => typeof (await push(ref(rtdb, p + "/list"), { v: 1 })).key);
    await step("db.update", () => update(ref(rtdb, p + "/a"), { m: 2 }));
    await step("db.tx", async () => (await rtdbTx(ref(rtdb, p + "/a/n"), (v) => (v || 0) + 1)).snapshot.val());
    await step("db.onValue", () => new Promise((res) => { const u = onValue(ref(rtdb, p + "/a"), (s) => { u(); res(s.val()); }); }));
  }
  if (cfg.services.includes("storage")) {
    const r = sref(st, "cap/" + Date.now() + ".txt");
    await step("st.upload", async () => (await uploadString(r, "hello world", "raw", { contentType: "text/plain" })).metadata.size);
    await step("st.url", async () => (await getDownloadURL(r)).includes("alt=media"));
    await step("st.metadata", async () => (await getMetadata(r)).contentType);
    await step("st.delete", () => deleteObject(r));
  }
  return log;
};
