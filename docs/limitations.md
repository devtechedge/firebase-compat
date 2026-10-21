# Limitations

firebase-compat targets local development, testing, demos and small self-hosted apps. It is not a production replacement for Firebase.

- **No hosted backend.** The website at firebase-compat.vercel.app is a static front end; run the server yourself (Docker or `npx`) and point the dashboard at it.
- **Security rules.** Firestore rules are a subset: `match` paths with wildcards and recursive wildcards, `allow` for read/write/get/list/create/update/delete, `request.auth`, `request.resource.data`, `resource.data`, comparisons, logical operators, `in`, `is`, ternaries, user functions with `let` bindings, common string, list and map methods, `get()` and `exists()`. `getAfter()`, `existsAfter()`, the `math`, `hashing`, `timestamp`, `duration` and `latlng` namespaces are not supported; unknown functions deny the request. Query rules are evaluated per returned document, so a query is filtered instead of rejected ("rules are not filters" is not enforced).
- **Realtime Database and Storage rules** are not enforced; everything is allowed.
- **Single process.** No clustering or replication; SQLite is the only store.
- **Indexes.** Queries scan; there are no missing index errors and large collections will be slow.
- **Auth providers.** Only email/password, anonymous and custom tokens.
- **Admin auth.** `Authorization: Bearer owner` bypasses Firestore rules and is admin for RTDB, matching the emulator convention, so do not expose the server to untrusted networks. `ADMIN_TOKEN` protects only the `/__admin` API used by the dashboard.
