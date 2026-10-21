# Firestore: observed wire behaviour

Status: implemented. Conformance: 40/40 Node SDK cases and 23/23 browser WebChannel steps match the Firestore Emulator.

## Evidence

| Artifact | SHA-256 (prefix) | REA evidence |
| --- | --- | --- |
| `evidence/raw/emulator-firestore.har` | `807c64e07911f335` | `har-firestore` |
| `evidence/raw/emulator-web-scenario.results.json` | `3dd068765292ecb9` | browser scenario results |
| `evidence/rea/har-firestore.json.gz` | `2764927233d684ba` | `har-firestore` |
| `evidence/rea/js-firestore.json.gz` | `b4cefb3006e89819` | `js-firestore` |
| `evidence/rea/js-firestore-common.json.gz` | `481c1d209fe52927` | `js-firestore-common` |

## Transports

The SDK picks a transport by platform. All three are served on the same port.

1. **gRPC (Node).** HTTP/2 to `google.firestore.v1.Firestore`. The server detects the HTTP/2 connection preface (`PRI * HTTP/2.0`) on the shared port and hands the socket to an internal grpc-js server. Methods used by the SDK: `Commit`, `BatchGetDocuments`, `RunQuery`, `RunAggregationQuery`, `BeginTransaction`, `Rollback`, `Write` (bidi), `Listen` (bidi). Protos are vendored from the public `googleapis` repository (Apache 2.0).
2. **WebChannel (browser).** `/google.firestore.v1.Firestore/{Listen,Write}/channel`.
   - Handshake `POST ?VER=8&RID=n&CVER=22&X-HTTP-Session-Id=gsessionid&...` with `count=1&ofs=0&req0___data__=...` returns a length-prefixed chunk: `len\n[[0,["c","<SID>","",8,12,30000]]]` plus header `X-HTTP-Session-Id`.
   - Backchannel `GET ?RID=rpc&SID=..&AID=..&TYPE=xmlhttp&CI=0` is a long-lived streaming response of `len\n[[id,[payload]]]` frames. A `["noop"]` frame keeps it alive.
   - Forward channel `POST ?SID=..&RID=n&AID=..` with `count=k&ofs=o&reqI___data__=<json>` returns `len\n[<backchannelPresent>,<lastArrayId>,<outstandingBytes>]`.
   - Payloads are the proto3 JSON mapping of `ListenRequest`/`WriteRequest` and responses.
3. **REST v1.** `/v1/projects/{p}/databases/(default)/documents/...` with `GET`, `PATCH` (`updateMask`, `currentDocument`), `DELETE`, `:commit`, `:batchGet`, `:runQuery`, `:runAggregationQuery`, `:beginTransaction`, `:rollback`. Used by Lite SDK and tools.

## Listen semantics

For each `addTarget` the server emits, in order: `targetChange{ADD}`, one `documentChange` per matching document, `targetChange{CURRENT, resumeToken}`, then a global `targetChange{NO_CHANGE, readTime}` (empty `targetIds`). The SDK raises a snapshot only after the global NO_CHANGE. Later writes produce `documentChange`/`documentDelete` followed by the same global NO_CHANGE. `removeTarget` yields `targetChange{REMOVE}`. Limit and limitToLast queries resend the target window.

## Write stream semantics

First message has no writes and returns `streamId` and `streamToken`. Each later message carries `writes` and the last `streamToken`; the response holds `writeResults` (one per write, `updateTime` set) and `commitTime`.

## Values and queries

Supported value types: null, boolean, integer (string encoded int64), double (including NaN and infinities), timestamp, string, bytes, reference, geoPoint, array, map. Cross-type ordering follows the documented Firestore order. Field transforms: `serverTimestamp`, `increment`, `arrayUnion`, `arrayRemove`, `maximum`, `minimum`.

Queries: field filters (`<`, `<=`, `==`, `!=`, `>`, `>=`, `array-contains`, `array-contains-any`, `in`, `not-in`), composite `and`/`or`, unary filters (`IS_NAN`, `IS_NULL` and negations), `orderBy` with implicit `__name__` tiebreak, cursors, `limit`, `limitToLast`, `offset`, collection group queries, aggregations `count`, `sum`, `avg`.

## Quirks

- Error statuses: `NOT_FOUND` for update on a missing doc, `ALREADY_EXISTS` for create, `FAILED_PRECONDITION` for a failed `currentDocument` precondition, `PERMISSION_DENIED` from rules, `INVALID_ARGUMENT` for malformed queries.
- `!=` and `not-in` exclude documents missing the field, and inequality fields gain an implicit `orderBy`.
- The emulator rejects `orderBy(documentId(), "desc")` without an index with `failed-precondition`; we accept it, so the conformance case uses ascending order.
- Transactions use optimistic concurrency: reads lock nothing; commit fails with `ABORTED` if a read document changed, and the SDK retries.

## Unknowns / not implemented

- Vector search, `findNearest`, pipelines, bundles, `Listen` resume from an old `resumeToken` across restarts (we resend a full snapshot), named databases other than `(default)`.
- Index management: every query is served by scanning; no composite index errors are raised.
