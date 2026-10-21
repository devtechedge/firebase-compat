# Compatibility matrix

Tested with `firebase` 13.1.0 (modular API). "Conformance" is the share of differential cases whose normalised result equals the Firebase Emulator's.

| Service | Feature | Status |
| --- | --- | --- |
| Auth | Email/password sign up and sign in | Yes |
| Auth | Anonymous sign in | Yes |
| Auth | Custom tokens | Yes (unsigned accepted, like the emulator) |
| Auth | Profile, email and password updates, delete | Yes |
| Auth | Token refresh, RS256 ID tokens, JWKS | Yes |
| Auth | Password reset and verify email OOB codes | Stored, no email sent |
| Auth | OAuth popup/redirect, phone, MFA, email link | No |
| Firestore | CRUD, merge, field transforms | Yes |
| Firestore | Queries, composite and/or, cursors, limitToLast, collection groups | Yes |
| Firestore | Aggregations count/sum/avg | Yes |
| Firestore | Batches, transactions with retry | Yes |
| Firestore | onSnapshot (docs and queries) over gRPC and WebChannel | Yes |
| Firestore | REST v1 | Yes |
| Firestore | Security rules | Subset (see limitations) |
| Firestore | Vector search, pipelines, bundles, multiple databases | No |
| Realtime Database | set/update/push/remove/get, listeners | Yes |
| Realtime Database | Queries, ordering, limits, ranges | Yes |
| Realtime Database | Transactions (hash compare), onDisconnect, server values | Yes |
| Realtime Database | Rules, long polling | No |
| Storage | uploadBytes, uploadString, resumable uploads | Yes |
| Storage | Metadata get/update, download URLs, getBytes | Yes |
| Storage | list/listAll with pagination, delete | Yes |
| Storage | Rules | No |

## Conformance results

| Suite | Cases | Matching emulator |
| --- | --- | --- |
| Auth (Node SDK) | 19 | 19 |
| Firestore (Node SDK, gRPC) | 40 | 40 |
| Realtime Database (Node SDK) | 20 | 20 |
| Storage (Node SDK) | 12 | 12 |
| **Total** | **91** | **91 (100%)** |
| Firestore + Auth in a real browser (WebChannel) | 23 steps | 23 (100%) |

Raw results: `packages/conformance/results/`. CI reruns the Node suite on every push.
