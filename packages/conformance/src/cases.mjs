// Conformance cases: each runs the unmodified Firebase JS SDK against a backend and returns a
// normalized, deterministic result. The same cases run against the official Firebase Emulator
// Suite and against firebase-compat; results must match exactly.
import * as A from "firebase/auth";
import * as F from "firebase/firestore";
import * as D from "firebase/database";
import * as S from "firebase/storage";

const code = (e) => ({ error: e?.code ?? String(e) });
const attempt = async (fn) => { try { return await fn(); } catch (e) { return code(e); } };
const ids = (snap) => snap.docs.map((d) => d.id);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// The emulator rejects unindexed server-side get() queries ("Index not defined"), so ordered
// RTDB queries are read through a one-shot listener, as most apps do.
const once = (q) => new Promise((res, rej) => D.onValue(q, res, rej, { onlyOnce: true }));
const keysOf = (snap) => { const k = []; snap.forEach((c) => { k.push(c.key); }); return k; };

export const cases = [];
const add = (service, name, fn) => cases.push({ service, name, fn });

// ---------------------------------------------------------------- Auth
add("auth", "sign up with email returns user email", async ({ auth, u }) => (await A.createUserWithEmailAndPassword(auth, `${u}@example.com`, "secret123")).user.email.replace(u, "U"));
add("auth", "new user is not anonymous and has 28 char uid", async ({ auth }) => ({ anon: auth.currentUser.isAnonymous, len: auth.currentUser.uid.length }));
add("auth", "id token sign_in_provider is password", async ({ auth }) => (await auth.currentUser.getIdTokenResult()).signInProvider);
add("auth", "id token carries email and email_verified", async ({ auth, u }) => { const c = (await auth.currentUser.getIdTokenResult()).claims; return { email: c.email.replace(u, "U"), verified: c.email_verified, aud: c.aud, iss: c.iss }; });
add("auth", "duplicate email is rejected", async ({ auth, u }) => attempt(() => A.createUserWithEmailAndPassword(auth, `${u}@example.com`, "secret123")));
add("auth", "weak password is rejected", async ({ auth, u }) => attempt(() => A.createUserWithEmailAndPassword(auth, `w${u}@example.com`, "123")));
add("auth", "invalid email is rejected", async ({ auth }) => attempt(() => A.createUserWithEmailAndPassword(auth, "not-an-email", "secret123")));
add("auth", "sign out clears current user", async ({ auth }) => { await A.signOut(auth); return auth.currentUser; });
add("auth", "sign in with correct password", async ({ auth, u }) => (await A.signInWithEmailAndPassword(auth, `${u}@example.com`, "secret123")).user.email.replace(u, "U"));
add("auth", "sign in with wrong password", async ({ auth, u }) => attempt(() => A.signInWithEmailAndPassword(auth, `${u}@example.com`, "wrongpass")));
add("auth", "sign in with unknown email", async ({ auth, u }) => attempt(() => A.signInWithEmailAndPassword(auth, `nobody-${u}@example.com`, "secret123")));
add("auth", "update profile display name", async ({ auth }) => { await A.updateProfile(auth.currentUser, { displayName: "Alice" }); await auth.currentUser.reload(); return auth.currentUser.displayName; });
add("auth", "update password then sign in with it", async ({ auth, u }) => { await A.updatePassword(auth.currentUser, "newpass99"); await A.signOut(auth); return (await A.signInWithEmailAndPassword(auth, `${u}@example.com`, "newpass99")).user.displayName; });
add("auth", "force refresh returns a new token", async ({ auth }) => { const a = await auth.currentUser.getIdToken(); await wait(1100); const b = await auth.currentUser.getIdToken(true); return a !== b; });
add("auth", "fetch sign in methods", async ({ auth, u }) => attempt(() => A.fetchSignInMethodsForEmail(auth, `${u}@example.com`)));
add("auth", "password reset email for existing user", async ({ auth, u }) => attempt(async () => { await A.sendPasswordResetEmail(auth, `${u}@example.com`); return "sent"; }));
add("auth", "delete user then sign in fails", async ({ auth, u }) => { await A.deleteUser(auth.currentUser); return attempt(() => A.signInWithEmailAndPassword(auth, `${u}@example.com`, "newpass99")); });
add("auth", "anonymous sign in", async ({ auth }) => { const c = await A.signInAnonymously(auth); return { anon: c.user.isAnonymous, email: c.user.email, provider: (await c.user.getIdTokenResult()).signInProvider }; });
add("auth", "custom token sign in with claims", async ({ auth, u }) => {
  const jwt = `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")}.${Buffer.from(JSON.stringify({ uid: `c-${u}`, claims: { role: "admin" }, aud: "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, iss: "x@example.com", sub: "x@example.com" })).toString("base64url")}.`;
  const c = await A.signInWithCustomToken(auth, jwt);
  const t = await c.user.getIdTokenResult();
  return { uid: c.user.uid.replace(u, "U"), role: t.claims.role, provider: t.signInProvider };
});

// ---------------------------------------------------------------- Firestore
const seed = async (db, col) => {
  const b = F.writeBatch(db);
  const rows = [["sf", "San Francisco", 870, "CA", ["west", "coast"], true], ["la", "Los Angeles", 3900, "CA", ["west"], false], ["ny", "New York", 8400, "NY", ["east", "coast"], true], ["dc", "Washington", 690, null, ["east"], false], ["bj", "Beijing", 21500, "BJ", [], true]];
  for (const [id, name, pop, state, tags, capital] of rows) b.set(F.doc(db, col, id), { name, pop, state, tags, capital });
  await b.commit();
};
add("firestore", "set and get round trip of rich types", async ({ db, u }) => {
  await F.setDoc(F.doc(db, `t${u}`, "a"), { s: "x", i: 1, d: 1.5, b: true, n: null, arr: [1, "a", [false].length], m: { k: { z: 1 } }, ts: F.Timestamp.fromMillis(1700000000123), g: new F.GeoPoint(1.5, 2.5), bytes: F.Bytes.fromBase64String("AQID") });
  const d = (await F.getDoc(F.doc(db, `t${u}`, "a"))).data();
  return { ...d, ts: d.ts.toMillis(), g: [d.g.latitude, d.g.longitude], bytes: d.bytes.toBase64() };
});
add("firestore", "missing document does not exist", async ({ db, u }) => (await F.getDoc(F.doc(db, `t${u}`, "nope"))).exists());
add("firestore", "merge set keeps other fields", async ({ db, u }) => { await F.setDoc(F.doc(db, `t${u}`, "a"), { extra: 2 }, { merge: true }); return Object.keys((await F.getDoc(F.doc(db, `t${u}`, "a"))).data()).sort(); });
add("firestore", "update nested field and delete field", async ({ db, u }) => { await F.updateDoc(F.doc(db, `t${u}`, "a"), { "m.k.z": 5, s: F.deleteField() }); const d = (await F.getDoc(F.doc(db, `t${u}`, "a"))).data(); return { z: d.m.k.z, hasS: "s" in d }; });
add("firestore", "update missing document fails", async ({ db, u }) => attempt(() => F.updateDoc(F.doc(db, `t${u}`, "missing"), { a: 1 })));
add("firestore", "increment transform", async ({ db, u }) => { await F.setDoc(F.doc(db, `c${u}`, "x"), { n: 1 }); await F.updateDoc(F.doc(db, `c${u}`, "x"), { n: F.increment(41) }); return (await F.getDoc(F.doc(db, `c${u}`, "x"))).data().n; });
add("firestore", "increment on double", async ({ db, u }) => { await F.updateDoc(F.doc(db, `c${u}`, "x"), { n: F.increment(0.5) }); return (await F.getDoc(F.doc(db, `c${u}`, "x"))).data().n; });
add("firestore", "arrayUnion and arrayRemove", async ({ db, u }) => { await F.setDoc(F.doc(db, `c${u}`, "y"), { t: ["a", "b"] }); await F.updateDoc(F.doc(db, `c${u}`, "y"), { t: F.arrayUnion("b", "c") }); await F.updateDoc(F.doc(db, `c${u}`, "y"), { t: F.arrayRemove("a") }); return (await F.getDoc(F.doc(db, `c${u}`, "y"))).data().t; });
add("firestore", "serverTimestamp resolves to a Timestamp", async ({ db, u }) => { await F.setDoc(F.doc(db, `c${u}`, "z"), { at: F.serverTimestamp() }); return (await F.getDoc(F.doc(db, `c${u}`, "z"))).data().at instanceof F.Timestamp; });
add("firestore", "addDoc generates a 20 char id", async ({ db, u }) => (await F.addDoc(F.collection(db, `c${u}`), { v: 1 })).id.length);
add("firestore", "delete document", async ({ db, u }) => { await F.deleteDoc(F.doc(db, `c${u}`, "z")); return (await F.getDoc(F.doc(db, `c${u}`, "z"))).exists(); });
add("firestore", "query equality filter", async ({ db, u }) => { await seed(db, `q${u}`); return ids(await F.getDocs(F.query(F.collection(db, `q${u}`), F.where("state", "==", "CA")))); });
add("firestore", "query range with implicit order", async ({ db, u }) => ids(await F.getDocs(F.query(F.collection(db, `q${u}`), F.where("pop", ">=", 870)))));
add("firestore", "query orderBy desc with limit", async ({ db, u }) => ids(await F.getDocs(F.query(F.collection(db, `q${u}`), F.orderBy("pop", "desc"), F.limit(3)))));
add("firestore", "query limitToLast", async ({ db, u }) => ids(await F.getDocs(F.query(F.collection(db, `q${u}`), F.orderBy("pop"), F.limitToLast(2)))));
add("firestore", "query array-contains", async ({ db, u }) => ids(await F.getDocs(F.query(F.collection(db, `q${u}`), F.where("tags", "array-contains", "coast")))));
add("firestore", "query array-contains-any", async ({ db, u }) => ids(await F.getDocs(F.query(F.collection(db, `q${u}`), F.where("tags", "array-contains-any", ["east", "west"])))));
add("firestore", "query in", async ({ db, u }) => ids(await F.getDocs(F.query(F.collection(db, `q${u}`), F.where("state", "in", ["NY", "BJ"])))));
add("firestore", "query not-in excludes null", async ({ db, u }) => ids(await F.getDocs(F.query(F.collection(db, `q${u}`), F.where("state", "not-in", ["CA"])))));
add("firestore", "query != excludes null", async ({ db, u }) => ids(await F.getDocs(F.query(F.collection(db, `q${u}`), F.where("state", "!=", "NY")))));
add("firestore", "query == null", async ({ db, u }) => ids(await F.getDocs(F.query(F.collection(db, `q${u}`), F.where("state", "==", null)))));
add("firestore", "query OR composite", async ({ db, u }) => ids(await F.getDocs(F.query(F.collection(db, `q${u}`), F.or(F.where("pop", "<", 800), F.where("state", "==", "NY"))))));
add("firestore", "query AND of equality and range", async ({ db, u }) => ids(await F.getDocs(F.query(F.collection(db, `q${u}`), F.where("capital", "==", true), F.where("pop", ">", 1000)))));
add("firestore", "query cursors startAt and endBefore", async ({ db, u }) => ids(await F.getDocs(F.query(F.collection(db, `q${u}`), F.orderBy("pop"), F.startAt(870), F.endBefore(21500)))));
add("firestore", "query startAfter snapshot", async ({ db, u }) => { const first = await F.getDocs(F.query(F.collection(db, `q${u}`), F.orderBy("name"), F.limit(2))); return ids(await F.getDocs(F.query(F.collection(db, `q${u}`), F.orderBy("name"), F.startAfter(first.docs[1]), F.limit(2)))); });
add("firestore", "query orderBy documentId", async ({ db, u }) => ids(await F.getDocs(F.query(F.collection(db, `q${u}`), F.orderBy(F.documentId()), F.limit(3)))));
add("firestore", "orderBy excludes docs missing the field", async ({ db, u }) => { await F.setDoc(F.doc(db, `q${u}`, "zz"), { other: 1 }); const r = ids(await F.getDocs(F.query(F.collection(db, `q${u}`), F.orderBy("pop")))); await F.deleteDoc(F.doc(db, `q${u}`, "zz")); return r; });
add("firestore", "collection group query", async ({ db, u }) => { await F.setDoc(F.doc(db, `q${u}/sf/lm${u}/a`), { n: 1 }); await F.setDoc(F.doc(db, `q${u}/ny/lm${u}/b`), { n: 2 }); return (await F.getDocs(F.query(F.collectionGroup(db, `lm${u}`), F.orderBy("n")))).docs.map((d) => d.ref.path.replace(u, "U").replace(u, "U")); });
add("firestore", "subcollection query is scoped to parent", async ({ db, u }) => ids(await F.getDocs(F.collection(db, `q${u}/sf/lm${u}`))));
add("firestore", "count aggregation", async ({ db, u }) => (await F.getCountFromServer(F.collection(db, `q${u}`))).data().count);
add("firestore", "sum and average aggregation", async ({ db, u }) => (await F.getAggregateFromServer(F.collection(db, `q${u}`), { s: F.sum("pop"), a: F.average("pop") })).data());
add("firestore", "filtered count", async ({ db, u }) => (await F.getCountFromServer(F.query(F.collection(db, `q${u}`), F.where("capital", "==", true)))).data().count);
add("firestore", "batch is atomic on failure", async ({ db, u }) => { const b = F.writeBatch(db); b.set(F.doc(db, `b${u}`, "a"), { v: 1 }); b.update(F.doc(db, `b${u}`, "missing"), { v: 2 }); const r = await attempt(() => b.commit()); return { r, exists: (await F.getDoc(F.doc(db, `b${u}`, "a"))).exists() }; });
add("firestore", "batch commits multiple writes", async ({ db, u }) => { const b = F.writeBatch(db); b.set(F.doc(db, `b${u}`, "x"), { v: 1 }); b.set(F.doc(db, `b${u}`, "y"), { v: 2 }); b.delete(F.doc(db, `b${u}`, "x")); await b.commit(); return ids(await F.getDocs(F.collection(db, `b${u}`))); });
add("firestore", "transaction read-modify-write", async ({ db, u }) => { await F.setDoc(F.doc(db, `x${u}`, "acct"), { bal: 100 }); return F.runTransaction(db, async (t) => { const s = await t.get(F.doc(db, `x${u}`, "acct")); t.update(F.doc(db, `x${u}`, "acct"), { bal: s.data().bal - 30 }); return s.data().bal - 30; }); });
add("firestore", "concurrent transactions serialize", async ({ db, u }) => { await Promise.all([1, 2, 3, 4].map(() => F.runTransaction(db, async (t) => { const s = await t.get(F.doc(db, `x${u}`, "acct")); t.update(F.doc(db, `x${u}`, "acct"), { bal: s.data().bal + 1 }); }))); return (await F.getDoc(F.doc(db, `x${u}`, "acct"))).data().bal; });
add("firestore", "transaction create on missing doc", async ({ db, u }) => F.runTransaction(db, async (t) => { const s = await t.get(F.doc(db, `x${u}`, "new")); t.set(F.doc(db, `x${u}`, "new"), { ok: true }); return s.exists(); }));
add("firestore", "onSnapshot initial and incremental", async ({ db, u }) => {
  const sizes = [];
  await new Promise((resolve, reject) => {
    const unsub = F.onSnapshot(F.query(F.collection(db, `l${u}`), F.orderBy("n")), { includeMetadataChanges: true }, (s) => {
      if (s.metadata.hasPendingWrites || s.metadata.fromCache) return;
      if (sizes.length && sizes[sizes.length - 1] === s.size) return;
      sizes.push(s.size);
      if (sizes.length === 1) void F.setDoc(F.doc(db, `l${u}`, "a"), { n: 1 });
      else if (sizes.length === 2) void F.setDoc(F.doc(db, `l${u}`, "b"), { n: 2 });
      else if (sizes.length === 3) void F.deleteDoc(F.doc(db, `l${u}`, "a"));
      else { unsub(); resolve(); }
    }, reject);
  });
  return sizes;
});
add("firestore", "onSnapshot docChanges types", async ({ db, u }) => {
  const changes = [];
  await new Promise((resolve) => {
    let n = 0;
    // Latency compensation raises each local change immediately; metadata-only snapshots are skipped.
    const unsub = F.onSnapshot(F.collection(db, `m${u}`), (s) => {
      const ch = s.docChanges();
      if (n > 0 && !ch.length) return;
      for (const c of ch) changes.push(`${c.type}:${c.doc.id}`);
      n++;
      if (n === 1) void F.setDoc(F.doc(db, `m${u}`, "a"), { v: 1 });
      else if (n === 2) void F.updateDoc(F.doc(db, `m${u}`, "a"), { v: 2 });
      else if (n === 3) void F.deleteDoc(F.doc(db, `m${u}`, "a"));
      else { unsub(); resolve(); }
    });
  });
  return changes;
});
add("firestore", "query listener sees doc leave the result set", async ({ db, u }) => {
  await F.setDoc(F.doc(db, `r${u}`, "a"), { on: true });
  const sizes = [];
  await new Promise((resolve) => {
    const unsub = F.onSnapshot(F.query(F.collection(db, `r${u}`), F.where("on", "==", true)), (s) => {
      if (s.metadata.hasPendingWrites) return;
      sizes.push(s.size);
      if (sizes.length === 1) void F.updateDoc(F.doc(db, `r${u}`, "a"), { on: false });
      else { unsub(); resolve(); }
    });
  });
  return sizes;
});

// ---------------------------------------------------------------- Realtime Database
add("database", "set and get object", async ({ rtdb, u }) => { await D.set(D.ref(rtdb, `${u}/a`), { x: 1, y: "two", z: [1, 2] }); return (await D.get(D.ref(rtdb, `${u}/a`))).val(); });
add("database", "get missing path is null", async ({ rtdb, u }) => (await D.get(D.ref(rtdb, `${u}/missing`))).val());
add("database", "update merges children", async ({ rtdb, u }) => { await D.update(D.ref(rtdb, `${u}/a`), { y: null, w: true }); return (await D.get(D.ref(rtdb, `${u}/a`))).val(); });
add("database", "multi-path update", async ({ rtdb, u }) => { await D.update(D.ref(rtdb, u), { "p/one": 1, "p/two": 2 }); return (await D.get(D.ref(rtdb, `${u}/p`))).val(); });
add("database", "remove deletes value", async ({ rtdb, u }) => { await D.remove(D.ref(rtdb, `${u}/p/one`)); return (await D.get(D.ref(rtdb, `${u}/p`))).val(); });
add("database", "push keys are ordered", async ({ rtdb, u }) => { const a = (await D.push(D.ref(rtdb, `${u}/l`), 1)).key; const b = (await D.push(D.ref(rtdb, `${u}/l`), 2)).key; return { len: a.length, ordered: a < b, vals: Object.values((await D.get(D.ref(rtdb, `${u}/l`))).val()) }; });
add("database", "server timestamp", async ({ rtdb, u }) => { await D.set(D.ref(rtdb, `${u}/ts`), D.serverTimestamp()); return typeof (await D.get(D.ref(rtdb, `${u}/ts`))).val(); });
add("database", "server increment", async ({ rtdb, u }) => { await D.set(D.ref(rtdb, `${u}/n`), 5); await D.set(D.ref(rtdb, `${u}/n`), D.increment(3)); return (await D.get(D.ref(rtdb, `${u}/n`))).val(); });
add("database", "transaction on number", async ({ rtdb, u }) => (await D.runTransaction(D.ref(rtdb, `${u}/n`), (v) => (v ?? 0) + 1)).snapshot.val());
add("database", "concurrent transactions", async ({ rtdb, u }) => { await Promise.all([1, 2, 3].map(() => D.runTransaction(D.ref(rtdb, `${u}/n`), (v) => (v ?? 0) + 1))); return (await D.get(D.ref(rtdb, `${u}/n`))).val(); });
add("database", "transaction on object", async ({ rtdb, u }) => (await D.runTransaction(D.ref(rtdb, `${u}/a`), (v) => ({ ...(v ?? {}), count: ((v ?? {}).count ?? 0) + 1 }))).snapshot.val());
add("database", "transaction abort", async ({ rtdb, u }) => (await D.runTransaction(D.ref(rtdb, `${u}/n`), () => undefined)).committed);
add("database", "orderByChild limitToFirst", async ({ rtdb, u }) => { await D.set(D.ref(rtdb, `${u}/s`), { a: { v: 3 }, b: { v: 1 }, c: { v: 2 }, d: { v: 5 } }); return keysOf(await once(D.query(D.ref(rtdb, `${u}/s`), D.orderByChild("v"), D.limitToFirst(2)))); });
add("database", "orderByChild startAt endAt", async ({ rtdb, u }) => keysOf(await once(D.query(D.ref(rtdb, `${u}/s`), D.orderByChild("v"), D.startAt(2), D.endAt(3)))));
add("database", "orderByKey limitToLast", async ({ rtdb, u }) => { const keys = []; (await D.get(D.query(D.ref(rtdb, `${u}/s`), D.orderByKey(), D.limitToLast(2)))).forEach((c) => { keys.push(c.key); }); return keys; });
add("database", "orderByValue", async ({ rtdb, u }) => { await D.set(D.ref(rtdb, `${u}/ov`), { x: 3, y: 1, z: 2 }); return keysOf(await once(D.query(D.ref(rtdb, `${u}/ov`), D.orderByValue()))); });
add("database", "equalTo", async ({ rtdb, u }) => keysOf(await once(D.query(D.ref(rtdb, `${u}/s`), D.orderByChild("v"), D.equalTo(5)))));
add("database", "onValue receives updates", async ({ rtdb, u }) => { const vals = []; await new Promise((res) => { const un = D.onValue(D.ref(rtdb, `${u}/live`), (s) => { vals.push(s.val()); if (vals.length === 1) void D.set(D.ref(rtdb, `${u}/live`), "x"); else if (vals.length === 2) void D.set(D.ref(rtdb, `${u}/live`), "y"); else { un(); res(); } }); }); return vals; });
add("database", "child events", async ({ rtdb, u }) => { const ev = []; await new Promise((res) => { const r = D.ref(rtdb, `${u}/ch`); const u1 = D.onChildAdded(r, (s) => ev.push(`added:${s.key}`)); const u2 = D.onChildChanged(r, (s) => ev.push(`changed:${s.key}`)); const u3 = D.onChildRemoved(r, (s) => { ev.push(`removed:${s.key}`); u1(); u2(); u3(); res(); }); void D.set(D.ref(rtdb, `${u}/ch/a`), 1).then(() => D.set(D.ref(rtdb, `${u}/ch/a`), 2)).then(() => D.remove(D.ref(rtdb, `${u}/ch/a`))); }); return ev; });
add("database", "arrays become objects with numeric keys", async ({ rtdb, u }) => { await D.set(D.ref(rtdb, `${u}/arr`), ["a", "b"]); return (await D.get(D.ref(rtdb, `${u}/arr`))).val(); });

// ---------------------------------------------------------------- Storage
add("storage", "upload string returns size and type", async ({ storage, u }) => { const r = await S.uploadString(S.ref(storage, `${u}/a.txt`), "hello world", "raw", { contentType: "text/plain" }); return { size: r.metadata.size, type: r.metadata.contentType, name: r.metadata.name.replace(u, "U") }; });
add("storage", "metadata has md5 and generation", async ({ storage, u }) => { const m = await S.getMetadata(S.ref(storage, `${u}/a.txt`)); return { md5: m.md5Hash, gen: typeof m.generation, metagen: m.metageneration, bucket: m.bucket, path: m.fullPath.replace(u, "U") }; });
add("storage", "download url serves content", async ({ storage, u }) => { const url = await S.getDownloadURL(S.ref(storage, `${u}/a.txt`)); return { media: url.includes("alt=media"), token: url.includes("token="), body: await (await fetch(url)).text() }; });
add("storage", "getBytes", async ({ storage, u }) => new TextDecoder().decode(await S.getBytes(S.ref(storage, `${u}/a.txt`))));
add("storage", "custom metadata", async ({ storage, u }) => { await S.uploadString(S.ref(storage, `${u}/b.txt`), "x", "raw", { customMetadata: { k: "v" } }); return (await S.getMetadata(S.ref(storage, `${u}/b.txt`))).customMetadata; });
add("storage", "update metadata", async ({ storage, u }) => { const m = await S.updateMetadata(S.ref(storage, `${u}/b.txt`), { contentType: "text/csv", customMetadata: { k: "w" } }); return { t: m.contentType, k: m.customMetadata.k, metagen: m.metageneration }; });
add("storage", "upload bytes default content type", async ({ storage, u }) => (await S.uploadBytes(S.ref(storage, `${u}/c.bin`), new Uint8Array([1, 2, 3]))).metadata.contentType);
add("storage", "resumable upload of 600 KiB", async ({ storage, u }) => { const data = new Uint8Array(600 * 1024).map((_, i) => i % 251); const s = await S.uploadBytesResumable(S.ref(storage, `${u}/big.bin`), data); const back = new Uint8Array(await S.getBytes(S.ref(storage, `${u}/big.bin`))); return { total: s.totalBytes, back: back.length, sample: back[12345] }; });
add("storage", "listAll with prefixes", async ({ storage, u }) => { await S.uploadString(S.ref(storage, `${u}/sub/d.txt`), "d"); const r = await S.listAll(S.ref(storage, u)); return { items: r.items.map((i) => i.name).sort(), prefixes: r.prefixes.map((p) => p.name) }; });
add("storage", "list with maxResults pages", async ({ storage, u }) => { const p = await S.list(S.ref(storage, u), { maxResults: 2 }); return { n: p.items.length, more: !!p.nextPageToken }; });
add("storage", "delete then metadata fails", async ({ storage, u }) => { await S.deleteObject(S.ref(storage, `${u}/c.bin`)); return attempt(() => S.getMetadata(S.ref(storage, `${u}/c.bin`))); });
add("storage", "delete missing object fails", async ({ storage, u }) => attempt(() => S.deleteObject(S.ref(storage, `${u}/never.bin`))));
