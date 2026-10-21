// Identity Toolkit (v1) and Secure Token compatible authentication service.
// Request and response shapes follow the public REST reference and recorded SDK traffic
// (see evidence/raw/emulator-auth.har and docs/protocol/auth.md).
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Store } from "../util/db.js";
import { bearer, parseJsonOrForm, readBody, sendJson } from "../util/http.js";
import { decodeJwt, KeyRing } from "./jwt.js";

export interface ProviderInfo { providerId: string; email?: string; federatedId?: string; rawId?: string; displayName?: string; photoUrl?: string; phoneNumber?: string }
export interface User {
  localId: string;
  email?: string;
  emailVerified?: boolean;
  displayName?: string;
  photoUrl?: string;
  phoneNumber?: string;
  passwordHash?: string;
  salt?: string;
  passwordUpdatedAt?: number;
  disabled?: boolean;
  customAttributes?: string;
  providerUserInfo?: ProviderInfo[];
  createdAt: string;
  lastLoginAt?: string;
  lastRefreshAt?: string;
  validSince?: string;
  tenantId?: string;
}

export class AuthError extends Error {
  constructor(public reason: string, public status = 400) { super(reason); }
}

const now = () => String(Date.now());

export class AuthService {
  readonly users = new Map<string, User>();
  readonly keys: KeyRing;
  private refreshTokens = new Map<string, string>();
  readonly oobCodes: { oobCode: string; email: string; requestType: string; localId?: string; createdAt: string }[] = [];

  constructor(private store: Store | undefined, readonly projectId: string) {
    this.keys = new KeyRing(store);
    for (const [id, u] of store?.all<User>("auth") ?? []) this.users.set(id, u);
    for (const [t, uid] of store?.all<string>("auth_refresh") ?? []) this.refreshTokens.set(t, uid);
  }

  private save(u: User) {
    this.users.set(u.localId, u);
    this.store?.put("auth", u.localId, u);
  }

  newUid(): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let id = "";
    for (const b of randomBytes(28)) id += chars[b % chars.length];
    return id;
  }

  byEmail(email: string): User | undefined {
    const e = email.toLowerCase();
    for (const u of this.users.values()) if (u.email?.toLowerCase() === e) return u;
    return undefined;
  }

  private hashPassword(password: string, salt = randomBytes(16).toString("base64")) {
    return { salt, passwordHash: scryptSync(password, salt, 32).toString("base64") };
  }

  private checkPassword(u: User, password: string): boolean {
    if (!u.passwordHash || !u.salt) return false;
    const a = Buffer.from(u.passwordHash, "base64");
    const b = scryptSync(password, u.salt, 32);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  signInProvider(u: User): string {
    if (u.providerUserInfo?.some((p) => p.providerId === "password")) return "password";
    if (u.providerUserInfo?.length) return u.providerUserInfo[0].providerId;
    return "anonymous";
  }

  issueTokens(u: User, provider = this.signInProvider(u), extra: Record<string, unknown> = {}) {
    const iat = Math.floor(Date.now() / 1000);
    const identities: Record<string, string[]> = {};
    if (u.email) identities.email = [u.email];
    for (const p of u.providerUserInfo ?? []) if (p.providerId !== "password" && p.rawId) (identities[p.providerId] ??= []).push(p.rawId);
    const claims: Record<string, unknown> = {
      ...(u.customAttributes ? JSON.parse(u.customAttributes) : {}),
      ...extra,
      ...(u.displayName ? { name: u.displayName } : {}),
      ...(u.photoUrl ? { picture: u.photoUrl } : {}),
      ...(u.email ? { email: u.email, email_verified: !!u.emailVerified } : {}),
      ...(provider === "anonymous" ? { provider_id: "anonymous" } : {}),
      auth_time: iat,
      user_id: u.localId,
      firebase: { identities, sign_in_provider: provider },
      iat,
      exp: iat + 3600,
      aud: this.projectId,
      iss: `https://securetoken.google.com/${this.projectId}`,
      sub: u.localId,
    };
    const idToken = this.keys.sign(claims);
    const refreshToken = randomBytes(48).toString("base64url");
    this.refreshTokens.set(refreshToken, u.localId);
    this.store?.put("auth_refresh", refreshToken, u.localId);
    u.lastLoginAt = now();
    u.lastRefreshAt = new Date().toISOString();
    this.save(u);
    return { idToken, refreshToken, expiresIn: "3600" };
  }

  /** Verify an ID token issued by this server (or accept the emulator's "owner" credential). */
  verifyIdToken(token: string): Record<string, unknown> | null {
    const d = decodeJwt(token);
    if (!d) return null;
    if (d.header.alg === "RS256" && !this.keys.verify(token)) return null;
    if (d.header.alg !== "RS256" && d.header.alg !== "none") return null;
    if (typeof d.payload.exp === "number" && d.payload.exp < Date.now() / 1000) return null;
    const uid = String(d.payload.sub ?? d.payload.user_id ?? "");
    const u = this.users.get(uid);
    if (d.header.alg === "RS256" && (!u || u.disabled)) return null;
    return { ...d.payload, uid };
  }

  publicUser(u: User) {
    const { passwordHash, salt, ...rest } = u;
    return { ...rest, ...(passwordHash ? { passwordHash, salt } : {}) };
  }

  private userFromIdToken(idToken: unknown): User {
    if (typeof idToken !== "string") throw new AuthError("INVALID_ID_TOKEN");
    const claims = this.verifyIdToken(idToken);
    if (!claims) throw new AuthError("INVALID_ID_TOKEN");
    const u = this.users.get(String(claims.uid));
    if (!u) throw new AuthError("USER_NOT_FOUND");
    return u;
  }

  private validateEmail(email: unknown): string {
    if (typeof email !== "string" || !/^[^@\s]+@[^@\s]+$/.test(email)) throw new AuthError("INVALID_EMAIL");
    return email;
  }

  private validatePassword(password: unknown): string {
    if (typeof password !== "string" || password.length === 0) throw new AuthError("MISSING_PASSWORD");
    if (password.length < 6) throw new AuthError("WEAK_PASSWORD : Password should be at least 6 characters");
    return password;
  }

  // --- Identity Toolkit operations -------------------------------------------------------

  signUp(body: Record<string, any>, admin = false) {
    const created = now();
    const u: User = { localId: body.localId ?? this.newUid(), createdAt: created, lastLoginAt: created };
    if (body.email !== undefined || body.password !== undefined) {
      const email = this.validateEmail(body.email);
      if (this.byEmail(email)) throw new AuthError("EMAIL_EXISTS");
      const password = this.validatePassword(body.password);
      Object.assign(u, { email, emailVerified: !!body.emailVerified, ...this.hashPassword(password), passwordUpdatedAt: Date.now(), validSince: String(Math.floor(Date.now() / 1000)) });
      u.providerUserInfo = [{ providerId: "password", email, federatedId: email, rawId: email }];
    }
    if (body.displayName) u.displayName = body.displayName;
    if (body.photoUrl) u.photoUrl = body.photoUrl;
    if (body.disabled) u.disabled = true;
    if (admin && this.users.has(u.localId)) throw new AuthError("DUPLICATE_LOCAL_ID");
    this.save(u);
    if (admin) return { kind: "identitytoolkit#SignupNewUserResponse", localId: u.localId, email: u.email };
    const tokens = this.issueTokens(u);
    return { kind: "identitytoolkit#SignupNewUserResponse", localId: u.localId, ...(u.email ? { email: u.email } : {}), ...tokens };
  }

  signInWithPassword(body: Record<string, any>) {
    const email = this.validateEmail(body.email);
    if (typeof body.password !== "string" || !body.password) throw new AuthError("MISSING_PASSWORD");
    const u = this.byEmail(email);
    if (!u) throw new AuthError("EMAIL_NOT_FOUND");
    if (!this.checkPassword(u, body.password)) throw new AuthError("INVALID_PASSWORD");
    if (u.disabled) throw new AuthError("USER_DISABLED");
    const tokens = this.issueTokens(u, "password");
    return { kind: "identitytoolkit#VerifyPasswordResponse", registered: true, localId: u.localId, email: u.email, ...(u.displayName ? { displayName: u.displayName } : {}), ...tokens };
  }

  signInWithCustomToken(body: Record<string, any>) {
    const d = typeof body.token === "string" ? decodeJwt(body.token) : null;
    if (!d) throw new AuthError("INVALID_CUSTOM_TOKEN");
    const uid = String(d.payload.uid ?? "");
    if (!uid || uid.length > 128) throw new AuthError("INVALID_CUSTOM_TOKEN");
    let u = this.users.get(uid);
    const isNewUser = !u;
    if (!u) { u = { localId: uid, createdAt: now() }; this.save(u); }
    if (u.disabled) throw new AuthError("USER_DISABLED");
    const claims = (d.payload.claims as Record<string, unknown>) ?? {};
    const tokens = this.issueTokens(u, "custom", claims);
    return { kind: "identitytoolkit#VerifyCustomTokenResponse", isNewUser, ...tokens };
  }

  lookup(body: Record<string, any>, admin = false) {
    let users: User[] = [];
    if (body.idToken) users = [this.userFromIdToken(body.idToken)];
    else if (admin) {
      const ids: string[] = body.localId ?? [];
      const emails: string[] = body.email ?? [];
      users = [...this.users.values()].filter((u) => ids.includes(u.localId) || (u.email && emails.map((e) => e.toLowerCase()).includes(u.email.toLowerCase())));
    } else throw new AuthError("MISSING_ID_TOKEN");
    if (!users.length && !admin) throw new AuthError("USER_NOT_FOUND");
    return { kind: "identitytoolkit#GetAccountInfoResponse", ...(users.length ? { users: users.map((u) => this.publicUser(u)) } : {}) };
  }

  update(body: Record<string, any>, admin = false) {
    const u = body.idToken ? this.userFromIdToken(body.idToken) : admin && body.localId ? this.users.get(body.localId) : undefined;
    if (!u) throw new AuthError(body.idToken ? "INVALID_ID_TOKEN" : "USER_NOT_FOUND");
    if (body.email !== undefined) {
      const email = this.validateEmail(body.email);
      const other = this.byEmail(email);
      if (other && other.localId !== u.localId) throw new AuthError("EMAIL_EXISTS");
      u.email = email;
      u.emailVerified = false;
      u.providerUserInfo = (u.providerUserInfo ?? []).map((p) => (p.providerId === "password" ? { ...p, email, federatedId: email, rawId: email } : p));
    }
    if (body.password !== undefined) {
      const pw = this.validatePassword(body.password);
      Object.assign(u, this.hashPassword(pw), { passwordUpdatedAt: Date.now() });
      if (u.email && !u.providerUserInfo?.some((p) => p.providerId === "password")) (u.providerUserInfo ??= []).push({ providerId: "password", email: u.email, federatedId: u.email, rawId: u.email });
    }
    if (body.displayName !== undefined) u.displayName = body.displayName;
    if (body.photoUrl !== undefined) u.photoUrl = body.photoUrl;
    if (body.emailVerified !== undefined) u.emailVerified = !!body.emailVerified;
    if (body.disableUser !== undefined) u.disabled = !!body.disableUser;
    if (body.customAttributes !== undefined) u.customAttributes = body.customAttributes;
    for (const attr of body.deleteAttribute ?? []) {
      if (attr === "DISPLAY_NAME") delete u.displayName;
      if (attr === "PHOTO_URL") delete u.photoUrl;
    }
    for (const p of body.deleteProvider ?? []) u.providerUserInfo = (u.providerUserInfo ?? []).filter((x) => x.providerId !== p);
    this.save(u);
    const out: Record<string, unknown> = {
      kind: "identitytoolkit#SetAccountInfoResponse",
      localId: u.localId,
      ...(u.email ? { email: u.email, emailVerified: !!u.emailVerified } : {}),
      ...(u.displayName ? { displayName: u.displayName } : {}),
      ...(u.photoUrl ? { photoUrl: u.photoUrl } : {}),
      providerUserInfo: u.providerUserInfo ?? [],
      ...(u.passwordHash ? { passwordHash: u.passwordHash } : {}),
    };
    if (body.returnSecureToken || (!admin && (body.password !== undefined || body.email !== undefined))) Object.assign(out, this.issueTokens(u));
    return out;
  }

  delete(body: Record<string, any>, admin = false) {
    const u = body.idToken ? this.userFromIdToken(body.idToken) : admin && body.localId ? this.users.get(body.localId) : undefined;
    if (!u) throw new AuthError("USER_NOT_FOUND");
    this.users.delete(u.localId);
    this.store?.delete("auth", u.localId);
    for (const [t, uid] of this.refreshTokens) if (uid === u.localId) { this.refreshTokens.delete(t); this.store?.delete("auth_refresh", t); }
    return { kind: "identitytoolkit#DeleteAccountResponse" };
  }

  createAuthUri(body: Record<string, any>) {
    const email = this.validateEmail(body.identifier ?? body.email);
    const u = this.byEmail(email);
    const methods = u?.providerUserInfo?.map((p) => (p.providerId === "password" ? "password" : p.providerId)) ?? [];
    return { kind: "identitytoolkit#CreateAuthUriResponse", registered: !!u, sessionId: randomBytes(12).toString("hex"), ...(u ? { allProviders: methods, signinMethods: methods } : {}) };
  }

  sendOobCode(body: Record<string, any>) {
    const requestType = body.requestType;
    let email: string | undefined = body.email;
    let localId: string | undefined;
    if (requestType === "VERIFY_EMAIL" && body.idToken) { const u = this.userFromIdToken(body.idToken); email = u.email; localId = u.localId; }
    if (!email) throw new AuthError("MISSING_EMAIL");
    if (requestType === "PASSWORD_RESET" && !this.byEmail(email)) throw new AuthError("EMAIL_NOT_FOUND");
    const oobCode = randomBytes(24).toString("base64url");
    this.oobCodes.push({ oobCode, email, requestType, localId, createdAt: new Date().toISOString() });
    return { kind: "identitytoolkit#GetOobConfirmationCodeResponse", email };
  }

  resetPassword(body: Record<string, any>) {
    const code = this.oobCodes.find((c) => c.oobCode === body.oobCode);
    if (!code) throw new AuthError("INVALID_OOB_CODE");
    const u = this.byEmail(code.email);
    if (!u) throw new AuthError("EMAIL_NOT_FOUND");
    if (body.newPassword !== undefined) {
      Object.assign(u, this.hashPassword(this.validatePassword(body.newPassword)), { passwordUpdatedAt: Date.now() });
      this.save(u);
      this.oobCodes.splice(this.oobCodes.indexOf(code), 1);
    }
    return { kind: "identitytoolkit#ResetPasswordResponse", email: u.email, requestType: code.requestType };
  }

  refresh(body: Record<string, any>) {
    if (body.grant_type !== "refresh_token") throw new AuthError("INVALID_GRANT_TYPE");
    const uid = this.refreshTokens.get(body.refresh_token);
    if (!uid) throw new AuthError("INVALID_REFRESH_TOKEN");
    const u = this.users.get(uid);
    if (!u) throw new AuthError("USER_NOT_FOUND");
    if (u.disabled) throw new AuthError("USER_DISABLED");
    const { idToken, refreshToken, expiresIn } = this.issueTokens(u);
    return { access_token: idToken, expires_in: expiresIn, token_type: "Bearer", refresh_token: refreshToken, id_token: idToken, user_id: uid, project_id: this.projectId };
  }

  clear() {
    this.users.clear();
    this.refreshTokens.clear();
    this.store?.clear("auth");
    this.store?.clear("auth_refresh");
  }

  // --- HTTP routing ------------------------------------------------------------------------

  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const p = url.pathname;
    if (p === "/robot/v1/metadata/jwk/securetoken@system.gserviceaccount.com") { sendJson(res, 200, this.keys.jwks()); return true; }
    if (p.startsWith("/securetoken.googleapis.com/v1/token")) {
      const body = parseJsonOrForm(await readBody(req), req.headers["content-type"]);
      this.reply(res, () => this.refresh(body));
      return true;
    }
    const m = /^\/(?:www\.googleapis\.com\/)?identitytoolkit\.googleapis\.com\/v1\/(?:projects\/[^/]+\/)?(?:tenants\/[^/]+\/)?accounts(?::([A-Za-z]+))?$/.exec(p);
    if (!m) return false;
    const op = m[1] ?? "signUp";
    const body = parseJsonOrForm(await readBody(req), req.headers["content-type"]);
    const admin = bearer(req) === "owner";
    const ops: Record<string, () => unknown> = {
      signUp: () => this.signUp(body, admin && !body.returnSecureToken && p.includes("/projects/")),
      signInWithPassword: () => this.signInWithPassword(body),
      signInWithCustomToken: () => this.signInWithCustomToken(body),
      lookup: () => this.lookup(body, admin),
      update: () => this.update(body, admin),
      delete: () => this.delete(body, admin),
      createAuthUri: () => this.createAuthUri(body),
      sendOobCode: () => this.sendOobCode(body),
      resetPassword: () => this.resetPassword(body),
      batchGet: () => ({ kind: "identitytoolkit#DownloadAccountResponse", users: [...this.users.values()].slice(0, Number(url.searchParams.get("maxResults") ?? 1000)).map((u) => this.publicUser(u)) }),
    };
    if (!ops[op]) { sendJson(res, 400, { error: { code: 400, message: `UNSUPPORTED_OPERATION : ${op}`, errors: [{ message: op, reason: "invalid", domain: "global" }] } }); return true; }
    this.reply(res, ops[op]);
    return true;
  }

  private reply(res: ServerResponse, fn: () => unknown) {
    try {
      sendJson(res, 200, fn());
    } catch (e) {
      if (e instanceof AuthError) sendJson(res, e.status, { error: { code: e.status, message: e.reason, errors: [{ message: e.reason, reason: "invalid", domain: "global" }] } });
      else throw e;
    }
  }
}
