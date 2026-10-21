import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectStorageEmulator, deleteObject, getBytes, getDownloadURL, getMetadata, getStorage, list, listAll, ref, updateMetadata, uploadBytes, uploadBytesResumable, uploadString, type FirebaseStorage } from "firebase/storage";
import { newApp, startServer } from "./helpers.js";
import type { FirebaseCompatServer } from "../src/index.js";

let server: FirebaseCompatServer;
let storage: FirebaseStorage;

beforeAll(async () => {
  const s = await startServer();
  server = s.server;
  storage = getStorage(newApp());
  connectStorageEmulator(storage, "127.0.0.1", s.port);
});
afterAll(() => server.stop());

describe("storage with the unmodified Firebase SDK", () => {
  it("uploads with multipart and reads metadata", async () => {
    const r = ref(storage, "docs/hello.txt");
    const res = await uploadString(r, "hello world", "raw", { contentType: "text/plain", customMetadata: { owner: "alice" } });
    expect(res.metadata.size).toBe(11);
    const meta = await getMetadata(r);
    expect(meta.contentType).toBe("text/plain");
    expect(meta.customMetadata).toEqual({ owner: "alice" });
    expect(meta.md5Hash).toBe("XrY7u+Ae7tCTyyK7j1rNww==");
  });
  it("produces working download URLs", async () => {
    const url = await getDownloadURL(ref(storage, "docs/hello.txt"));
    expect(url).toContain("alt=media");
    expect(await (await fetch(url)).text()).toBe("hello world");
    expect(new TextDecoder().decode(await getBytes(ref(storage, "docs/hello.txt")))).toBe("hello world");
  });
  it("uploads large binary files with the resumable protocol", async () => {
    const data = new Uint8Array(600 * 1024).map((_, i) => i % 251);
    const task = uploadBytesResumable(ref(storage, "big/blob.bin"), data, { contentType: "application/octet-stream" });
    const snap = await task;
    expect(snap.totalBytes).toBe(data.length);
    const back = new Uint8Array(await getBytes(ref(storage, "big/blob.bin")));
    expect(back.length).toBe(data.length);
    expect(back[1000]).toBe(1000 % 251);
  });
  it("updates metadata", async () => {
    const meta = await updateMetadata(ref(storage, "docs/hello.txt"), { cacheControl: "public, max-age=60", customMetadata: { owner: "bob" } });
    expect(meta.cacheControl).toBe("public, max-age=60");
    expect(meta.customMetadata?.owner).toBe("bob");
    expect(meta.metageneration).toBe("2");
  });
  it("lists with prefixes and pagination", async () => {
    await uploadBytes(ref(storage, "docs/a.txt"), new Uint8Array([1]));
    await uploadBytes(ref(storage, "docs/sub/b.txt"), new Uint8Array([2]));
    const all = await listAll(ref(storage, "docs"));
    expect(all.items.map((i) => i.name).sort()).toEqual(["a.txt", "hello.txt"]);
    expect(all.prefixes.map((p) => p.name)).toEqual(["sub"]);
    const page = await list(ref(storage, "docs"), { maxResults: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.nextPageToken).toBeTruthy();
  });
  it("deletes objects and reports missing ones", async () => {
    await deleteObject(ref(storage, "docs/a.txt"));
    await expect(getMetadata(ref(storage, "docs/a.txt"))).rejects.toMatchObject({ code: "storage/object-not-found" });
    expect(server.storage.objects.has("demo-project.appspot.com/docs/a.txt")).toBe(false);
  });
});
