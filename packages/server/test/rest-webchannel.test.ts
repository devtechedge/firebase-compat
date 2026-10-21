import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { startServer } from "./helpers.js";
import type { FirebaseCompatServer } from "../src/index.js";

let server: FirebaseCompatServer;
let base: string;
const db = "projects/demo-project/databases/(default)";

beforeAll(async () => {
  const s = await startServer();
  server = s.server;
  base = `http://127.0.0.1:${s.port}`;
});
afterAll(() => server.stop());

const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }).then(async (r) => ({ status: r.status, json: await r.json() }));

describe("firestore REST", () => {
  it("creates, reads, patches and deletes documents", async () => {
    const created = await post(`/v1/${db}/documents/items?documentId=one`, { fields: { n: { integerValue: "1" } } });
    expect(created.json.name).toBe(`${db}/documents/items/one`);
    const patched = await fetch(`${base}/v1/${db}/documents/items/one?updateMask.fieldPaths=m`, { method: "PATCH", body: JSON.stringify({ fields: { m: { stringValue: "x" } } }) }).then((r) => r.json());
    expect(patched.fields).toEqual({ n: { integerValue: "1" }, m: { stringValue: "x" } });
    expect((await fetch(`${base}/v1/${db}/documents/items`).then((r) => r.json())).documents).toHaveLength(1);
    await fetch(`${base}/v1/${db}/documents/items/one`, { method: "DELETE" });
    expect((await fetch(`${base}/v1/${db}/documents/items/one`)).status).toBe(404);
  });
  it("commits with preconditions and maps errors", async () => {
    const r = await post(`/v1/${db}/documents:commit`, { writes: [{ update: { name: `${db}/documents/items/two`, fields: {} }, currentDocument: { exists: true } }] });
    expect(r.status).toBe(404);
    expect(r.json.error.status).toBe("NOT_FOUND");
  });
  it("streams runQuery results as a JSON array", async () => {
    await post(`/v1/${db}/documents:commit`, { writes: [1, 2, 3].map((i) => ({ update: { name: `${db}/documents/q/${i}`, fields: { i: { integerValue: String(i) } } } })) });
    const r = await post(`/v1/${db}/documents:runQuery`, { structuredQuery: { from: [{ collectionId: "q" }], orderBy: [{ field: { fieldPath: "i" }, direction: "DESCENDING" }], limit: 2 } });
    expect(r.json.map((x: any) => x.document.fields.i.integerValue)).toEqual(["3", "2"]);
  });
  it("lists collection ids and resets like the emulator", async () => {
    expect((await post(`/v1/${db}/documents:listCollectionIds`, {})).json.collectionIds).toContain("q");
    await fetch(`${base}/emulator/v1/projects/demo-project/databases/(default)/documents`, { method: "DELETE" });
    expect(server.firestore.docs.size).toBe(0);
  });
});

describe("webchannel transport", () => {
  it("opens a Listen session and streams length-prefixed frames", async () => {
    const q = `VER=8&database=${encodeURIComponent(db)}&RID=1&CVER=22&X-HTTP-Session-Id=gsessionid&t=1`;
    const form = new URLSearchParams({ count: "1", ofs: "0", req0___data__: JSON.stringify({ database: db, addTarget: { targetId: 2, query: { parent: `${db}/documents`, structuredQuery: { from: [{ collectionId: "wc" }] } } } }) });
    const open = await fetch(`${base}/google.firestore.v1.Firestore/Listen/channel?${q}`, { method: "POST", body: form }).then((r) => r.text());
    const [len, payload] = open.split("\n");
    expect(Number(len)).toBe(payload.length);
    const sid = JSON.parse(payload)[0][1][1];
    const chunks: string[] = [];
    await new Promise<void>((resolve) => {
      http.get(`${base}/google.firestore.v1.Firestore/Listen/channel?VER=8&RID=rpc&SID=${encodeURIComponent(sid)}&AID=0&CI=0&TYPE=xmlhttp`, (res) => {
        res.on("data", (c) => {
          chunks.push(String(c));
          if (chunks.join("").includes("CURRENT")) { res.destroy(); resolve(); }
        });
      });
    });
    const text = chunks.join("");
    expect(text).toContain('"targetChangeType":"ADD"');
    expect(text).toContain('"targetChangeType":"CURRENT"');
    await fetch(`${base}/google.firestore.v1.Firestore/Listen/channel?SID=${encodeURIComponent(sid)}&TYPE=terminate`);
  });
  it("rejects unknown sessions so the SDK reconnects", async () => {
    const r = await fetch(`${base}/google.firestore.v1.Firestore/Write/channel?SID=nope&RID=rpc&AID=0&TYPE=xmlhttp`);
    expect(r.status).toBe(400);
  });
});
