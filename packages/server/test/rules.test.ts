import { describe, expect, it } from "vitest";
import { RulesEngine, RulesSyntaxError, parseRules } from "../src/rules/index.js";
import { fromPlain } from "../src/firestore/values.js";

const src = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function signedIn() { return request.auth != null; }
    function isOwner(uid) { return signedIn() && request.auth.uid == uid; }
    match /public/{doc} { allow read; allow write: if false; }
    match /users/{uid} {
      allow read, write: if isOwner(uid);
    }
    match /posts/{post} {
      allow read: if resource.data.published == true || isOwner(resource.data.author);
      allow create: if isOwner(request.resource.data.author) && request.resource.data.title is string && request.resource.data.title.size() <= 20;
      allow update: if isOwner(resource.data.author) && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['title', 'published']);
      allow delete: if exists(/databases/$(database)/documents/admins/$(request.auth.uid));
    }
    match /rooms/{room}/{rest=**} { allow read: if 'member' in request.auth.token.roles; }
  }
}`;
const rules = new RulesEngine(src);
const doc = (path: string, data: Record<string, unknown>) => ({ id: path.split("/").pop()!, name: `projects/p/databases/(default)/documents/${path}`, data: fromPlain(data).mapValue!.fields! });
const alice = { uid: "alice", sub: "alice", roles: ["member"] };

describe("security rules", () => {
  it("parses the ruleset", () => {
    const r = parseRules(src);
    expect(r.service).toBe("cloud.firestore");
    expect(r.matches[0].children).toHaveLength(4);
  });
  it("rejects invalid syntax", () => {
    expect(() => parseRules("service cloud.firestore { match /a { allow read: if ; } }")).toThrow(RulesSyntaxError);
  });
  it("denies by default", () => {
    expect(rules.allows({ method: "get", path: "secret/x", auth: alice })).toBe(false);
  });
  it("allows unconditional reads and denies false writes", () => {
    expect(rules.allows({ method: "get", path: "public/x", auth: null })).toBe(true);
    expect(rules.allows({ method: "create", path: "public/x", auth: alice })).toBe(false);
  });
  it("binds wildcards and calls functions", () => {
    expect(rules.allows({ method: "update", path: "users/alice", auth: alice })).toBe(true);
    expect(rules.allows({ method: "update", path: "users/bob", auth: alice })).toBe(false);
    expect(rules.allows({ method: "get", path: "users/alice", auth: null })).toBe(false);
  });
  it("reads resource.data and request.resource.data", () => {
    expect(rules.allows({ method: "get", path: "posts/1", auth: null, resource: doc("posts/1", { published: true, author: "bob" }) })).toBe(true);
    expect(rules.allows({ method: "get", path: "posts/1", auth: null, resource: doc("posts/1", { published: false, author: "bob" }) })).toBe(false);
    expect(rules.allows({ method: "create", path: "posts/2", auth: alice, incoming: doc("posts/2", { author: "alice", title: "hello" }) })).toBe(true);
    expect(rules.allows({ method: "create", path: "posts/2", auth: alice, incoming: doc("posts/2", { author: "alice", title: "x".repeat(30) }) })).toBe(false);
    expect(rules.allows({ method: "create", path: "posts/2", auth: alice, incoming: doc("posts/2", { author: "alice", title: 5 }) })).toBe(false);
  });
  it("supports map diff helpers", () => {
    const before = doc("posts/3", { author: "alice", title: "a", published: false });
    expect(rules.allows({ method: "update", path: "posts/3", auth: alice, resource: before, incoming: doc("posts/3", { author: "alice", title: "b", published: true }) })).toBe(true);
    expect(rules.allows({ method: "update", path: "posts/3", auth: alice, resource: before, incoming: doc("posts/3", { author: "mallory", title: "a", published: false }) })).toBe(false);
  });
  it("supports exists() with path interpolation", () => {
    const getDocument = (p: string) => (p === "admins/alice" ? {} : undefined);
    expect(rules.allows({ method: "delete", path: "posts/1", auth: alice, getDocument })).toBe(true);
    expect(rules.allows({ method: "delete", path: "posts/1", auth: { uid: "bob" }, getDocument })).toBe(false);
  });
  it("matches recursive wildcards and the in operator", () => {
    expect(rules.allows({ method: "list", path: "rooms/r1/messages/m1", auth: alice })).toBe(true);
    expect(rules.allows({ method: "get", path: "rooms/r1/messages/m1", auth: { uid: "x", roles: [] } })).toBe(false);
  });
  it("treats evaluation errors as denial", () => {
    expect(rules.allows({ method: "get", path: "posts/9", auth: null, resource: null })).toBe(false);
  });
});
