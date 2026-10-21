import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addDoc, arrayRemove, arrayUnion, collection, collectionGroup, connectFirestoreEmulator, deleteDoc, deleteField, doc, documentId,
  getAggregateFromServer, getCountFromServer, getDoc, getDocs, getFirestore, increment, limit, limitToLast, onSnapshot, or, orderBy,
  query, runTransaction, serverTimestamp, setDoc, startAfter, sum, average, Timestamp, updateDoc, where, writeBatch, type Firestore,
} from "firebase/firestore";
import { newApp, startServer } from "./helpers.js";
import type { FirebaseCompatServer } from "../src/index.js";

let server: FirebaseCompatServer;
let db: Firestore;

beforeAll(async () => {
  const s = await startServer();
  server = s.server;
  db = getFirestore(newApp());
  connectFirestoreEmulator(db, "127.0.0.1", s.port);
  const b = writeBatch(db);
  for (const [id, name, pop, state, tags] of [["sf", "San Francisco", 870, "CA", ["west", "coast"]], ["la", "Los Angeles", 3900, "CA", ["west"]], ["ny", "New York", 8400, "NY", ["east", "coast"]], ["dc", "Washington", 690, null, ["east"]]] as const) {
    b.set(doc(db, "cities", id), { name, pop, state, tags });
  }
  await b.commit();
});
afterAll(() => server.stop());

describe("firestore with the unmodified Firebase SDK (gRPC)", () => {
  it("writes and reads documents with rich types", async () => {
    const ts = Timestamp.fromMillis(1700000000123);
    await setDoc(doc(db, "types", "a"), { s: "x", n: 1, d: 1.5, b: true, nil: null, ts, arr: [1, "two"], map: { nested: { deep: 1 } }, ref: doc(db, "cities", "sf") });
    const snap = await getDoc(doc(db, "types", "a"));
    const data = snap.data()!;
    expect(data.s).toBe("x");
    expect(data.d).toBe(1.5);
    expect(data.ts.toMillis()).toBe(1700000000123);
    expect(data.map.nested.deep).toBe(1);
    expect(data.ref.path).toBe("cities/sf");
  });
  it("reports missing documents", async () => {
    expect((await getDoc(doc(db, "types", "missing"))).exists()).toBe(false);
  });
  it("merges and updates fields", async () => {
    await setDoc(doc(db, "types", "a"), { extra: 1 }, { merge: true });
    await updateDoc(doc(db, "types", "a"), { "map.nested.deep": 2, s: deleteField() });
    const data = (await getDoc(doc(db, "types", "a"))).data()!;
    expect(data.extra).toBe(1);
    expect(data.map.nested.deep).toBe(2);
    expect("s" in data).toBe(false);
  });
  it("fails updates on missing documents", async () => {
    await expect(updateDoc(doc(db, "types", "nope"), { a: 1 })).rejects.toMatchObject({ code: "not-found" });
  });
  it("applies field transforms", async () => {
    await setDoc(doc(db, "counters", "c"), { n: 1, tags: ["a"] });
    await updateDoc(doc(db, "counters", "c"), { n: increment(5), tags: arrayUnion("b", "a"), at: serverTimestamp() });
    await updateDoc(doc(db, "counters", "c"), { tags: arrayRemove("a") });
    const data = (await getDoc(doc(db, "counters", "c"))).data()!;
    expect(data.n).toBe(6);
    expect(data.tags).toEqual(["b"]);
    expect(data.at).toBeInstanceOf(Timestamp);
  });
  it("runs filtered and ordered queries", async () => {
    const q = query(collection(db, "cities"), where("state", "==", "CA"), orderBy("pop", "desc"));
    expect((await getDocs(q)).docs.map((d) => d.id)).toEqual(["la", "sf"]);
    const q2 = query(collection(db, "cities"), where("tags", "array-contains", "east"), orderBy("name"));
    expect((await getDocs(q2)).docs.map((d) => d.id)).toEqual(["ny", "dc"]);
    const q3 = query(collection(db, "cities"), where("state", "in", ["NY", "CA"]), orderBy(documentId()));
    expect((await getDocs(q3)).docs.map((d) => d.id)).toEqual(["la", "ny", "sf"]);
  });
  it("supports OR queries and != filters", async () => {
    const q = query(collection(db, "cities"), or(where("pop", ">", 5000), where("name", "==", "Washington")));
    expect((await getDocs(q)).docs.map((d) => d.id).sort()).toEqual(["dc", "ny"]);
    const q2 = query(collection(db, "cities"), where("state", "!=", "CA"));
    expect((await getDocs(q2)).docs.map((d) => d.id)).toEqual(["ny"]);
  });
  it("paginates with limit, cursors and limitToLast", async () => {
    const first = await getDocs(query(collection(db, "cities"), orderBy("pop"), limit(2)));
    expect(first.docs.map((d) => d.id)).toEqual(["dc", "sf"]);
    const next = await getDocs(query(collection(db, "cities"), orderBy("pop"), startAfter(first.docs[1]), limit(2)));
    expect(next.docs.map((d) => d.id)).toEqual(["la", "ny"]);
    const last = await getDocs(query(collection(db, "cities"), orderBy("pop"), limitToLast(1)));
    expect(last.docs.map((d) => d.id)).toEqual(["ny"]);
  });
  it("runs collection group queries", async () => {
    await setDoc(doc(db, "cities/sf/landmarks/gg"), { name: "Golden Gate" });
    await setDoc(doc(db, "cities/ny/landmarks/sol"), { name: "Statue of Liberty" });
    const snap = await getDocs(collectionGroup(db, "landmarks"));
    expect(snap.size).toBe(2);
  });
  it("computes count, sum and average aggregations", async () => {
    expect((await getCountFromServer(collection(db, "cities"))).data().count).toBe(4);
    const agg = await getAggregateFromServer(collection(db, "cities"), { total: sum("pop"), avg: average("pop") });
    expect(agg.data().total).toBe(13860);
    expect(agg.data().avg).toBe(3465);
  });
  it("commits batched writes atomically", async () => {
    const b = writeBatch(db);
    b.set(doc(db, "batch", "a"), { v: 1 });
    b.update(doc(db, "batch", "missing"), { v: 2 });
    await expect(b.commit()).rejects.toBeTruthy();
    expect((await getDoc(doc(db, "batch", "a"))).exists()).toBe(false);
  });
  it("runs transactions with retries on contention", async () => {
    await setDoc(doc(db, "tx", "acct"), { balance: 100 });
    const results = await Promise.all([1, 2, 3].map(() => runTransaction(db, async (t) => {
      const s = await t.get(doc(db, "tx", "acct"));
      t.update(doc(db, "tx", "acct"), { balance: s.data()!.balance - 10 });
    })));
    expect(results).toHaveLength(3);
    expect((await getDoc(doc(db, "tx", "acct"))).data()!.balance).toBe(70);
  });
  it("streams realtime updates with onSnapshot", async () => {
    const seen: number[] = [];
    await new Promise<void>((resolve, reject) => {
      let step = 0;
      const unsub = onSnapshot(query(collection(db, "live"), orderBy("n")), { includeMetadataChanges: true }, (s) => {
        if (s.metadata.hasPendingWrites || s.metadata.fromCache) return;
        if (seen.length && seen[seen.length - 1] === s.size) return;
        seen.push(s.size);
        step++;
        if (step === 1) void addDoc(collection(db, "live"), { n: 1 });
        else if (step === 2) void addDoc(collection(db, "live"), { n: 2 });
        else if (step === 3) void deleteDoc(s.docs[0].ref);
        else { unsub(); resolve(); }
      }, reject);
    });
    expect(seen).toEqual([0, 1, 2, 1]);
  });
  it("delivers document listener changes from other clients", async () => {
    await setDoc(doc(db, "live2", "x"), { v: 1 });
    const values: number[] = [];
    await new Promise<void>((resolve) => {
      const unsub = onSnapshot(doc(db, "live2", "x"), (s) => {
        values.push(s.data()?.v);
        if (values.length === 1) {
          void server.firestore.commit([{ update: { name: `projects/demo-project/databases/(default)/documents/live2/x`, fields: { v: { integerValue: "2" } } } }], { auth: null, admin: true });
        } else { unsub(); resolve(); }
      });
    });
    expect(values).toEqual([1, 2]);
  });
});
