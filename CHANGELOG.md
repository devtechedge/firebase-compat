# Changelog

## 0.1.0 (2026-10-21)

First public release.

- Server speaking the Firebase Auth, Cloud Firestore (gRPC, WebChannel, REST), Realtime Database (v5 WebSocket) and Cloud Storage (v0) protocols on one port, persisted with `node:sqlite`.
- Firestore security rules subset.
- 91 differential conformance cases against the Firebase Emulator Suite, all matching; 23/23 browser WebChannel steps matching.
- Next.js dashboard and realtime chat demo using the unmodified `firebase` SDK.
- Evidence bundle with SHA-256 manifest and one SPEC.md per service.
- Docker image and docker-compose.
