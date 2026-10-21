import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectAuthEmulator, createUserWithEmailAndPassword, deleteUser, getAuth, signInAnonymously, signInWithCustomToken, signInWithEmailAndPassword, signOut, updatePassword, updateProfile, fetchSignInMethodsForEmail, sendPasswordResetEmail, type Auth } from "firebase/auth";
import { newApp, startServer } from "./helpers.js";
import type { FirebaseCompatServer } from "../src/index.js";

let server: FirebaseCompatServer;
let auth: Auth;
const email = `alice${Date.now()}@example.com`;

beforeAll(async () => {
  const s = await startServer();
  server = s.server;
  auth = getAuth(newApp());
  connectAuthEmulator(auth, `http://127.0.0.1:${s.port}`, { disableWarnings: true });
});
afterAll(() => server.stop());

const unsignedJwt = (payload: object) => `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.`;

describe("auth with the unmodified Firebase SDK", () => {
  it("signs up with email and password", async () => {
    const cred = await createUserWithEmailAndPassword(auth, email, "secret123");
    expect(cred.user.email).toBe(email);
    expect(cred.user.uid).toHaveLength(28);
    const token = await cred.user.getIdTokenResult();
    expect(token.signInProvider).toBe("password");
    expect(token.claims.email).toBe(email);
  });
  it("rejects duplicate email and weak passwords", async () => {
    await expect(createUserWithEmailAndPassword(auth, email, "secret123")).rejects.toMatchObject({ code: "auth/email-already-in-use" });
    await expect(createUserWithEmailAndPassword(auth, `x${email}`, "123")).rejects.toMatchObject({ code: "auth/weak-password" });
  });
  it("signs out and back in", async () => {
    await signOut(auth);
    expect(auth.currentUser).toBeNull();
    const cred = await signInWithEmailAndPassword(auth, email, "secret123");
    expect(cred.user.email).toBe(email);
  });
  it("reports wrong password and unknown user", async () => {
    await expect(signInWithEmailAndPassword(auth, email, "wrong!!")).rejects.toMatchObject({ code: "auth/wrong-password" });
    await expect(signInWithEmailAndPassword(auth, "nobody@example.com", "secret123")).rejects.toMatchObject({ code: "auth/user-not-found" });
  });
  it("updates profile and password", async () => {
    await signInWithEmailAndPassword(auth, email, "secret123");
    await updateProfile(auth.currentUser!, { displayName: "Alice", photoURL: "https://example.com/a.png" });
    await auth.currentUser!.reload();
    expect(auth.currentUser!.displayName).toBe("Alice");
    await updatePassword(auth.currentUser!, "newsecret1");
    await signOut(auth);
    await expect(signInWithEmailAndPassword(auth, email, "newsecret1")).resolves.toBeTruthy();
  });
  it("refreshes ID tokens through securetoken", async () => {
    const before = await auth.currentUser!.getIdToken();
    await new Promise((r) => setTimeout(r, 1100));
    const after = await auth.currentUser!.getIdToken(true);
    expect(after).not.toBe(before);
  });
  it("lists sign-in methods and sends reset codes", async () => {
    expect(await fetchSignInMethodsForEmail(auth, email)).toEqual(["password"]);
    await sendPasswordResetEmail(auth, email);
    expect(server.auth.oobCodes.some((c) => c.email === email)).toBe(true);
  });
  it("signs in anonymously", async () => {
    const cred = await signInAnonymously(auth);
    expect(cred.user.isAnonymous).toBe(true);
  });
  it("signs in with a custom token carrying claims", async () => {
    const cred = await signInWithCustomToken(auth, unsignedJwt({ uid: "custom-1", claims: { role: "admin" } }));
    expect(cred.user.uid).toBe("custom-1");
    expect((await cred.user.getIdTokenResult()).claims.role).toBe("admin");
  });
  it("issues RS256 tokens verifiable with the published JWKS", async () => {
    const token = await auth.currentUser!.getIdToken();
    const [h] = token.split(".");
    expect(JSON.parse(Buffer.from(h, "base64url").toString()).alg).toBe("RS256");
    expect(server.auth.verifyIdToken(token)?.uid).toBe("custom-1");
  });
  it("deletes the current user", async () => {
    await signInWithEmailAndPassword(auth, email, "newsecret1");
    const uid = auth.currentUser!.uid;
    await deleteUser(auth.currentUser!);
    expect(server.auth.users.has(uid)).toBe(false);
  });
});
