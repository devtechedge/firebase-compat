import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectAuthEmulator, getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, type Auth } from "firebase/auth";
import { collection, connectFirestoreEmulator, doc, getDoc, getDocs, getFirestore, query, setDoc, where, type Firestore } from "firebase/firestore";
import { newApp, startServer } from "./helpers.js";
import type { FirebaseCompatServer } from "../src/index.js";

const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /profiles/{uid} {
      allow read: if request.auth != null;
      allow write: if request.auth != null && request.auth.uid == uid;
    }
    match /notes/{id} {
      allow read: if request.auth != null && resource.data.owner == request.auth.uid;
      allow create: if request.auth != null && request.resource.data.owner == request.auth.uid;
    }
  }
}`;

let server: FirebaseCompatServer;
let auth: Auth;
let db: Firestore;

beforeAll(async () => {
  const s = await startServer({ rules });
  server = s.server;
  const app = newApp();
  auth = getAuth(app);
  connectAuthEmulator(auth, `http://127.0.0.1:${s.port}`, { disableWarnings: true });
  db = getFirestore(app);
  connectFirestoreEmulator(db, "127.0.0.1", s.port);
});
afterAll(() => server.stop());

describe("security rules enforced for SDK clients", () => {
  it("denies unauthenticated reads", async () => {
    await expect(getDoc(doc(db, "profiles", "x"))).rejects.toMatchObject({ code: "permission-denied" });
  });
  it("allows owners to write their own profile only", async () => {
    const cred = await createUserWithEmailAndPassword(auth, "rules@example.com", "secret123");
    await setDoc(doc(db, "profiles", cred.user.uid), { name: "me" });
    await expect(setDoc(doc(db, "profiles", "someone-else"), { name: "x" })).rejects.toMatchObject({ code: "permission-denied" });
    expect((await getDoc(doc(db, "profiles", cred.user.uid))).data()).toEqual({ name: "me" });
  });
  it("checks request.resource.data on create and resource.data on read", async () => {
    const uid = auth.currentUser!.uid;
    await setDoc(doc(db, "notes", "mine"), { owner: uid, text: "secret" });
    await expect(setDoc(doc(db, "notes", "theirs"), { owner: "bob", text: "x" })).rejects.toMatchObject({ code: "permission-denied" });
    const mine = await getDocs(query(collection(db, "notes"), where("owner", "==", uid)));
    expect(mine.size).toBe(1);
  });
  it("rejects queries that could return unreadable documents", async () => {
    await server.firestore.commit([{ update: { name: "projects/demo-project/databases/(default)/documents/notes/bobs", fields: { owner: { stringValue: "bob" } } } }], { auth: null, admin: true });
    await expect(getDocs(collection(db, "notes"))).rejects.toMatchObject({ code: "permission-denied" });
  });
  it("lets the owner credential bypass rules over REST", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/v1/projects/demo-project/databases/(default)/documents/notes/bobs`, { headers: { authorization: "Bearer owner" } });
    expect(res.status).toBe(200);
    await signOut(auth);
  });
  it("hot swaps rules through the admin API", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/__admin/firestore/rules`, { method: "PUT", body: JSON.stringify({ source: "service cloud.firestore { match /databases/{d}/documents { match /{doc=**} { allow read; } } }" }) });
    expect(res.status).toBe(200);
    expect((await getDoc(doc(db, "profiles", "x"))).exists()).toBe(false);
    const bad = await fetch(`http://127.0.0.1:${server.port}/__admin/firestore/rules`, { method: "PUT", body: JSON.stringify({ source: "service cloud.firestore { match" }) });
    expect(bad.status).toBe(400);
  });
});
