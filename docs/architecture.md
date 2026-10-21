# Architecture

```
            unmodified firebase JS SDK (browser or Node)
   connectAuthEmulator / connectFirestoreEmulator / connectDatabaseEmulator / connectStorageEmulator
                                   |
                                   v
                     one TCP port (default 8787)
                                   |
             first bytes "PRI " ? --+-- otherwise HTTP/1.1
                   |                          |
          internal grpc-js server      path router (util/http.ts)
          (Firestore, Node SDK)          |  /identitytoolkit, /securetoken  -> auth/service.ts
                   |                     |  /google.firestore.v1.Firestore/* -> firestore/webchannel.ts
                   |                     |  /v1/projects/...                 -> firestore/rest.ts
                   |                     |  /.ws (upgrade)                   -> database/service.ts
                   |                     |  /v0/b/...                        -> storage/service.ts
                   |                     |  /__admin/...                     -> admin/api.ts (dashboard)
                   v                     v
             firestore/engine.ts  <- rules/evaluator.ts (Firestore rules subset)
                   |
               node:sqlite (util/db.ts): documents, users, rtdb tree, storage blobs
```

## Packages

| Path | Purpose |
| --- | --- |
| `packages/server` | The server. No runtime dependencies beyond `@grpc/grpc-js`, `@grpc/proto-loader` and `ws`. |
| `packages/conformance` | Differential test runner. Runs the same 91 SDK scenarios against the Firebase Emulator Suite and against this server, then compares normalised results. |
| `apps/web` | Next.js site: landing page, admin dashboard, realtime chat demo built on the unmodified `firebase` package, docs. |
| `tools/capture` | Recording proxy and scripts that captured the emulator traffic used as evidence. |
| `tools/evidence` | Builds `evidence/manifest.json` (SHA-256 of every artifact). |
| `specs/*` | One SPEC.md per service describing observed behaviour, quirks and unknowns. |

## Design choices

- **Single port.** The SDK lets each product point at its own host:port, but one port makes Docker and tunnels simple. HTTP/2 prior knowledge is detected from the connection preface and piped to gRPC.
- **One engine, three Firestore transports.** gRPC, WebChannel and REST all decode into the same request objects and call `firestore/engine.ts`; listeners are shared by `firestore/watch.ts`.
- **SQLite via `node:sqlite`.** Zero native build step, a single file for persistence, transactional writes.
- **Clean room.** Behaviour comes from captured traffic against the official emulator and the public, documented protocol buffers. No Google proprietary source was copied.
