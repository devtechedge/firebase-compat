# Auth: observed wire behaviour

Status: implemented. Conformance: 19/19 cases match the Firebase Auth Emulator.

## Evidence

| Artifact | SHA-256 (prefix) | REA evidence id |
| --- | --- | --- |
| `evidence/raw/emulator-auth.har` | `e0aef8511c33fa65` | see `evidence/summary.json` (`har-auth`) |
| `evidence/rea/har-auth.json.gz` | `6d360063a70c0936` | `har-auth` |
| `evidence/rea/js-auth.json.gz` | `00d6a31667ca09cc` | `js-auth` (static analysis of the public `@firebase/auth` bundle) |

Full hashes live in `evidence/manifest.json`. All captures were taken against the local Auth Emulator with the unmodified `firebase` npm package.

## Endpoints the SDK calls

All are `POST` with a JSON body and `?key=<apiKey>`.

| Path | Used by |
| --- | --- |
| `/identitytoolkit.googleapis.com/v1/accounts:signUp` | `createUserWithEmailAndPassword`, `signInAnonymously` |
| `/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword` | `signInWithEmailAndPassword` |
| `/identitytoolkit.googleapis.com/v1/accounts:lookup` | `reload`, persistence restore |
| `/identitytoolkit.googleapis.com/v1/accounts:update` | `updateProfile`, `updateEmail`, `updatePassword` |
| `/identitytoolkit.googleapis.com/v1/accounts:delete` | `deleteUser` |
| `/identitytoolkit.googleapis.com/v1/accounts:sendOobCode` | `sendPasswordResetEmail` |
| `/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken` | `signInWithCustomToken` |
| `/securetoken.googleapis.com/v1/token` | token refresh (`grant_type=refresh_token`, form or JSON body) |

When `connectAuthEmulator(auth, "http://host:port")` is used, the SDK prefixes each path with the host instead of calling Google.

## Behaviour

- ID tokens are RS256 JWTs with `iss`/`aud` for the project, `auth_time`, `user_id`, `sub`, `firebase.sign_in_provider` and `firebase.identities`. Public keys are served as a JWKS at `/robot/v1/metadata/jwk/securetoken@system.gserviceaccount.com`, the same path Google uses, so Admin SDKs and JWT libraries can verify tokens.
- `expiresIn` is a string of seconds (`"3600"`).
- Errors are `{"error":{"code":400,"message":"EMAIL_EXISTS","errors":[...]}}`. The SDK maps `message` to `auth/...` codes, so the message string is the contract.
- Messages reproduced: `EMAIL_EXISTS`, `EMAIL_NOT_FOUND`, `INVALID_PASSWORD`, `WEAK_PASSWORD : Password should be at least 6 characters`, `INVALID_EMAIL`, `MISSING_EMAIL`, `MISSING_PASSWORD`, `USER_DISABLED`, `USER_NOT_FOUND`, `INVALID_ID_TOKEN`, `INVALID_REFRESH_TOKEN`, `INVALID_CUSTOM_TOKEN`, `INVALID_OOB_CODE`.

## Quirks

- The emulator returns `INVALID_LOGIN_CREDENTIALS` only when email enumeration protection is on; the default is the older split codes, which we follow.
- `accounts:lookup` returns `users` with `providerUserInfo`, `passwordUpdatedAt` (ms number) and `createdAt`/`lastLoginAt` as strings of ms.
- Custom tokens are accepted unsigned (alg `none`) like the emulator; production would require a service account signature.

## Unknowns / not implemented

- OAuth providers (`signInWithPopup`, `signInWithRedirect`), phone auth, MFA, email link sign-in, tenant auth.
- Real email sending: OOB codes are stored and visible in the dashboard only.
