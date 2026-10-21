# Cloud Storage: observed wire behaviour

Status: implemented. Conformance: 12/12 cases match the Storage Emulator.

## Evidence

| Artifact | SHA-256 (prefix) | REA evidence |
| --- | --- | --- |
| `evidence/raw/emulator-storage.har` | `674968f89ae474d8` | `har-storage` |
| `evidence/rea/har-storage.json.gz` | `0bb48f4468be6d5a` | `har-storage` |
| `evidence/rea/js-storage.json.gz` | `fd3b3bb7d6fef385` | `js-storage` |

## Endpoints (Firebase v0 API)

| Method and path | SDK call |
| --- | --- |
| `POST /v0/b/{bucket}/o?name=..` with `X-Goog-Upload-Protocol: multipart` | `uploadBytes`, `uploadString` |
| `POST /v0/b/{bucket}/o?name=..` with `X-Goog-Upload-Protocol: resumable`, `X-Goog-Upload-Command: start` | `uploadBytesResumable` start; response header `X-Goog-Upload-URL` |
| `POST <upload url>` with `X-Goog-Upload-Command: upload[, finalize]` and `X-Goog-Upload-Offset` | chunk upload |
| `POST <upload url>` with `X-Goog-Upload-Command: query` | resume status (`X-Goog-Upload-Size-Received`) |
| `GET /v0/b/{bucket}/o/{name}` | `getMetadata` |
| `GET /v0/b/{bucket}/o/{name}?alt=media` | `getBytes`, `getDownloadURL` target |
| `PATCH /v0/b/{bucket}/o/{name}` | `updateMetadata` |
| `DELETE /v0/b/{bucket}/o/{name}` | `deleteObject` |
| `GET /v0/b/{bucket}/o?prefix=..&delimiter=/&maxResults=..&pageToken=..` | `list`, `listAll` |

Object names are URL encoded (`a%2Fb.txt`).

## Metadata shape

`name`, `bucket`, `generation`, `metageneration`, `contentType`, `timeCreated`, `updated`, `storageClass`, `size` (string), `md5Hash` (base64), `contentEncoding`, `contentDisposition`, `crc32c`, `etag`, `downloadTokens`, `metadata` (custom). `getDownloadURL` uses the first download token: `/v0/b/{bucket}/o/{name}?alt=media&token=<uuid>`.

## Quirks

- Multipart bodies are `multipart/related` with a JSON metadata part first.
- Errors are `{"error":{"code":404,"message":"Not Found."}}`; the SDK maps status codes, not messages, to `storage/object-not-found`, `storage/unauthorized` and so on.
- `list` returns `prefixes` and `items` (`{name,bucket}`) and `nextPageToken`.

## Unknowns / not implemented

- Storage security rules (all access allowed), GCS JSON API (`/storage/v1`), signed URLs, object versioning.
