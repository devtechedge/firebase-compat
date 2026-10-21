# Conformance report

Same 91 cases, unmodified `firebase` JS SDK, run against the Firebase Emulator Suite and against firebase-compat. A case passes when both produce identical normalized results.

| Service | Passed | Total | Rate |
|---|---|---|---|
| auth | 19 | 19 | 100% |
| firestore | 40 | 40 | 100% |
| database | 20 | 20 | 100% |
| storage | 12 | 12 | 100% |
| overall | 91 | 91 | 100% |

## Cases

| Service | Case | Result |
|---|---|---|
| auth | sign up with email returns user email | pass |
| auth | new user is not anonymous and has 28 char uid | pass |
| auth | id token sign_in_provider is password | pass |
| auth | id token carries email and email_verified | pass |
| auth | duplicate email is rejected | pass |
| auth | weak password is rejected | pass |
| auth | invalid email is rejected | pass |
| auth | sign out clears current user | pass |
| auth | sign in with correct password | pass |
| auth | sign in with wrong password | pass |
| auth | sign in with unknown email | pass |
| auth | update profile display name | pass |
| auth | update password then sign in with it | pass |
| auth | force refresh returns a new token | pass |
| auth | fetch sign in methods | pass |
| auth | password reset email for existing user | pass |
| auth | delete user then sign in fails | pass |
| auth | anonymous sign in | pass |
| auth | custom token sign in with claims | pass |
| firestore | set and get round trip of rich types | pass |
| firestore | missing document does not exist | pass |
| firestore | merge set keeps other fields | pass |
| firestore | update nested field and delete field | pass |
| firestore | update missing document fails | pass |
| firestore | increment transform | pass |
| firestore | increment on double | pass |
| firestore | arrayUnion and arrayRemove | pass |
| firestore | serverTimestamp resolves to a Timestamp | pass |
| firestore | addDoc generates a 20 char id | pass |
| firestore | delete document | pass |
| firestore | query equality filter | pass |
| firestore | query range with implicit order | pass |
| firestore | query orderBy desc with limit | pass |
| firestore | query limitToLast | pass |
| firestore | query array-contains | pass |
| firestore | query array-contains-any | pass |
| firestore | query in | pass |
| firestore | query not-in excludes null | pass |
| firestore | query != excludes null | pass |
| firestore | query == null | pass |
| firestore | query OR composite | pass |
| firestore | query AND of equality and range | pass |
| firestore | query cursors startAt and endBefore | pass |
| firestore | query startAfter snapshot | pass |
| firestore | query orderBy documentId | pass |
| firestore | orderBy excludes docs missing the field | pass |
| firestore | collection group query | pass |
| firestore | subcollection query is scoped to parent | pass |
| firestore | count aggregation | pass |
| firestore | sum and average aggregation | pass |
| firestore | filtered count | pass |
| firestore | batch is atomic on failure | pass |
| firestore | batch commits multiple writes | pass |
| firestore | transaction read-modify-write | pass |
| firestore | concurrent transactions serialize | pass |
| firestore | transaction create on missing doc | pass |
| firestore | onSnapshot initial and incremental | pass |
| firestore | onSnapshot docChanges types | pass |
| firestore | query listener sees doc leave the result set | pass |
| database | set and get object | pass |
| database | get missing path is null | pass |
| database | update merges children | pass |
| database | multi-path update | pass |
| database | remove deletes value | pass |
| database | push keys are ordered | pass |
| database | server timestamp | pass |
| database | server increment | pass |
| database | transaction on number | pass |
| database | concurrent transactions | pass |
| database | transaction on object | pass |
| database | transaction abort | pass |
| database | orderByChild limitToFirst | pass |
| database | orderByChild startAt endAt | pass |
| database | orderByKey limitToLast | pass |
| database | orderByValue | pass |
| database | equalTo | pass |
| database | onValue receives updates | pass |
| database | child events | pass |
| database | arrays become objects with numeric keys | pass |
| storage | upload string returns size and type | pass |
| storage | metadata has md5 and generation | pass |
| storage | download url serves content | pass |
| storage | getBytes | pass |
| storage | custom metadata | pass |
| storage | update metadata | pass |
| storage | upload bytes default content type | pass |
| storage | resumable upload of 600 KiB | pass |
| storage | listAll with prefixes | pass |
| storage | list with maxResults pages | pass |
| storage | delete then metadata fails | pass |
| storage | delete missing object fails | pass |
