// Resolves the caller's identity for Firestore requests: the emulator-style "owner" credential is
// an administrator, a valid ID token yields request.auth, anything else is unauthenticated.
import type { AuthService } from "../auth/service.js";
import type { AccessContext } from "./engine.js";

export function accessFromToken(auth: AuthService, token: string | undefined): AccessContext {
  if (!token) return { auth: null, admin: false };
  if (token === "owner") return { auth: null, admin: true };
  const claims = auth.verifyIdToken(token);
  return { auth: claims, admin: false };
}
