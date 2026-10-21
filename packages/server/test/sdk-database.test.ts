import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectDatabaseEmulator, get, getDatabase, limitToLast, onChildAdded, onDisconnect, onValue, orderByChild, push, query, ref, remove, runTransaction, serverTimestamp, set, update, increment, equalTo, goOffline, type Database } from "firebase/database";
import { newApp, startServer } from "./helpers.js";
import type { FirebaseCompatServer } from "../src/index.js";

let server: FirebaseCompatServer;
let db: Database;
let port: number;

beforeAll(async () => {
  const s = await startServer();
  server = s.server;
  port = s.port;
  db = getDatabase(newApp());
  connectDatabaseEmulator(db, "127.0.0.1", port);
});
afterAll(async () => { goOffline(db); await server.stop(); });

describe("realtime database with the unmodified Firebase SDK", () => {
  it("sets and gets values", async () => {
    await set(ref(db, "a/b"), { x: 1, y: "two" });
    expect((await get(ref(db, "a/b"))).val()).toEqual({ x: 1, y: "two" });
    expect(server.database.get("demo-project", "a/b/x")).toBe(1);
  });
  it("updates children and removes values", async () => {
    await update(ref(db, "a/b"), { y: null, z: true });
    expect((await get(ref(db, "a/b"))).val()).toEqual({ x: 1, z: true });
    await remove(ref(db, "a/b/z"));
    expect((await get(ref(db, "a/b"))).val()).toEqual({ x: 1 });
  });
  it("pushes ordered keys", async () => {
    const k1 = (await push(ref(db, "list"), { n: 1 })).key!;
    const k2 = (await push(ref(db, "list"), { n: 2 })).key!;
    expect(k1 < k2).toBe(true);
    expect(Object.keys((await get(ref(db, "list"))).val())).toEqual([k1, k2]);
  });
  it("resolves server values", async () => {
    await set(ref(db, "sv"), { at: serverTimestamp(), n: 1 });
    await update(ref(db, "sv"), { n: increment(4) });
    const v = (await get(ref(db, "sv"))).val();
    expect(typeof v.at).toBe("number");
    expect(v.n).toBe(5);
  });
  it("runs transactions with hash compare-and-set", async () => {
    await set(ref(db, "counter"), 10);
    const results = await Promise.all([1, 2, 3].map(() => runTransaction(ref(db, "counter"), (v) => (v ?? 0) + 1)));
    expect(results.every((r) => r.committed)).toBe(true);
    expect((await get(ref(db, "counter"))).val()).toBe(13);
  });
  it("streams value events including changes from the server side", async () => {
    const values: unknown[] = [];
    await new Promise<void>((resolve) => {
      const unsub = onValue(ref(db, "live"), (s) => {
        values.push(s.val());
        if (values.length === 1) server.database.set("demo-project", "live", { msg: "hello" });
        else { unsub(); resolve(); }
      });
    });
    expect(values).toEqual([null, { msg: "hello" }]);
  });
  it("supports ordered and limited queries", async () => {
    await set(ref(db, "scores"), { a: { s: 5 }, b: { s: 1 }, c: { s: 9 }, d: { s: 5 } });
    const top = await get(query(ref(db, "scores"), orderByChild("s"), limitToLast(2)));
    const keys: string[] = [];
    top.forEach((c) => { keys.push(c.key!); });
    expect(keys).toEqual(["d", "c"]);
    const fives = await get(query(ref(db, "scores"), orderByChild("s"), equalTo(5)));
    expect(Object.keys(fives.val())).toEqual(["a", "d"]);
  });
  it("fires child_added for new children", async () => {
    const added: string[] = [];
    await new Promise<void>((resolve) => {
      const unsub = onChildAdded(ref(db, "chat"), (s) => {
        added.push(s.val().text);
        if (added.length === 2) { unsub(); resolve(); }
      });
      void push(ref(db, "chat"), { text: "hi" }).then(() => push(ref(db, "chat"), { text: "there" }));
    });
    expect(added).toEqual(["hi", "there"]);
  });
  it("registers onDisconnect operations", async () => {
    const other = getDatabase(newApp());
    connectDatabaseEmulator(other, "127.0.0.1", port);
    await set(ref(other, "presence/u1"), "online");
    await onDisconnect(ref(other, "presence/u1")).set("offline");
    goOffline(other);
    await new Promise((r) => setTimeout(r, 300));
    expect(server.database.get("demo-project", "presence/u1")).toBe("offline");
  });
  it("serves the REST .json API", async () => {
    const base = `http://127.0.0.1:${port}`;
    await fetch(`${base}/rest/item.json?ns=demo-project`, { method: "PUT", body: JSON.stringify({ a: 1 }) });
    const posted = await (await fetch(`${base}/rest/list.json?ns=demo-project`, { method: "POST", body: JSON.stringify("x") })).json();
    expect(posted.name).toHaveLength(20);
    expect(await (await fetch(`${base}/rest/item.json?ns=demo-project`)).json()).toEqual({ a: 1 });
    expect((await get(ref(db, "rest/item/a"))).val()).toBe(1);
  });
});
